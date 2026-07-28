const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { File, Picture, PictureType, ByteVector } = require('node-taglib-sharp');
const chokidar = require('chokidar');

const app = express();

// ---------------------------------------------------------------------------
// 密码保护:设置了 ACCESS_PASSWORD 环境变量才会启用,不设置就跟以前一样不需要密码
// 用的是浏览器原生的 HTTP Basic Auth 弹窗,不用户名也行,只校验密码
// ---------------------------------------------------------------------------
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

function requireAuth(req, res, next) {
  if (!ACCESS_PASSWORD) return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (pass === ACCESS_PASSWORD) return next();
    } catch (e) {
      // 解析失败就走下面的 401
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="netease-navidrome-sync"');
  res.status(401).send('需要密码才能访问,用户名随便填,密码填正确的访问密码');
}

app.use(requireAuth);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;

// 歌手头像统一存放目录,需要和 Navidrome 的 ArtistImageFolder 挂载到同一个宿主机目录
const ARTIST_IMAGE_DIR = process.env.ARTIST_IMAGE_DIR || path.join(__dirname, 'artist-images');
app.use('/artist-image-files', express.static(ARTIST_IMAGE_DIR));

// 音乐库在本容器里的挂载路径,需要和 Navidrome 挂载的是同一个宿主机目录
// Subsonic 接口返回的 song.path 是相对这个根目录的相对路径
const MUSIC_LIBRARY_DIR = process.env.MUSIC_LIBRARY_DIR || '/music';

// Meting-API 地址,用来补充 QQ音乐(tencent)、酷我音乐(kuwo)等数据源
const DEFAULT_METING_BASE = process.env.DEFAULT_METING_BASE || '';

// ---------------------------------------------------------------------------
// 钉钉机器人通知
// ---------------------------------------------------------------------------

// 完整的 webhook 地址,形如 https://oapi.dingtalk.com/robot/send?access_token=xxxxxx
const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK || '';
// 如果机器人安全设置选的是"加签",这里填那个密钥(以 SEC 开头的那串);
// 用的是"自定义关键词"或者"IP 段"方式的话留空即可
const DINGTALK_SECRET = process.env.DINGTALK_SECRET || '';

// 各个环节是否要发通知,默认都开,不想要哪个就在 docker-compose 里设成 false
const NOTIFY_PLAYLIST_SYNC = process.env.NOTIFY_PLAYLIST_SYNC !== 'false';
const NOTIFY_SCRAPE_DONE = process.env.NOTIFY_SCRAPE_DONE !== 'false';
const NOTIFY_WATCH_NEW_FILE = process.env.NOTIFY_WATCH_NEW_FILE !== 'false';

