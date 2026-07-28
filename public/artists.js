const STORAGE_KEY = 'netease-navidrome-sync-config';
const configFields = ['neteaseBase', 'navidromeUrl', 'navidromeUsername', 'navidromePassword'];

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    configFields.forEach(f => {
      const el = document.getElementById(f);
      if (el && saved[f] !== undefined) el.value = saved[f];
    });
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
}

loadConfig();

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function sanitizeArtistFilename(name) {
  return String(name).replace(/[/\\:*?"<>|]/g, '_').trim();
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

let artists = [];
let savedFiles = new Set(); // 文件名(不含扩展名)集合

function artistHasImage(name) {
  const fileBase = sanitizeArtistFilename(name);
  return savedFiles.has(fileBase);
}

document.getElementById('loadArtistsBtn').addEventListener('click', async () => {
  saveConfig();

  const navidromeUrl = document.getElementById('navidromeUrl').value.trim();
  const navidromeUsername = document.getElementById('navidromeUsername').value.trim();
  const navidromePassword = document.getElementById('navidromePassword').value;
  const statusEl = document.getElementById('loadStatus');

  if (!navidromeUrl || !navidromeUsername || !navidromePassword) {
    statusEl.textContent = '请先填写完整的 Navidrome 配置';
    return;
  }

  statusEl.textContent = '加载中...';

  try {
    const [artistRes, fileRes] = await Promise.all([
      apiGet('/api/navidrome/artists', { navidromeUrl, navidromeUsername, navidromePassword }),
      apiGet('/api/artist-image/list', {})
    ]);

    artists = artistRes.artists;
    savedFiles = new Set(fileRes.files.map(f => f.replace(/\.[^.]+$/, '')));

    statusEl.textContent = `共 ${artists.length} 位歌手`;
    document.getElementById('artistCard').style.display = 'block';
    renderArtistList();
  } catch (e) {
    statusEl.textContent = `加载失败: ${e.message}`;
  }
});

document.getElementById('onlyMissing').addEventListener('change', renderArtistList);
document.getElementById('nameFilter').addEventListener('input', renderArtistList);

// ---------------------------------------------------------------------------
// 自动批量匹配:只对"精确同名且唯一"的候选自动下载,其余留给手动确认
// ---------------------------------------------------------------------------

function normalizeForMatch(str) {
  return String(str || '')
    .replace(/[\(（].*?[\)）]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let autoMatchCancelled = false;

document.getElementById('stopAutoBtn').addEventListener('click', () => {
  autoMatchCancelled = true;
});

document.getElementById('autoMatchBtn').addEventListener('click', async () => {
  const base = document.getElementById('neteaseBase').value.trim();
  if (!base) {
    alert('请先填写网易云 API 代理地址');
    return;
  }
  if (artists.length === 0) {
    alert('请先加载歌手列表');
    return;
  }

  const targets = artists.filter(a => !artistHasImage(a.name));
  if (targets.length === 0) {
    document.getElementById('autoMatchStatus').textContent = '所有歌手都已经有头像了';
    return;
  }

  autoMatchCancelled = false;
  const autoBtn = document.getElementById('autoMatchBtn');
  const stopBtn = document.getElementById('stopAutoBtn');
  const statusEl = document.getElementById('autoMatchStatus');
  autoBtn.disabled = true;
  stopBtn.style.display = 'inline-block';

  let savedCount = 0;
  let needManualCount = 0;
  let errorCount = 0;

  for (let i = 0; i < targets.length; i++) {
    if (autoMatchCancelled) break;
    const artist = targets[i];
    statusEl.textContent = `处理中 ${i + 1}/${targets.length}:${artist.name}(已自动保存 ${savedCount},待手动确认 ${needManualCount})`;

    try {
      const { artists: candidates } = await apiGet('/api/netease/artist-search', { neteaseBase: base, name: artist.name });
      const targetNorm = normalizeForMatch(artist.name);
      const exactMatches = candidates.filter(c => normalizeForMatch(c.name) === targetNorm);

      if (exactMatches.length === 1) {
        await apiPost('/api/artist-image/save', { artistName: artist.name, imageUrl: exactMatches[0].imageUrl });
        savedFiles.add(sanitizeArtistFilename(artist.name));
        savedCount++;
      } else {
        // 0 个精确匹配(可能没搜到)或多个同名(可能重名,交给人工辨认)
        needManualCount++;
      }
    } catch (e) {
      errorCount++;
    }

    // 稍微限速一下,别把网易云代理打崩
    await sleep(300);
  }

  autoBtn.disabled = false;
  stopBtn.style.display = 'none';
  statusEl.textContent = autoMatchCancelled
    ? `已手动停止:自动保存 ${savedCount} 个,待手动确认 ${needManualCount} 个${errorCount ? `,出错 ${errorCount} 个` : ''}`
    : `自动匹配完成:自动保存 ${savedCount} 个,待手动确认 ${needManualCount} 个${errorCount ? `,出错 ${errorCount} 个` : ''}`;

  renderArtistList();
});

function buildImageSearchUrls(keyword) {
  const q = encodeURIComponent(`${keyword} 歌手`);
  return {
    baidu: `https://image.baidu.com/search/index?tn=baiduimage&word=${q}`,
    bing: `https://www.bing.com/images/search?q=${q}`
  };
}

async function runNeteaseSearch(base, keyword, gridEl) {
  gridEl.innerHTML = `<span class="dim">搜索中...</span>`;
  try {
    const { artists: candidates } = await apiGet('/api/netease/artist-search', { neteaseBase: base, name: keyword });
    if (candidates.length === 0) {
      gridEl.innerHTML = `<span class="dim">没搜到同名歌手,可以试试改改关键词,或者用下面的百度/必应</span>`;
      return;
    }
    gridEl.innerHTML = '';
    for (const c of candidates) {
      const card = document.createElement('div');
      card.className = 'candidate-card';
      card.innerHTML = `
        <img src="${c.imageUrl}" alt="" />
        <div class="candidate-name">${escapeHtml(c.name)}</div>
      `;
      card.dataset.imageUrl = c.imageUrl;
      gridEl.appendChild(card);
    }
  } catch (e) {
    gridEl.innerHTML = `<span class="dim">搜索失败: ${escapeHtml(e.message)}</span>`;
  }
}

function buildCandidateRowContent(artist, candidateRow, fileBase) {
  candidateRow.innerHTML = `
    <div class="candidate-controls">
      <input class="keyword-input" value="${escapeHtml(artist.name)}" />
      <button class="mini-btn netease-search-btn">网易云搜索</button>
      <button class="mini-btn baidu-btn">百度图片搜索 ↗</button>
      <button class="mini-btn bing-btn">必应图片搜索 ↗</button>
    </div>
    <div class="candidate-grid"></div>
    <div class="manual-url-row">
      <input class="manual-url-input" placeholder="或者把图片直链粘贴到这里(在图片上右键→复制图片地址)" />
      <button class="mini-btn save-url-btn">保存这个链接</button>
    </div>
    <div class="save-msg dim" style="margin-top:8px;"></div>
  `;

  const keywordInput = candidateRow.querySelector('.keyword-input');
  const gridEl = candidateRow.querySelector('.candidate-grid');
  const manualInput = candidateRow.querySelector('.manual-url-input');
  const saveMsg = candidateRow.querySelector('.save-msg');

  async function saveImage(imageUrl) {
    saveMsg.textContent = '保存中...';
    try {
      await apiPost('/api/artist-image/save', { artistName: artist.name, imageUrl });
      savedFiles.add(fileBase);
      saveMsg.textContent = '已保存';
      renderArtistList();
    } catch (e) {
      saveMsg.textContent = `保存失败: ${e.message}`;
    }
  }

  candidateRow.querySelector('.netease-search-btn').addEventListener('click', () => {
    const base = document.getElementById('neteaseBase').value.trim();
    if (!base) { saveMsg.textContent = '请先填写网易云 API 代理地址'; return; }
    runNeteaseSearch(base, keywordInput.value.trim() || artist.name, gridEl);
  });

  candidateRow.querySelector('.baidu-btn').addEventListener('click', () => {
    const urls = buildImageSearchUrls(keywordInput.value.trim() || artist.name);
    window.open(urls.baidu, '_blank');
  });

  candidateRow.querySelector('.bing-btn').addEventListener('click', () => {
    const urls = buildImageSearchUrls(keywordInput.value.trim() || artist.name);
    window.open(urls.bing, '_blank');
  });

  candidateRow.querySelector('.save-url-btn').addEventListener('click', () => {
    const url = manualInput.value.trim();
    if (!url) { saveMsg.textContent = '请先粘贴图片链接'; return; }
    saveImage(url);
  });

  gridEl.addEventListener('click', (ev) => {
    const card = ev.target.closest('.candidate-card');
    if (card && card.dataset.imageUrl) saveImage(card.dataset.imageUrl);
  });

  // 默认打开时直接按歌手名跑一次网易云搜索,省得每次都要手动点
  const base = document.getElementById('neteaseBase').value.trim();
  if (base) runNeteaseSearch(base, artist.name, gridEl);
  else gridEl.innerHTML = `<span class="dim">请先填写网易云 API 代理地址,或者直接用下面的百度/必应</span>`;
}

function renderArtistList() {
  const listEl = document.getElementById('artistList');
  const onlyMissing = document.getElementById('onlyMissing').checked;
  const nameFilter = document.getElementById('nameFilter').value.trim().toLowerCase();
  listEl.innerHTML = '';

  const visible = artists.filter(a => {
    if (onlyMissing && artistHasImage(a.name)) return false;
    if (nameFilter && !a.name.toLowerCase().includes(nameFilter)) return false;
    return true;
  });
  document.getElementById('artistCount').textContent = `显示 ${visible.length} / ${artists.length} 位`;

  for (const artist of visible) {
    const hasImage = artistHasImage(artist.name);
    const row = document.createElement('div');
    row.className = 'artist-row';
    const fileBase = sanitizeArtistFilename(artist.name);
    const thumbSrc = hasImage ? `/artist-image-files/${encodeURIComponent(fileBase)}.jpg?t=${Date.now()}` : '';

    row.innerHTML = `
      <img class="artist-thumb" ${thumbSrc ? `src="${thumbSrc}"` : ''} alt="" onerror="this.style.visibility='hidden'" />
      <span class="artist-name">${escapeHtml(artist.name)}</span>
      <span class="artist-albums">${artist.albumCount} 张专辑</span>
      <span class="artist-status">${hasImage ? '<span class="tag ok">已保存</span>' : '<span class="tag warn">未保存</span>'}</span>
      <button class="link-btn search-btn">${hasImage ? '更换头像' : '搜索头像'}</button>
    `;

    const candidateRow = document.createElement('div');
    candidateRow.className = 'candidate-row';

    const searchBtn = row.querySelector('.search-btn');
    searchBtn.addEventListener('click', () => {
      const isOpen = candidateRow.classList.contains('open');
      if (isOpen) {
        candidateRow.classList.remove('open');
        return;
      }
      candidateRow.classList.add('open');
      buildCandidateRowContent(artist, candidateRow, fileBase);
    });

    listEl.appendChild(row);
    listEl.appendChild(candidateRow);
  }

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="dim" style="padding:12px 6px;">没有需要处理的歌手</div>`;
  }
}
