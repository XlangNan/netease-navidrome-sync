const STORAGE_KEY = 'netease-navidrome-sync-config';
// 这个页面不需要 Navidrome 配置,只需要网易云地址和扫描目录(单独存一份)
const configFields = ['neteaseBase', 'meetingBase'];
const SCRAPE_STORAGE_KEY = 'netease-navidrome-sync-scrape-config';

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    configFields.forEach(f => {
      const el = document.getElementById(f);
      if (el && saved[f] !== undefined) el.value = saved[f];
    });
  } catch (e) { /* ignore */ }

  try {
    const scrapeSaved = JSON.parse(localStorage.getItem(SCRAPE_STORAGE_KEY) || '{}');
    if (scrapeSaved.scanDir !== undefined) document.getElementById('scanDir').value = scrapeSaved.scanDir;
  } catch (e) { /* ignore */ }
}

function saveConfig() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { /* ignore */ }
  configFields.forEach(f => {
    const el = document.getElementById(f);
    if (el) data[f] = el.value;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  localStorage.setItem(SCRAPE_STORAGE_KEY, JSON.stringify({ scanDir: document.getElementById('scanDir').value }));
}

loadConfig();

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function apiGet(path, params) {
  const usp = new URLSearchParams(params);
  const res = await fetch(`${path}?${usp.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function neteaseBaseValue() {
  return document.getElementById('neteaseBase').value.trim();
}

function meetingBaseValue() {
  return document.getElementById('meetingBase').value.trim();
}

(async () => {
  const neteaseField = document.getElementById('neteaseBase');
  const meetingField = document.getElementById('meetingBase');
  if (!neteaseField.value || !meetingField.value) {
    try {
      const cfg = await apiGet('/api/config', {});
      if (!neteaseField.value && cfg.defaultNeteaseBase) neteaseField.value = cfg.defaultNeteaseBase;
      if (!meetingField.value && cfg.defaultMeetingBase) meetingField.value = cfg.defaultMeetingBase;
    } catch (e) { /* 忽略,保持为空由用户手填 */ }
  }
})();

// ---------------------------------------------------------------------------
// 目录浏览器
// ---------------------------------------------------------------------------

let browserCurrentPath = '';

document.getElementById('browseBtn').addEventListener('click', () => {
  const box = document.getElementById('browserBox');
  const isOpen = box.style.display !== 'none';
  box.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    browserCurrentPath = document.getElementById('scanDir').value.trim();
    loadDirBrowser(browserCurrentPath);
  }
});

async function loadDirBrowser(relPath) {
  const listEl = document.getElementById('dirList');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const infoEl = document.getElementById('currentDirInfo');
  listEl.innerHTML = `<div class="dim" style="padding:8px;">加载中...</div>`;

  try {
    const { dirs, audioFileCount } = await apiGet('/api/library/browse', { relPath });
    browserCurrentPath = relPath;
    breadcrumbEl.textContent = `当前目录: /${relPath}`;
    infoEl.textContent = `(这个目录里直接有 ${audioFileCount} 个音频文件,不含子文件夹)`;

    listEl.innerHTML = '';

    if (relPath) {
      const parent = relPath.split('/').slice(0, -1).join('/');
      const upRow = document.createElement('div');
      upRow.className = 'dir-item';
      upRow.innerHTML = `<span class="dir-icon">↑</span><span>返回上一级</span>`;
      upRow.addEventListener('click', () => loadDirBrowser(parent));
      listEl.appendChild(upRow);
    }

    if (dirs.length === 0 && !relPath) {
      listEl.innerHTML += `<div class="dim" style="padding:8px;">根目录下没有子文件夹</div>`;
    }

    for (const name of dirs) {
      const row = document.createElement('div');
      row.className = 'dir-item';
      row.innerHTML = `<span class="dir-icon">📁</span><span>${escapeHtml(name)}</span>`;
      const childPath = relPath ? `${relPath}/${name}` : name;
      row.addEventListener('click', () => loadDirBrowser(childPath));
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="dim" style="padding:8px;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('useThisDirBtn').addEventListener('click', () => {
  document.getElementById('scanDir').value = browserCurrentPath;
  document.getElementById('browserBox').style.display = 'none';
  saveConfig();
});

// ---------------------------------------------------------------------------
// 开始 / 停止刮削任务,轮询进度
// ---------------------------------------------------------------------------

let currentJobId = null;
let pollTimer = null;

async function startJob(extraPayload) {
  saveConfig();

  const base = neteaseBaseValue();
  if (!base) {
    alert('请先填写网易云 API 代理地址');
    return;
  }

  const options = {
    cover: document.getElementById('optCover').checked,
    lyrics: document.getElementById('optLyrics').checked,
    overwrite: document.getElementById('optOverwrite').checked
  };

  if (!options.cover && !options.lyrics) {
    alert('封面和歌词至少要选一个');
    return;
  }

  const startBtn = document.getElementById('startBtn');
  const startSelectedBtn = document.getElementById('startSelectedBtn');
  const stopBtn = document.getElementById('stopBtn');
  startBtn.disabled = true;
  startSelectedBtn.disabled = true;

  try {
    const { jobId } = await apiPost('/api/scrape/start', {
      neteaseBase: base,
      meetingBase: meetingBaseValue(),
      options,
      ...extraPayload
    });
    currentJobId = jobId;
    document.getElementById('progressCard').style.display = 'block';
    document.getElementById('progressCardActions').style.display = 'block';
    document.getElementById('manualCard').style.display = 'block';
    stopBtn.style.display = 'inline-block';
    pollTimer = setInterval(pollStatus, 1500);
  } catch (e) {
    alert(`启动失败: ${e.message}`);
    startBtn.disabled = false;
    startSelectedBtn.disabled = false;
  }
}

document.getElementById('startBtn').addEventListener('click', () => {
  const scanDir = document.getElementById('scanDir').value.trim();
  startJob({ scanDir });
});

document.getElementById('startSelectedBtn').addEventListener('click', () => {
  const songPaths = Array.from(selectedSongPaths);
  if (songPaths.length === 0) {
    alert('请至少勾选一首歌');
    return;
  }
  startJob({ songPaths });
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  if (!currentJobId) return;
  await apiPost('/api/scrape/stop', {});
});

async function pollStatus() {
  if (!currentJobId) return;
  try {
    const job = await apiGet('/api/scrape/status', { jobId: currentJobId });
    renderJob(job);

    if (job.finished) {
      clearInterval(pollTimer);
      pollTimer = null;
      document.getElementById('startBtn').disabled = false;
      document.getElementById('startSelectedBtn').disabled = false;
      document.getElementById('stopBtn').style.display = 'none';
    }
  } catch (e) {
    document.getElementById('progressSummary').textContent = `查询进度失败: ${e.message}`;
    clearInterval(pollTimer);
    pollTimer = null;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startSelectedBtn').disabled = false;
    document.getElementById('stopBtn').style.display = 'none';
  }
}

let renderedManualCount = 0;

function renderJob(job) {
  const summaryEl = document.getElementById('progressSummary');
  const currentEl = document.getElementById('progressCurrent');
  const errorLogEl = document.getElementById('errorLog');

  const statusText = job.finished ? (job.cancelled ? '已停止' : '已完成') : '进行中...';
  summaryEl.innerHTML = `
    <b>${statusText}</b> ·
    已处理 ${job.processed} / ${job.total || '统计中'} ·
    封面成功 ${job.savedCover} ·
    歌词成功 ${job.savedLyric} ·
    跳过 ${job.skipped} ·
    待人工确认 ${job.needManual.length} ·
    出错 ${job.errors.length}
  `;
  currentEl.textContent = job.currentLabel ? `当前处理: ${job.currentLabel}` : '';

  errorLogEl.innerHTML = job.errors.length
    ? job.errors.map(e => `<div>${escapeHtml(e)}</div>`).join('')
    : '<span class="dim">暂无</span>';

  if (job.needManual.length !== renderedManualCount) {
    renderedManualCount = job.needManual.length;
    renderManualList(job.needManual);
  }
}

// ---------------------------------------------------------------------------
// 人工确认列表:手动搜歌 + 选中候选应用封面/歌词
// ---------------------------------------------------------------------------

function renderManualList(items) {
  const listEl = document.getElementById('manualList');
  listEl.innerHTML = '';

  if (items.length === 0) {
    listEl.innerHTML = `<div class="dim" style="padding:8px 6px;">暂无需要人工确认的歌曲</div>`;
    return;
  }

  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'manual-item';
    wrap.innerHTML = `
      <div class="manual-header">
        <span class="manual-title">${escapeHtml(item.title)} <span class="dim">/ ${escapeHtml(item.artist)} · ${escapeHtml(item.album || '')}</span></span>
        <button class="link-btn manual-search-btn">手动搜索</button>
      </div>
      <div class="manual-reason">${escapeHtml(item.reason || '')}</div>
    `;

    const candidateRow = document.createElement('div');
    candidateRow.className = 'candidate-row';

    wrap.querySelector('.manual-search-btn').addEventListener('click', () => {
      const isOpen = candidateRow.classList.contains('open');
      if (isOpen) {
        candidateRow.classList.remove('open');
        return;
      }
      candidateRow.classList.add('open');
      buildManualSearchPanel(item, candidateRow);
    });

    listEl.appendChild(wrap);
    listEl.appendChild(candidateRow);
  }
}

function buildManualSearchPanel(item, candidateRow) {
  const defaultKeyword = `${item.title} ${item.artist}`;
  candidateRow.innerHTML = `
    <div class="candidate-controls">
      <select class="source-select">
        <option value="netease">网易云</option>
        <option value="tencent">QQ音乐</option>
        <option value="kuwo">酷我音乐</option>
      </select>
      <input class="keyword-input" value="${escapeHtml(defaultKeyword)}" />
      <button class="mini-btn song-search-btn">搜索</button>
    </div>
    <div class="candidate-grid"></div>
    <div class="save-msg dim" style="margin-top:8px;"></div>
  `;

  const sourceSelect = candidateRow.querySelector('.source-select');
  const keywordInput = candidateRow.querySelector('.keyword-input');
  const gridEl = candidateRow.querySelector('.candidate-grid');
  const saveMsg = candidateRow.querySelector('.save-msg');

  async function runSongSearch(source, keyword) {
    gridEl.innerHTML = `<span class="dim">搜索中...</span>`;
    try {
      const params = { source, keyword };
      if (source === 'netease') params.neteaseBase = neteaseBaseValue();
      else params.meetingBase = meetingBaseValue();

      const { songs } = await apiGet('/api/music/song-search', params);
      if (songs.length === 0) {
        gridEl.innerHTML = `<span class="tag warn">没搜到结果,换个关键词或者换个来源试试</span>`;
        return;
      }
      gridEl.innerHTML = '';
      for (const s of songs) {
        const card = document.createElement('div');
        card.className = 'candidate-card';
        // 网易云的图片是公网直链,浏览器能直接加载;QQ音乐/酷我音乐的链接指向 docker 内部地址,
        // 浏览器访问不到,要经过后端代理转发一次
        const thumb = s.picUrl
          ? (source === 'netease' ? `${s.picUrl}?param=100y100` : `/api/proxy-image?url=${encodeURIComponent(s.picUrl)}`)
          : '';
        card.innerHTML = `
          <img src="${thumb}" alt="" onerror="this.style.visibility='hidden'" />
          <div class="candidate-name">${escapeHtml(s.name)}<br><span class="dim">${escapeHtml((s.artists || []).join('/'))}</span></div>
        `;
        card.addEventListener('click', async () => {
          saveMsg.textContent = '处理中...';
          try {
            const options = {
              cover: document.getElementById('optCover').checked,
              lyrics: document.getElementById('optLyrics').checked
            };
            await apiPost('/api/scrape/apply-manual', {
              neteaseBase: neteaseBaseValue(),
              songPath: item.path,
              candidate: s,
              cover: options.cover,
              lyrics: options.lyrics
            });
            saveMsg.textContent = '已应用';
          } catch (e) {
            saveMsg.innerHTML = `<span class="tag err">处理失败: ${escapeHtml(e.message)}</span>`;
          }
        });
        gridEl.appendChild(card);
      }
    } catch (e) {
      console.error('song-search failed:', e);
      gridEl.innerHTML = `<span class="tag err">搜索失败: ${escapeHtml(e.message)}</span>`;
    }
  }

  candidateRow.querySelector('.song-search-btn').addEventListener('click', () => {
    runSongSearch(sourceSelect.value, keywordInput.value.trim() || defaultKeyword);
  });

  runSongSearch('netease', defaultKeyword);
}

// ---------------------------------------------------------------------------
// 歌曲列表:加载 / 过滤 / 勾选 / 单曲直接手动搜索
// ---------------------------------------------------------------------------

let allSongs = [];
let selectedSongPaths = new Set();

document.getElementById('loadSongsBtn').addEventListener('click', async () => {
  saveConfig();
  const scanDir = document.getElementById('scanDir').value.trim();
  const statusEl = document.getElementById('loadSongsStatus');
  statusEl.textContent = '加载中,歌曲多的话可能要等一会...';

  try {
    const { songs } = await apiGet('/api/library/songs', { relPath: scanDir });
    allSongs = songs;
    selectedSongPaths = new Set();
    statusEl.textContent = `共 ${songs.length} 首`;
    document.getElementById('songListArea').style.display = 'block';
    renderSongList();
  } catch (e) {
    statusEl.textContent = `加载失败: ${e.message}`;
  }
});

document.getElementById('songOnlyMissing').addEventListener('change', renderSongList);
document.getElementById('songNameFilter').addEventListener('input', renderSongList);

document.getElementById('songSelectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('#songList input[type=checkbox]').forEach(cb => {
    cb.checked = true;
    selectedSongPaths.add(cb.dataset.path);
  });
});

document.getElementById('songSelectNoneBtn').addEventListener('click', () => {
  document.querySelectorAll('#songList input[type=checkbox]').forEach(cb => { cb.checked = false; });
  selectedSongPaths.clear();
});

function renderSongList() {
  const listEl = document.getElementById('songList');
  const onlyMissing = document.getElementById('songOnlyMissing').checked;
  const nameFilter = document.getElementById('songNameFilter').value.trim().toLowerCase();
  listEl.innerHTML = '';

  const visible = allSongs.filter(s => {
    if (onlyMissing && s.hasCover && s.hasLyric) return false;
    if (nameFilter) {
      const haystack = `${s.title} ${s.artist} ${s.album}`.toLowerCase();
      if (!haystack.includes(nameFilter)) return false;
    }
    return true;
  });
  document.getElementById('songCount').textContent = `显示 ${visible.length} / ${allSongs.length} 首`;

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="dim" style="padding:8px 6px;">没有符合条件的歌曲</div>`;
    return;
  }

  for (const song of visible) {
    const row = document.createElement('div');
    row.className = 'artist-row';
    row.innerHTML = `
      <input type="checkbox" data-path="${escapeHtml(song.path)}" ${selectedSongPaths.has(song.path) ? 'checked' : ''} />
      <span class="artist-name">${escapeHtml(song.title || '(无标题)')} <span class="dim">/ ${escapeHtml(song.artist || '未知歌手')} · ${escapeHtml(song.album || '')}</span></span>
      <span class="tag ${song.hasCover ? 'ok' : 'warn'}">${song.hasCover ? '有封面' : '缺封面'}</span>
      <span class="tag ${song.hasLyric ? 'ok' : 'warn'}" style="margin-left:6px;">${song.hasLyric ? '有歌词' : '缺歌词'}</span>
      <button class="link-btn song-manual-btn" style="margin-left:10px;">手动搜索</button>
    `;

    const checkbox = row.querySelector('input[type=checkbox]');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedSongPaths.add(song.path);
      else selectedSongPaths.delete(song.path);
    });

    const candidateRow = document.createElement('div');
    candidateRow.className = 'candidate-row';

    row.querySelector('.song-manual-btn').addEventListener('click', () => {
      const isOpen = candidateRow.classList.contains('open');
      if (isOpen) {
        candidateRow.classList.remove('open');
        return;
      }
      candidateRow.classList.add('open');
      buildManualSearchPanel(song, candidateRow);
    });

    listEl.appendChild(row);
    listEl.appendChild(candidateRow);
  }
}