function buildDingtalkUrl() {
  if (!DINGTALK_SECRET) return DINGTALK_WEBHOOK;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${DINGTALK_SECRET}`;
  const sign = crypto.createHmac('sha256', DINGTALK_SECRET).update(stringToSign, 'utf8').digest('base64');
  const separator = DINGTALK_WEBHOOK.includes('?') ? '&' : '?';
  return `${DINGTALK_WEBHOOK}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function sendDingtalkNotification(title, content) {
  if (!DINGTALK_WEBHOOK) return;
  try {
    const url = buildDingtalkUrl();
    await axios.post(url, {
      msgtype: 'markdown',
      markdown: {
        title,
        text: `### ${title}\n\n${content}`
      }
    }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('钉钉通知发送失败:', e.message);
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function randomSalt(len = 8) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function subsonicToken(password, salt) {
  return crypto.createHash('md5').update(password + salt, 'utf8').digest('hex');
}

function buildSubsonicAuthParams(username, password) {
  const salt = randomSalt();
  const token = subsonicToken(password, salt);
  return {
    u: username,
    t: token,
    s: salt,
    v: '1.16.1',
    c: 'netease-navidrome-sync',
    f: 'json'
  };
}

// 归一化字符串:去掉括号备注、标点、空格,转小写,方便比较
function normalize(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\(（].*?[\)）]/g, '')
    .replace(/[\[【].*?[\]】]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
    .trim();
}

// Levenshtein 编辑距离
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  if (!a && !b) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - dist / maxLen;
}

// ---------------------------------------------------------------------------
// 网易云歌单列表(基于 UID,不需要登录)
// ---------------------------------------------------------------------------

function neteaseUrl(base, pathAndQuery) {
  return `${base.replace(/\/$/, '')}${pathAndQuery}`;
}

// cookie 为可选的高级参数,只有需要同步"隐私歌单"时才会用到
// 公开歌单(默认状态)不需要 cookie 就能拿到
async function neteaseGetUserPlaylists(base, uid, cookie) {
  let url = `/user/playlist?uid=${uid}&limit=1000&timestamp=${Date.now()}`;
  if (cookie) url += `&cookie=${encodeURIComponent(cookie)}`;

  const res = await axios.get(neteaseUrl(base, url), { timeout: 15000 });
  const list = (res.data && res.data.playlist) || [];
  return list.map(p => ({
    id: p.id,
    name: p.name,
    trackCount: p.trackCount,
    coverImgUrl: p.coverImgUrl,
    mine: p.creator && String(p.creator.userId) === String(uid)
  }));
}

// ---------------------------------------------------------------------------
// 网易云歌单获取(单个歌单的曲目详情)
// ---------------------------------------------------------------------------

async function fetchNeteasePlaylist(neteaseBase, playlistId, cookie) {
  const base = neteaseBase.replace(/\/$/, '');
  const detailUrl = `${base}/playlist/detail`;
  const params = { id: playlistId, t: Date.now() };
  if (cookie) params.cookie = cookie;

  const detailRes = await axios.get(detailUrl, { params, timeout: 15000 });
  const playlist = detailRes.data && detailRes.data.playlist;
  if (!playlist) {
    throw new Error('获取歌单详情失败,请检查歌单 ID 或 API 代理地址是否正确');
  }

  const playlistName = playlist.name || `歌单_${playlistId}`;
  const trackIds = (playlist.trackIds || []).map(t => t.id);

  if (trackIds.length === 0) {
    return { playlistName, tracks: [] };
  }

  // 分批获取歌曲详情,每批最多 200 首
  const batches = [];
  for (let i = 0; i < trackIds.length; i += 200) {
    batches.push(trackIds.slice(i, i + 200));
  }

  const songDetailUrl = `${base}/song/detail`;
  const allTracks = [];
  for (const batch of batches) {
    const res = await axios.get(songDetailUrl, {
      params: { ids: batch.join(','), t: Date.now(), ...(cookie ? { cookie } : {}) },
      timeout: 15000
    });
    const songs = (res.data && res.data.songs) || [];
    for (const s of songs) {
      allTracks.push({
        id: s.id,
        name: s.name,
        artists: (s.ar || s.artists || []).map(a => a.name),
        album: (s.al && s.al.name) || (s.album && s.album.name) || '',
        duration: s.dt || s.duration || 0
      });
    }
  }

  return { playlistName, tracks: allTracks };
}

// ---------------------------------------------------------------------------
// Navidrome (Subsonic) 交互
// ---------------------------------------------------------------------------

async function subsonicSearch(navidromeUrl, username, password, query) {
  const url = `${navidromeUrl.replace(/\/$/, '')}/rest/search3`;
  const params = {
    ...buildSubsonicAuthParams(username, password),
    query,
    songCount: 20,
    artistCount: 0,
    albumCount: 0
  };
  const res = await axios.get(url, { params, timeout: 15000 });
  const result = res.data && res.data['subsonic-response'];
  if (!result || result.status !== 'ok') {
    const err = (result && result.error && result.error.message) || '未知错误';
    throw new Error(`Navidrome 搜索失败: ${err}`);
  }
  const songs = (result.searchResult3 && result.searchResult3.song) || [];
  return songs;
}

async function subsonicCreatePlaylist(navidromeUrl, username, password, name, songIds) {
  const url = `${navidromeUrl.replace(/\/$/, '')}/rest/createPlaylist`;
  const authParams = buildSubsonicAuthParams(username, password);
  const body = new URLSearchParams();
  Object.entries(authParams).forEach(([k, v]) => body.append(k, v));
  body.append('name', name);
  songIds.forEach(id => body.append('songId', id));

  // 用 POST 请求体传参而不是拼在 URL 上,避免歌单较大(几百上千首)时
  // URL 超长触发 "414 Request-URI Too Long"
  const res = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000
  });
  const result = res.data && res.data['subsonic-response'];
  if (!result || result.status !== 'ok') {
    const err = (result && result.error && result.error.message) || '未知错误';
    throw new Error(`创建播放列表失败: ${err}`);
  }
  return result.playlist;
}

async function subsonicGetArtists(navidromeUrl, username, password) {
  const url = `${navidromeUrl.replace(/\/$/, '')}/rest/getArtists`;
  const params = buildSubsonicAuthParams(username, password);
  const res = await axios.get(url, { params, timeout: 20000 });
  const result = res.data && res.data['subsonic-response'];
  if (!result || result.status !== 'ok') {
    const err = (result && result.error && result.error.message) || '未知错误';
    throw new Error(`获取歌手列表失败: ${err}`);
  }
  const indexList = (result.artists && result.artists.index) || [];
  const artists = [];
  for (const idx of indexList) {
    for (const a of idx.artist || []) {
      artists.push({ id: a.id, name: a.name, albumCount: a.albumCount || 0 });
    }
  }
  return artists;
}


// ---------------------------------------------------------------------------
// 网易云歌手搜索(用来找歌手头像)
// ---------------------------------------------------------------------------

async function neteaseArtistSearch(base, name) {
  const url = neteaseUrl(base, `/search?keywords=${encodeURIComponent(name)}&type=100&limit=8&timestamp=${Date.now()}`);
  const res = await axios.get(url, { timeout: 15000 });
  const list = (res.data && res.data.result && res.data.result.artists) || [];
  return list.map(a => ({
    id: a.id,
    name: a.name,
    imageUrl: a.img1v1Url || a.picUrl || ''
  }));
}

// ---------------------------------------------------------------------------
// 网易云歌曲搜索 / 歌词 / 封面(用于封面 + 歌词刮削)
// ---------------------------------------------------------------------------

async function neteaseSongSearch(base, keyword, limit = 8) {
  const url = neteaseUrl(base, `/search?keywords=${encodeURIComponent(keyword)}&type=1&limit=${limit}&timestamp=${Date.now()}`);
  const res = await axios.get(url, { timeout: 15000 });
  const list = (res.data && res.data.result && res.data.result.songs) || [];
  return list.map(s => ({
    source: 'netease',
    id: s.id,
    name: s.name,
    artists: (s.artists || s.ar || []).map(a => a.name),
    album: (s.album && s.album.name) || (s.al && s.al.name) || '',
    picUrl: (s.album && s.album.picUrl) || (s.al && s.al.picUrl) || ''
  }));
}

