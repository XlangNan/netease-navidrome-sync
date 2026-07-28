const STORAGE_KEY = 'netease-navidrome-sync-config';

const configFields = [
  'neteaseBase', 'neteaseUid', 'neteaseCookie',
  'navidromeUrl', 'navidromeUsername', 'navidromePassword'
];

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    configFields.forEach(f => {
      if (saved[f] !== undefined) document.getElementById(f).value = saved[f];
    });
  } catch (e) { /* ignore */ }
}

function saveConfig() {
  const data = {};
  configFields.forEach(f => { data[f] = document.getElementById(f).value; });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

loadConfig();

// 如果没有手动填过网易云 API 地址,尝试用后端提供的默认值(docker-compose 内部服务地址)预填
(async () => {
  const field = document.getElementById('neteaseBase');
  if (!field.value) {
    try {
      const cfg = await apiGet('/api/config', {});
      if (cfg.defaultNeteaseBase) field.value = cfg.defaultNeteaseBase;
    } catch (e) { /* 忽略,保持为空由用户手填 */ }
  }
})();

let selectedPlaylists = new Map(); // id -> {id, name}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function neteaseBaseValue() {
  return document.getElementById('neteaseBase').value.trim();
}

async function apiGet(path, params) {
  const usp = new URLSearchParams(params);
  const res = await fetch(`${path}?${usp.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ---------------------------------------------------------------------------
// 高级选项折叠
// ---------------------------------------------------------------------------

document.getElementById('advancedToggleBtn').addEventListener('click', () => {
  const box = document.getElementById('advancedBox');
  const btn = document.getElementById('advancedToggleBtn');
  const isOpen = box.style.display !== 'none';
  box.style.display = isOpen ? 'none' : 'block';
  btn.textContent = btn.textContent.replace(isOpen ? '▾' : '▸', isOpen ? '▸' : '▾');
});

// ---------------------------------------------------------------------------
// 歌单列表加载与勾选
// ---------------------------------------------------------------------------

document.getElementById('loadPlaylistsBtn').addEventListener('click', loadPlaylists);

async function loadPlaylists() {
  saveConfig();

  const base = neteaseBaseValue();
  const uid = document.getElementById('neteaseUid').value.trim();
  const cookie = document.getElementById('neteaseCookie').value.trim();

  if (!base || !uid) {
    alert('请先填写网易云 API 代理地址和你的 UID');
    return;
  }

  const playlistCard = document.getElementById('playlistCard');
  const statusEl = document.getElementById('playlistLoadStatus');
  const listEl = document.getElementById('playlistList');

  playlistCard.style.display = 'block';
  statusEl.textContent = '加载歌单中...';
  listEl.innerHTML = '';
  selectedPlaylists.clear();

  try {
    const params = { neteaseBase: base, uid };
    if (cookie) params.cookie = cookie;
    const { playlists } = await apiGet('/api/netease/playlists', params);
    statusEl.textContent = `共 ${playlists.length} 个歌单`;

    for (const p of playlists) {
      const row = document.createElement('label');
      row.className = 'playlist-item';
      row.innerHTML = `
        <input type="checkbox" data-id="${p.id}" data-name="${escapeHtml(p.name)}" />
        <img src="${p.coverImgUrl || ''}" alt="" />
        <span class="pl-name">${escapeHtml(p.name)}</span>
        <span class="pl-tag">${p.mine ? '创建' : '收藏'}</span>
        <span class="pl-count">${p.trackCount} 首</span>
      `;
      const checkbox = row.querySelector('input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedPlaylists.set(String(p.id), { id: p.id, name: p.name });
        } else {
          selectedPlaylists.delete(String(p.id));
        }
      });
      listEl.appendChild(row);
    }
  } catch (e) {
    statusEl.textContent = `加载歌单失败: ${e.message}`;
  }
}

document.getElementById('selectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('#playlistList input[type=checkbox]').forEach(cb => {
    cb.checked = true;
    selectedPlaylists.set(cb.dataset.id, { id: cb.dataset.id, name: cb.dataset.name });
  });
});

document.getElementById('selectNoneBtn').addEventListener('click', () => {
  document.querySelectorAll('#playlistList input[type=checkbox]').forEach(cb => { cb.checked = false; });
  selectedPlaylists.clear();
});

// ---------------------------------------------------------------------------
// 结果展示(标签页 + 每个歌单明细)
// ---------------------------------------------------------------------------

let syncedPlaylists = []; // 后端返回的每个歌单的结果
let activeDetailPlaylistId = null;
let activeTab = 'matched';

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    renderDetailTable();
  });
});

function renderSummaryTable() {
  const body = document.getElementById('playlistSummaryBody');
  body.innerHTML = '';

  for (const pl of syncedPlaylists) {
    const tr = document.createElement('tr');
    tr.className = 'playlist-summary-row';
    if (pl.error) {
      tr.innerHTML = `
        <td>${escapeHtml(pl.playlistId)}</td>
        <td colspan="3" class="dim">出错: ${escapeHtml(pl.error)}</td>
        <td></td>
      `;
    } else {
      const statusText = pl.dryRun ? '预览' : (pl.createError ? `创建失败: ${escapeHtml(pl.createError)}` : '已创建');
      tr.innerHTML = `
        <td>${escapeHtml(pl.playlistName)}</td>
        <td>${pl.total}</td>
        <td>${pl.matchedCount}</td>
        <td>${statusText}</td>
        <td><button class="link-btn view-detail-btn" data-id="${pl.playlistId}">查看明细</button></td>
      `;
      tr.querySelector('.view-detail-btn').addEventListener('click', () => {
        activeDetailPlaylistId = pl.playlistId;
        document.getElementById('resultsCard').style.display = 'block';
        renderDetailTable();
      });
    }
    body.appendChild(tr);
  }
}

function renderDetailTable() {
  const body = document.getElementById('resultsBody');
  body.innerHTML = '';

  const pl = syncedPlaylists.find(p => p.playlistId === activeDetailPlaylistId);
  if (!pl || !pl.results) {
    body.innerHTML = `<tr><td colspan="4" class="dim">请先在上方点击"查看明细"</td></tr>`;
    return;
  }

  const rows = pl.results.filter(r => r.status === activeTab);
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="dim">这里没有数据</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    const netease = r.netease;
    const artistStr = (netease.artists || []).join(' / ');

    let matchedCell = '<span class="dim">—</span>';
    let methodCell = '<span class="dim">—</span>';

    if (r.status === 'matched') {
      matchedCell = `${escapeHtml(r.matchedSong.title)} <span class="dim">/ ${escapeHtml(r.matchedSong.artist || '')}</span>`;
      const tagClass = r.method === 'exact' ? 'ok' : 'warn';
      methodCell = `<span class="tag ${tagClass}">${r.method === 'exact' ? '精确' : '模糊'}</span> ${r.score}`;
    } else if (r.status === 'error') {
      matchedCell = `<span class="tag err">出错</span>`;
      methodCell = escapeHtml(r.message || '');
    } else {
      matchedCell = `<span class="tag warn">未匹配</span>`;
    }

    tr.innerHTML = `
      <td>${escapeHtml(netease.name)}</td>
      <td class="dim">${escapeHtml(artistStr)}</td>
      <td>${matchedCell}</td>
      <td>${methodCell}</td>
    `;
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

document.getElementById('syncBtn').addEventListener('click', async () => {
  saveConfig();

  const cookie = document.getElementById('neteaseCookie').value.trim();

  const playlistIds = Array.from(selectedPlaylists.values()).map(p => p.id);
  if (playlistIds.length === 0) {
    document.getElementById('status').textContent = '请至少勾选一个歌单';
    return;
  }

  const payload = {
    neteaseBase: neteaseBaseValue(),
    cookie: cookie || undefined,
    playlistIds,
    navidromeUrl: document.getElementById('navidromeUrl').value.trim(),
    navidromeUsername: document.getElementById('navidromeUsername').value.trim(),
    navidromePassword: document.getElementById('navidromePassword').value,
    dryRun: document.getElementById('dryRun').checked
  };

  if (!payload.navidromeUrl || !payload.navidromeUsername || !payload.navidromePassword) {
    document.getElementById('status').textContent = '请填写完整的 Navidrome 配置';
    return;
  }

  const btn = document.getElementById('syncBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = `同步中(共 ${playlistIds.length} 个歌单),可能需要一点时间...`;

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      status.textContent = `失败: ${data.error || '未知错误'}`;
      btn.disabled = false;
      return;
    }

    syncedPlaylists = data.playlists.map(p => ({ ...p, playlistId: String(p.playlistId) }));
    document.getElementById('summaryCard').style.display = 'block';
    renderSummaryTable();

    if (syncedPlaylists.length > 0) {
      activeDetailPlaylistId = syncedPlaylists[0].playlistId;
      document.getElementById('resultsCard').style.display = 'block';
      renderDetailTable();
    }

    status.textContent = `同步完成,共处理 ${syncedPlaylists.length} 个歌单`;
  } catch (err) {
    status.textContent = `请求失败: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