// ---------------------------------------------------------------------------
// 自动监控新文件
// ---------------------------------------------------------------------------

let watchPollTimer = null;

function escapeAttr(s) {
  return escapeHtml(s);
}

async function checkWatchStatus() {
  try {
    const status = await apiGet('/api/watch/status', {});
    renderWatchStatus(status);
  } catch (e) {
    document.getElementById('watchStatusText').textContent = `查询监控状态失败: ${e.message}`;
  }
}

function renderWatchStatus(status) {
  const startBtn = document.getElementById('watchStartBtn');
  const stopBtn = document.getElementById('watchStopBtn');
  const statusText = document.getElementById('watchStatusText');
  const logArea = document.getElementById('watchLogArea');

  if (status.watching) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-block';
    const started = new Date(status.startedAt).toLocaleString('zh-CN');
    statusText.textContent = `监控中,从 ${started} 开始,已处理 ${status.processedCount} 个新文件`;
    logArea.style.display = 'block';
    renderWatchLog(status.log || []);
  } else {
    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';
    statusText.textContent = '当前没有在监控';
  }
}

function renderWatchLog(log) {
  const logEl = document.getElementById('watchLog');
  if (log.length === 0) {
    logEl.innerHTML = `<div class="dim" style="padding:6px 8px;">还没有处理记录</div>`;
    return;
  }
  logEl.innerHTML = log.map(entry => {
    const tagClass = entry.type === 'done' ? 'ok' : (entry.type === 'error' ? 'err' : 'warn');
    const typeLabel = { done: '已处理', needManual: '需确认', error: '出错', skipped: '跳过' }[entry.type] || entry.type;
    const time = new Date(entry.time).toLocaleTimeString('zh-CN');
    return `
      <div class="watch-log-item">
        <span class="watch-time">${escapeAttr(time)}</span>
        <span class="tag ${tagClass}">${typeLabel}</span>
        <span class="watch-label">${escapeHtml(entry.label || '')}</span>
        ${entry.detail ? `<span class="watch-detail">${escapeHtml(entry.detail)}</span>` : ''}
      </div>
    `;
  }).join('');
}

document.getElementById('watchStartBtn').addEventListener('click', async () => {
  saveConfig();
  const base = neteaseBaseValue();
  if (!base) {
    alert('请先填写网易云 API 代理地址');
    return;
  }
  const watchDir = document.getElementById('watchDir').value.trim();
  const options = {
    cover: document.getElementById('optCover').checked,
    lyrics: document.getElementById('optLyrics').checked
  };

  try {
    await apiPost('/api/watch/start', {
      neteaseBase: base,
      meetingBase: meetingBaseValue(),
      watchDir,
      options
    });
    checkWatchStatus();
    if (!watchPollTimer) watchPollTimer = setInterval(checkWatchStatus, 3000);
  } catch (e) {
    alert(`启动监控失败: ${e.message}`);
  }
});

document.getElementById('watchStopBtn').addEventListener('click', async () => {
  try {
    await apiPost('/api/watch/stop', {});
    checkWatchStatus();
  } catch (e) {
    alert(`停止监控失败: ${e.message}`);
  }
});

// 页面加载时就查一下当前监控状态(比如容器设了自动启动,或者刷新页面之前就已经在监控)
checkWatchStatus();
if (!watchPollTimer) watchPollTimer = setInterval(checkWatchStatus, 3000);