// 搜索结果里经常没带封面图,需要再查一次歌曲详情拿 al.picUrl
async function neteaseSongDetail(base, songId) {
  const url = neteaseUrl(base, `/song/detail?ids=${songId}&timestamp=${Date.now()}`);
  const res = await axios.get(url, { timeout: 15000 });
  const song = (res.data && res.data.songs && res.data.songs[0]) || null;
  if (!song) return null;
  return {
    id: song.id,
    name: song.name,
    artists: (song.ar || []).map(a => a.name),
    album: (song.al && song.al.name) || '',
    picUrl: (song.al && song.al.picUrl) || ''
  };
}

async function neteaseGetLyric(base, songId) {
  const url = neteaseUrl(base, `/lyric?id=${songId}&timestamp=${Date.now()}`);
  const res = await axios.get(url, { timeout: 15000 });
  const lrc = res.data && res.data.lrc && res.data.lrc.lyric;
  return lrc || null;
}

// ---------------------------------------------------------------------------
// Meting-API:统一接口,这里用来补充 QQ 音乐(tencent)、酷我音乐(kuwo)
// search/song 等类型不需要鉴权,返回的 pic/lrc 字段已经是带签名的完整 URL,直接请求即可
// ---------------------------------------------------------------------------

const SOURCE_LABELS = { netease: '网易云', tencent: 'QQ音乐', kuwo: '酷我音乐' };

async function meetingSearch(meetingBase, server, keyword) {
  const url = `${meetingBase.replace(/\/$/, '')}/api`;
  const res = await axios.get(url, {
    params: { server, type: 'search', id: keyword },
    timeout: 15000
  });
  const list = Array.isArray(res.data) ? res.data : [];
  return list.map(item => ({
    source: server,
    name: item.title,
    artists: String(item.author || '').split('/').map(a => a.trim()).filter(Boolean),
    picUrl: item.pic || '',
    lrcUrl: item.lrc || ''
  }));
}

async function meetingGetLyric(lrcUrl) {
  const res = await axios.get(lrcUrl, { responseType: 'text', timeout: 15000 });
  return res.data || null;
}

// ---------------------------------------------------------------------------
// 下载并保存歌手头像到 ArtistImageFolder 对应目录
// ---------------------------------------------------------------------------

function sanitizeArtistFilename(name) {
  // 保留原始歌手名(Navidrome 按名称精确匹配),只替换文件系统不允许的字符
  return String(name).replace(/[/\\:*?"<>|]/g, '_').trim();
}

async function saveArtistImage(artistName, imageUrl) {
  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      // 部分图床(比如百度/必应搜出来的直链)会做防盗链校验,带上常见浏览器 UA 提高成功率
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });
  await fsPromises.mkdir(ARTIST_IMAGE_DIR, { recursive: true });
  const fileName = `${sanitizeArtistFilename(artistName)}.jpg`;
  const filePath = path.join(ARTIST_IMAGE_DIR, fileName);
  await fsPromises.writeFile(filePath, res.data);
  return fileName;
}

// ---------------------------------------------------------------------------
// 匹配逻辑
// ---------------------------------------------------------------------------

function findBestMatch(neteaseTrack, candidates) {
  const targetTitle = normalize(neteaseTrack.name);
  const targetArtist = normalize((neteaseTrack.artists && neteaseTrack.artists[0]) || '');

  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const cTitle = normalize(c.title);
    const cArtist = normalize(c.artist);

    // 精确匹配
    if (cTitle === targetTitle && (targetArtist === '' || cArtist === targetArtist)) {
      return { song: c, score: 1, method: 'exact' };
    }

    const titleScore = similarity(cTitle, targetTitle);
    const artistScore = targetArtist ? similarity(cArtist, targetArtist) : 1;
    const combined = titleScore * 0.7 + artistScore * 0.3;

    if (combined > bestScore) {
      bestScore = combined;
      best = c;
    }
  }

  if (best && bestScore >= 0.8) {
    return { song: best, score: bestScore, method: 'fuzzy' };
  }
  return null;
}

// 本地歌曲(localSong: {title, artist}) 与网易云歌曲搜索候选做匹配
function findBestSongMatch(localSong, candidates) {
  const targetTitle = normalize(localSong.title);
  const targetArtist = normalize(localSong.artist || '');

  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const cTitle = normalize(c.name);
    const cArtist = normalize((c.artists && c.artists[0]) || '');

    if (cTitle === targetTitle && (targetArtist === '' || cArtist === targetArtist)) {
      return { candidate: c, score: 1, method: 'exact' };
    }

    const titleScore = similarity(cTitle, targetTitle);
    const artistScore = targetArtist ? similarity(cArtist, targetArtist) : 1;
    const combined = titleScore * 0.7 + artistScore * 0.3;

    if (combined > bestScore) {
      bestScore = combined;
      best = c;
    }
  }

  if (best && bestScore >= 0.8) {
    return { candidate: best, score: bestScore, method: 'fuzzy' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文件系统扫描:递归找音频文件 + 读取文件自带的标题/歌手标签
// 完全不依赖 Navidrome,只认 MUSIC_LIBRARY_DIR 这个挂载目录本身
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.oga', '.wma', '.ape', '.wv', '.aac']);

// 防止 relPath 里带 ../ 之类的路径逃逸出 MUSIC_LIBRARY_DIR(这个工具现在有文件写权限,必须做这个校验)
function resolveSafeLibraryPath(relPath) {
  const root = path.resolve(MUSIC_LIBRARY_DIR);
  const target = path.resolve(path.join(root, relPath || ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('目录不在音乐库挂载范围内');
  }
  return target;
}

async function listAudioFilesRecursive(absDir) {
  let results = [];
  let entries;
  try {
    entries = await fsPromises.readdir(absDir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await listAudioFilesRecursive(full);
      results = results.concat(sub);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

// 文件名兜底解析,常见命名习惯 "歌手 - 歌名.mp3"
function guessFromFilename(absPath) {
  const base = path.basename(absPath, path.extname(absPath));
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: base.trim() };
}

function readSongTags(absPath) {
  try {
    const file = File.createFromPath(absPath);
    const title = file.tag.title || '';
    const artist = file.tag.firstPerformer || (file.tag.performers && file.tag.performers[0]) || '';
    const album = file.tag.album || '';
    file.dispose();

    if (title) return { title, artist, album };

    // 标签里没有标题信息,退回按文件名猜
    const guessed = guessFromFilename(absPath);
    return { title: guessed.title, artist: artist || guessed.artist, album };
  } catch (e) {
    const guessed = guessFromFilename(absPath);
    return { title: guessed.title, artist: guessed.artist, album: '', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 文件操作:嵌入封面 / 写入歌词文件
// ---------------------------------------------------------------------------

async function embedCoverArt(absoluteFilePath, imageBuffer, mimeType) {
  const file = File.createFromPath(absoluteFilePath);
  try {
    const byteVector = ByteVector.fromByteArray(imageBuffer);
    const picture = Picture.fromFullData(byteVector, PictureType.FrontCover, mimeType || 'image/jpeg', 'cover');
    file.tag.pictures = [picture];
    file.save();
  } finally {
    file.dispose();
  }
}

async function writeLyricFile(absoluteFilePath, lyricText) {
  const dir = path.dirname(absoluteFilePath);
  const baseName = path.basename(absoluteFilePath, path.extname(absoluteFilePath));
  const lrcPath = path.join(dir, `${baseName}.lrc`);
  await fsPromises.writeFile(lrcPath, lyricText, 'utf8');
  return lrcPath;
}


// ---------------------------------------------------------------------------

async function syncOnePlaylist({ neteaseBase, playlistId, cookie, navidromeUrl, navidromeUsername, navidromePassword, dryRun }) {
  const { playlistName, tracks } = await fetchNeteasePlaylist(neteaseBase, playlistId, cookie);

  if (tracks.length === 0) {
    return { playlistId, playlistName, total: 0, matchedCount: 0, results: [] };
  }

  const results = [];
  const matchedIds = [];

  for (const track of tracks) {
    let candidates = [];
    try {
      candidates = await subsonicSearch(navidromeUrl, navidromeUsername, navidromePassword, track.name);
    } catch (e) {
      console.error(`[sync] 搜索失败 "${track.name}": ${e.message}`);
      results.push({ netease: track, status: 'error', message: e.message });
      continue;
    }

    const match = findBestMatch(track, candidates);
    if (match) {
      matchedIds.push(match.song.id);
      results.push({
        netease: track,
        status: 'matched',
        method: match.method,
        score: Number(match.score.toFixed(3)),
        matchedSong: {
          id: match.song.id,
          title: match.song.title,
          artist: match.song.artist,
          album: match.song.album
        }
      });
    } else {
      results.push({ netease: track, status: 'unmatched' });
    }
  }

  let createdPlaylist = null;
  let createError = null;
  if (!dryRun && matchedIds.length > 0) {
    try {
      createdPlaylist = await subsonicCreatePlaylist(
        navidromeUrl, navidromeUsername, navidromePassword, playlistName, matchedIds
      );
    } catch (e) {
      createError = e.message;
    }
  }

  return {
    playlistId,
    playlistName,
    total: tracks.length,
    matchedCount: matchedIds.length,
    dryRun: !!dryRun,
    createdPlaylist,
    createError,
    results
  };
}

// ---------------------------------------------------------------------------
// API 路由:歌单列表(基于 UID,不需要登录)
// ---------------------------------------------------------------------------

app.get('/api/netease/playlists', async (req, res) => {
  try {
    const list = await neteaseGetUserPlaylists(req.query.neteaseBase, req.query.uid, req.query.cookie);
    res.json({ playlists: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// API 路由:批量同步选中的歌单
// ---------------------------------------------------------------------------

app.post('/api/sync', async (req, res) => {
  try {
    const {
      neteaseBase,
      cookie,
      playlistIds,
      navidromeUrl,
      navidromeUsername,
      navidromePassword,
      dryRun
    } = req.body;

    if (!neteaseBase || !Array.isArray(playlistIds) || playlistIds.length === 0 ||
        !navidromeUrl || !navidromeUsername || !navidromePassword) {
      return res.status(400).json({ error: '缺少必填参数或未选择歌单' });
    }

    const playlistResults = [];
    for (const playlistId of playlistIds) {
      try {
        const result = await syncOnePlaylist({
          neteaseBase, playlistId, cookie, navidromeUrl, navidromeUsername, navidromePassword, dryRun
        });
        playlistResults.push(result);
      } catch (e) {
        playlistResults.push({ playlistId, error: e.message });
      }
    }

    res.json({ playlists: playlistResults });

    if (NOTIFY_PLAYLIST_SYNC && !dryRun) {
      const lines = playlistResults.map(r => {
        if (r.error) return `- ${r.playlistId}:出错 - ${r.error}`;
        return `- ${r.playlistName}:共 ${r.total} 首,匹配 ${r.matchedCount} 首`;
      });
      sendDingtalkNotification('🎵 歌单同步完成', lines.join('\n'));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '同步失败' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    defaultNeteaseBase: process.env.DEFAULT_NETEASE_BASE || '',
    defaultMeetingBase: DEFAULT_METING_BASE
  });
});

// ---------------------------------------------------------------------------
// API 路由:歌手头像
// ---------------------------------------------------------------------------

app.get('/api/navidrome/artists', async (req, res) => {
  try {
    const { navidromeUrl, navidromeUsername, navidromePassword } = req.query;
    if (!navidromeUrl || !navidromeUsername || !navidromePassword) {
      return res.status(400).json({ error: '缺少 Navidrome 配置' });
    }
    const artists = await subsonicGetArtists(navidromeUrl, navidromeUsername, navidromePassword);
    res.json({ artists });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/netease/artist-search', async (req, res) => {
  try {
    const { neteaseBase, name } = req.query;
    if (!neteaseBase || !name) {
      return res.status(400).json({ error: '缺少参数' });
    }
    const artists = await neteaseArtistSearch(neteaseBase, name);
    res.json({ artists });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/artist-image/save', async (req, res) => {
  try {
    const { artistName, imageUrl } = req.body;
    if (!artistName || !imageUrl) {
      return res.status(400).json({ error: '缺少参数' });
    }
    const fileName = await saveArtistImage(artistName, imageUrl);
    res.json({ ok: true, fileName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artist-image/list', async (req, res) => {
  try {
    await fsPromises.mkdir(ARTIST_IMAGE_DIR, { recursive: true });
    const files = await fsPromises.readdir(ARTIST_IMAGE_DIR);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 封面 / 歌词刮削:单曲处理逻辑
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function songAlreadyHasCover(absPath) {
  try {
    const file = File.createFromPath(absPath);
    const has = !!(file.tag.pictures && file.tag.pictures.length > 0);
    file.dispose();
    return has;
  } catch (e) {
    return false;
  }
}

async function lrcFileExists(absPath) {
  const dir = path.dirname(absPath);
  const baseName = path.basename(absPath, path.extname(absPath));
  const lrcPath = path.join(dir, `${baseName}.lrc`);
  try {
    await fsPromises.access(lrcPath);
    return true;
  } catch (e) {
    return false;
  }
}

// 处理单首歌:自动搜索匹配、判断是否需要跳过/需要人工确认、下载封面并嵌入、下载歌词并写文件
async function fetchCoverUrlForCandidate(candidate, neteaseBase) {
  if (candidate.source === 'netease') {
    if (candidate.picUrl) return candidate.picUrl;
    const detail = await neteaseSongDetail(neteaseBase, candidate.id);
    return detail && detail.picUrl;
  }
  // tencent / kuwo 来自 Meting-API,搜索结果里已经带着签名好的封面直链
  return candidate.picUrl || null;
}

async function fetchLyricForCandidate(candidate, neteaseBase) {
  if (candidate.source === 'netease') {
    return await neteaseGetLyric(neteaseBase, candidate.id);
  }
  if (!candidate.lrcUrl) return null;
  return await meetingGetLyric(candidate.lrcUrl);
}

async function scrapeSong({ neteaseBase, meetingBase, song, options }) {
  // song.path 现在就是扫描到的真实绝对路径,不用再拼接
  const absPath = song.path;

  try {
    await fsPromises.access(absPath, fs.constants.W_OK);
  } catch (e) {
    return { status: 'error', message: `文件不存在或不可写: ${absPath}` };
  }

  const needCover = options.cover && (options.overwrite || !(await songAlreadyHasCover(absPath)));
  const needLyric = options.lyrics && (options.overwrite || !(await lrcFileExists(absPath)));

  if (!needCover && !needLyric) {
    return { status: 'skipped' };
  }

  const keyword = `${song.title} ${song.artist}`;
  const target = { title: song.title, artist: song.artist };

  // 依次尝试网易云 -> QQ音乐 -> 酷我音乐,只要有一个精确匹配就用,不用全部都试
  const sourceAttempts = [
    { server: 'netease', search: () => neteaseSongSearch(neteaseBase, keyword, 8) }
  ];
  if (meetingBase) {
    sourceAttempts.push({ server: 'tencent', search: () => meetingSearch(meetingBase, 'tencent', keyword) });
    sourceAttempts.push({ server: 'kuwo', search: () => meetingSearch(meetingBase, 'kuwo', keyword) });
  }

  let candidate = null;
  const triedSources = [];
  let bestFallback = null; // 记录各源里分数最高的模糊匹配,方便给人工确认提示用

  for (const attempt of sourceAttempts) {
    let candidates;
    try {
      candidates = await attempt.search();
    } catch (e) {
      triedSources.push(`${SOURCE_LABELS[attempt.server]}(请求失败: ${e.message})`);
      continue;
    }

    const match = findBestSongMatch(target, candidates);
    if (match && match.method === 'exact') {
      candidate = match.candidate;
      break;
    }
    if (match && (!bestFallback || match.score > bestFallback.score)) {
      bestFallback = match;
    }
    triedSources.push(SOURCE_LABELS[attempt.server]);
  }

  // 三个源都没有精确匹配,留给人工确认
  if (!candidate) {
    const reason = bestFallback
      ? `${triedSources.join('/')}都没有精确匹配,最佳候选(${SOURCE_LABELS[bestFallback.candidate.source]}):${bestFallback.candidate.name} - ${(bestFallback.candidate.artists || []).join('/')}`
      : `${triedSources.join('/')}都没搜到匹配的歌曲`;
    return { status: 'needManual', reason };
  }

  const errors = [];
  let coverDone = false;
  let lyricDone = false;

  if (needCover) {
    try {
      const picUrl = await fetchCoverUrlForCandidate(candidate, neteaseBase);
      if (picUrl) {
        const imgRes = await axios.get(picUrl, { responseType: 'arraybuffer', timeout: 20000 });
        await embedCoverArt(absPath, imgRes.data, 'image/jpeg');
        coverDone = true;
      } else {
        errors.push('没有找到封面图');
      }
    } catch (e) {
      errors.push(`封面处理失败: ${e.message}`);
    }
  }

  if (needLyric) {
    try {
      const lrc = await fetchLyricForCandidate(candidate, neteaseBase);
      if (lrc) {
        await writeLyricFile(absPath, lrc);
        lyricDone = true;
      } else {
        errors.push('没有找到歌词');
      }
    } catch (e) {
      errors.push(`歌词处理失败: ${e.message}`);
    }
  }

  return {
    status: 'done',
    coverDone,
    lyricDone,
    matchedSource: SOURCE_LABELS[candidate.source],
    matchedName: candidate.name,
    matchedArtist: (candidate.artists || []).join('/'),
    errors
  };
}

// ---------------------------------------------------------------------------
// 封面 / 歌词刮削:后台任务管理(单用户工具,同一时间只跑一个任务)
// ---------------------------------------------------------------------------

let currentScrapeJob = null;

async function runScrapeJob(job, neteaseBase, meetingBase, scanDir, songPaths, options) {
  try {
    let files;

    if (Array.isArray(songPaths) && songPaths.length > 0) {
      // 用户在歌曲列表里勾选了具体要处理的歌曲,只处理这些,同时校验路径安全性
      const musicRoot = path.resolve(MUSIC_LIBRARY_DIR);
      files = songPaths
        .map(p => path.resolve(p))
        .filter(p => p === musicRoot || p.startsWith(musicRoot + path.sep));

      if (files.length !== songPaths.length) {
        job.errors.push('部分歌曲路径不在音乐库挂载范围内,已跳过');
      }
    } else {
      let absScanDir;
      try {
        absScanDir = resolveSafeLibraryPath(scanDir);
      } catch (e) {
        job.errors.push(e.message);
        return;
      }

      try {
        files = await listAudioFilesRecursive(absScanDir);
      } catch (e) {
        job.errors.push(`扫描目录失败: ${e.message}`);
        return;
      }
    }

    job.total = files.length;

    for (const filePath of files) {
      if (job.cancelled) break;

      const tags = readSongTags(filePath);
      job.currentLabel = `${tags.artist || '未知歌手'} - ${tags.title || path.basename(filePath)}`;

      const song = { title: tags.title, artist: tags.artist, album: tags.album, path: filePath };
      const result = await scrapeSong({ neteaseBase, meetingBase, song, options });
      job.processed++;

      if (result.status === 'done') {
        if (result.coverDone) job.savedCover++;
        if (result.lyricDone) job.savedLyric++;
        if (result.errors && result.errors.length) {
          job.errors.push(`${job.currentLabel}: ${result.errors.join('; ')}`);
        }
      } else if (result.status === 'needManual') {
        job.needManual.push({
          title: song.title,
          artist: song.artist,
          album: song.album,
          path: song.path,
          reason: result.reason
        });
      } else if (result.status === 'error') {
        job.errors.push(`${job.currentLabel}: ${result.message}`);
      } else if (result.status === 'skipped') {
        job.skipped++;
      }

      await sleep(300);
    }
  } catch (e) {
    job.errors.push(`任务异常终止: ${e.message}`);
  } finally {
    job.finished = true;
    job.currentLabel = '';

    if (NOTIFY_SCRAPE_DONE) {
      const status = job.cancelled ? '已停止' : '已完成';
      sendDingtalkNotification(
        '💿 封面/歌词刮削完成',
        `状态:${status}\n\n处理 ${job.processed} 首 · 封面成功 ${job.savedCover} ·` +
        ` 歌词成功 ${job.savedLyric} · 跳过 ${job.skipped} ·` +
        ` 待人工确认 ${job.needManual.length} · 出错 ${job.errors.length}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 自动监控新文件:有新歌曲文件写入完成就自动刮削封面/歌词
// ---------------------------------------------------------------------------

let watcherState = null; // { watcher, watchDir, neteaseBase, meetingBase, options, startedAt, processedCount, log }

function pushWatchLog(entry) {
  if (!watcherState) return;
  watcherState.log.unshift({ time: new Date().toISOString(), ...entry });
  if (watcherState.log.length > 200) watcherState.log.length = 200;
}

async function handleNewFileDetected(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return;

  try {
    const tags = readSongTags(filePath);
    const song = { title: tags.title, artist: tags.artist, album: tags.album, path: filePath };

    const result = await scrapeSong({
      neteaseBase: watcherState.neteaseBase,
      meetingBase: watcherState.meetingBase,
      song,
      options: watcherState.options
    });

    watcherState.processedCount++;
    const label = `${song.artist || '未知歌手'} - ${song.title || path.basename(filePath)}`;

    if (result.status === 'done') {
      pushWatchLog({
        type: 'done',
        label,
        detail: `封面${result.coverDone ? '✓' : '✗'} 歌词${result.lyricDone ? '✓' : '✗'}(来源: ${result.matchedSource || ''})${result.errors && result.errors.length ? ' · ' + result.errors.join('; ') : ''}`
      });
      if (NOTIFY_WATCH_NEW_FILE) {
        sendDingtalkNotification(
          '👀 新歌曲已自动处理',
          `**${label}**\n\n来源:${result.matchedSource || ''} · 封面${result.coverDone ? '✓' : '✗'} · 歌词${result.lyricDone ? '✓' : '✗'}`
        );
      }
    } else if (result.status === 'needManual') {
      pushWatchLog({ type: 'needManual', label, detail: result.reason });
      if (NOTIFY_WATCH_NEW_FILE) {
        sendDingtalkNotification('👀 新歌曲需要人工确认', `**${label}**\n\n${result.reason}`);
      }
    } else if (result.status === 'error') {
      pushWatchLog({ type: 'error', label, detail: result.message });
      if (NOTIFY_WATCH_NEW_FILE) {
        sendDingtalkNotification('⚠️ 新歌曲处理出错', `**${label}**\n\n${result.message}`);
      }
    } else {
      pushWatchLog({ type: 'skipped', label, detail: '已经有封面和歌词,跳过' });
    }
  } catch (e) {
    pushWatchLog({ type: 'error', label: path.basename(filePath), detail: e.message });
  }
}

function startWatcher({ watchDir, neteaseBase, meetingBase, options }) {
  if (watcherState) {
    throw new Error('已经在监控中,请先停止');
  }

  const absDir = resolveSafeLibraryPath(watchDir);

  const watcher = chokidar.watch(absDir, {
    ignoreInitial: true, // 只关心启动之后新出现的文件,不处理已有的(那是扫描功能的事)
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 500 } // 等文件确实写完了再处理,避免处理到拷贝一半的文件
  });

  watcherState = {
    watcher,
    watchDir,
    neteaseBase,
    meetingBase,
    options,
    startedAt: new Date().toISOString(),
    processedCount: 0,
    log: []
  };

  watcher.on('add', (filePath) => {
    handleNewFileDetected(filePath).catch(e => pushWatchLog({ type: 'error', label: path.basename(filePath), detail: e.message }));
  });

  watcher.on('error', (err) => {
    pushWatchLog({ type: 'error', label: '', detail: `监控出错: ${err.message}` });
  });
}

async function stopWatcher() {
  if (!watcherState) return;
  await watcherState.watcher.close();
  watcherState = null;
}

app.post('/api/watch/start', (req, res) => {
  try {
    const { neteaseBase, meetingBase, watchDir, options } = req.body;
    if (!neteaseBase) {
      return res.status(400).json({ error: '缺少网易云 API 地址' });
    }
    if (watcherState) {
      return res.status(409).json({ error: '已经在监控中,请先停止' });
    }

    const opts = {
      cover: options && options.cover !== false,
      lyrics: options && options.lyrics !== false,
      overwrite: false // 监控新文件场景下,新文件本来就没封面/歌词,覆盖选项没有意义,固定关闭
    };

    startWatcher({ watchDir: watchDir || '', neteaseBase, meetingBase: meetingBase || '', options: opts });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/watch/stop', async (req, res) => {
  try {
    await stopWatcher();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/watch/status', (req, res) => {
  if (!watcherState) {
    return res.json({ watching: false });
  }
  res.json({
    watching: true,
    watchDir: watcherState.watchDir,
    startedAt: watcherState.startedAt,
    processedCount: watcherState.processedCount,
    log: watcherState.log
  });
});

app.post('/api/scrape/start', (req, res) => {
  try {
    const { neteaseBase, meetingBase, scanDir, songPaths, options } = req.body;

    if (!neteaseBase) {
      return res.status(400).json({ error: '缺少必填参数' });
    }
    if (currentScrapeJob && !currentScrapeJob.finished) {
      return res.status(409).json({ error: '已经有一个刮削任务在跑,请等它结束或先停止' });
    }

    const job = {
      id: Date.now().toString(36),
      total: 0,
      processed: 0,
      savedCover: 0,
      savedLyric: 0,
      skipped: 0,
      needManual: [],
      errors: [],
      currentLabel: '',
      cancelled: false,
      finished: false
    };
    currentScrapeJob = job;

    const opts = {
      cover: options && options.cover !== false,
      lyrics: options && options.lyrics !== false,
      overwrite: !!(options && options.overwrite)
    };

    runScrapeJob(job, neteaseBase, meetingBase || '', scanDir || '', songPaths, opts);

    res.json({ jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Meting-API(QQ音乐/酷我音乐)生成的封面链接指向的是 docker 内部服务地址,
// 浏览器没法直接访问,需要后端代为请求一次再转发给浏览器
app.get('/api/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('缺少 url 参数');
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(imgRes.data);
  } catch (e) {
    res.status(502).send('图片代理请求失败');
  }
});

app.get('/api/library/browse', async (req, res) => {
  try {
    const relPath = req.query.relPath || '';
    const absPath = resolveSafeLibraryPath(relPath);
    const entries = await fsPromises.readdir(absPath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b, 'zh'));
    const audioFileCount = entries.filter(e => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())).length;
    res.json({ relPath, dirs, audioFileCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 列出某个目录(递归)下所有歌曲,带上当前是否已有封面/歌词的状态,供前端做勾选
app.get('/api/library/songs', async (req, res) => {
  try {
    const relPath = req.query.relPath || '';
    let absDir;
    try {
      absDir = resolveSafeLibraryPath(relPath);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const files = await listAudioFilesRecursive(absDir);
    const songs = [];
    for (const filePath of files) {
      const tags = readSongTags(filePath);
      const [hasCover, hasLyric] = await Promise.all([
        songAlreadyHasCover(filePath),
        lrcFileExists(filePath)
      ]);
      songs.push({
        path: filePath,
        relPath: path.relative(path.resolve(MUSIC_LIBRARY_DIR), filePath),
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        hasCover,
        hasLyric
      });
    }

    res.json({ songs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scrape/status', (req, res) => {
  if (!currentScrapeJob || currentScrapeJob.id !== req.query.jobId) {
    return res.status(404).json({ error: '没有找到这个任务(可能服务重启过)' });
  }
  res.json(currentScrapeJob);
});

app.post('/api/scrape/stop', (req, res) => {
  if (currentScrapeJob && !currentScrapeJob.finished) {
    currentScrapeJob.cancelled = true;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 封面 / 歌词刮削:单曲手动搜索与手动应用(处理"需要人工确认"的歌曲)
// ---------------------------------------------------------------------------

async function neteaseFillMissingCovers(base, songs) {
  const missingIds = songs.filter(s => !s.picUrl).map(s => s.id);
  if (missingIds.length === 0) return songs;

  try {
    const url = neteaseUrl(base, `/song/detail?ids=${missingIds.join(',')}&timestamp=${Date.now()}`);
    const res = await axios.get(url, { timeout: 15000 });
    const detailMap = new Map();
    for (const s of (res.data && res.data.songs) || []) {
      detailMap.set(String(s.id), (s.al && s.al.picUrl) || '');
    }
    return songs.map(s => (s.picUrl ? s : { ...s, picUrl: detailMap.get(String(s.id)) || '' }));
  } catch (e) {
    // 补封面失败不影响搜索结果本身,原样返回就好
    return songs;
  }
}

app.get('/api/music/song-search', async (req, res) => {
  try {
    const { source, neteaseBase, meetingBase, keyword } = req.query;
    if (!source || !keyword) {
      return res.status(400).json({ error: '缺少参数' });
    }

    let songs;
    if (source === 'netease') {
      if (!neteaseBase) return res.status(400).json({ error: '缺少网易云 API 地址' });
      songs = await neteaseSongSearch(neteaseBase, keyword, 10);
      songs = await neteaseFillMissingCovers(neteaseBase, songs);
    } else if (source === 'tencent' || source === 'kuwo') {
      if (!meetingBase) return res.status(400).json({ error: '缺少 Meting API 地址' });
      try {
        songs = await meetingSearch(meetingBase, source, keyword);
      } catch (e) {
        return res.status(502).json({ error: `${SOURCE_LABELS[source]}搜索失败: ${e.message}` });
      }
    } else {
      return res.status(400).json({ error: '不支持的来源' });
    }

    res.json({ songs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scrape/apply-manual', async (req, res) => {
  try {
    const { neteaseBase, songPath, candidate, cover, lyrics } = req.body;
    if (!songPath || !candidate || !candidate.source) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // songPath 现在就是扫描时得到的绝对路径,直接用,但还是校验一下确保在挂载目录范围内
    const musicRoot = path.resolve(MUSIC_LIBRARY_DIR);
    const absPath = path.resolve(songPath);
    if (absPath !== musicRoot && !absPath.startsWith(musicRoot + path.sep)) {
      return res.status(400).json({ error: '文件路径不在音乐库挂载范围内' });
    }
    await fsPromises.access(absPath, fs.constants.W_OK);

    let coverDone = false;
    let lyricDone = false;

    if (cover) {
      const picUrl = await fetchCoverUrlForCandidate(candidate, neteaseBase);
      if (picUrl) {
        const imgRes = await axios.get(picUrl, { responseType: 'arraybuffer', timeout: 20000 });
        await embedCoverArt(absPath, imgRes.data, 'image/jpeg');
        coverDone = true;
      }
    }

    if (lyrics) {
      const lrc = await fetchLyricForCandidate(candidate, neteaseBase);
      if (lrc) {
        await writeLyricFile(absPath, lrc);
        lyricDone = true;
      }
    }

    res.json({ ok: true, coverDone, lyricDone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

process.on('SIGTERM', async () => {
  console.log('收到停止信号,正在关闭...');
  if (watcherState) {
    try { await watcherState.watcher.close(); } catch (e) { /* ignore */ }
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Netease -> Navidrome 同步工具已启动: http://localhost:${PORT}`);

  // 根据环境变量决定是否在容器启动时就自动开始监控,不用每次手动去网页点
  if (process.env.WATCH_AUTO_START === 'true') {
    try {
      startWatcher({
        watchDir: process.env.WATCH_DIR || '',
        neteaseBase: process.env.DEFAULT_NETEASE_BASE || '',
        meetingBase: process.env.DEFAULT_METING_BASE || '',
        options: {
          cover: process.env.WATCH_COVER !== 'false',
          lyrics: process.env.WATCH_LYRICS !== 'false',
          overwrite: false
        }
      });
      console.log(`自动监控已根据环境变量启动,监控目录: ${process.env.WATCH_DIR || '(整个音乐库根目录)'}`);
    } catch (e) {
      console.error('自动启动监控失败:', e.message);
    }
  }
});
