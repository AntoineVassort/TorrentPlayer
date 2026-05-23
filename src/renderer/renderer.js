'use strict';

let torrents = [];
let settings = {};
let players = [];
let toastTimer = null;
let pendingClipboardMagnet = null;
let filePickerTorrentId = null;
let castTargetId = null;
let searchFilters = { category: 'tout', quality: 'tout' };
let libTypeFilter = 'all';
let libSort = 'date';
let discoverCat = 'movies';
let discoverCache = {};
let torrentioTitles = [];
let torrentioCurrentItem = null;

// --- Init ---

async function init() {
  [settings, players] = await Promise.all([window.api.getSettings(), window.api.detectPlayers()]);
  applyTranslations(settings.language || 'en');
  window.api.onState(data => { torrents = data; renderList(); });
  window.api.onClipboardMagnet(magnet => showClipboardBanner(magnet));
  window.api.onUpdateAvailable(({ version, url }) => {
    let releaseUrl = url;
    document.getElementById('update-text').textContent = t('update.available', { version });
    document.getElementById('update-download-btn').onclick = () => window.api.openRelease(releaseUrl);
    document.getElementById('update-dismiss-btn').onclick = () => document.getElementById('update-banner').classList.add('hidden');
    document.getElementById('update-banner').classList.remove('hidden');
  });
  bindUI();
  await initWinCtrl();
  if (!settings.player && players.length === 0) {
    document.getElementById('no-player-banner').classList.remove('hidden');
  }
}

// --- UI bindings ---

function bindUI() {
  document.getElementById('add-btn').addEventListener('click', handleAdd);
  document.getElementById('magnet-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleAdd(); });

  document.getElementById('browse-btn').addEventListener('click', async () => {
    const p = await window.api.openTorrentDialog();
    if (p) doAdd(p);
  });

  for (const tab of document.querySelectorAll('.add-tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.add-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.add-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.remove('hidden');
      const isDiscover = tab.dataset.tab === 'discover';
    document.getElementById('torrent-list').classList.toggle('hidden', isDiscover);
    document.getElementById('empty-state').classList.toggle('hidden', isDiscover);
    if (tab.dataset.tab === 'magnet') {
      const sr = document.getElementById('search-results');
      sr.classList.add('hidden');
      sr.classList.remove('expanded');
      document.getElementById('discover-results').classList.add('hidden');
    } else if (tab.dataset.tab === 'search') {
      document.getElementById('discover-results').classList.add('hidden');
    } else if (isDiscover) {
      const sr = document.getElementById('search-results');
      sr.classList.add('hidden');
      sr.classList.remove('expanded');
      document.getElementById('discover-results').classList.remove('hidden');
      loadDiscover(discoverCat);
    }
    });
  }

  document.getElementById('search-btn').addEventListener('click', handleSearch);
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSearch(); });

  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.filter;
      document.querySelectorAll(`.filter-btn[data-filter="${group}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      searchFilters[group] = btn.dataset.value;
      if (group === 'category') {
        const isTorrentio = ['tout', 'films', 'series', 'anime'].includes(btn.dataset.value);
        document.getElementById('quality-filter-group').classList.toggle('hidden', isTorrentio);
        document.getElementById('search-results').classList.add('hidden');
      }
    });
  });

  document.querySelectorAll('[data-discover-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-discover-cat]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      discoverCat = btn.dataset.discoverCat;
      loadDiscover(discoverCat);
    });
  });

  document.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      document.getElementById('magnet-input').classList.add('drag-over');
      document.getElementById('empty-state').classList.add('drag-over');
    }
  });
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      document.getElementById('magnet-input').classList.remove('drag-over');
      document.getElementById('empty-state').classList.remove('drag-over');
    }
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    document.getElementById('magnet-input').classList.remove('drag-over');
    document.getElementById('empty-state').classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith('.torrent')) doAdd(file.path);
  });

  document.getElementById('banner-open-settings').addEventListener('click', openSettings);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('back-btn').addEventListener('click', closeSettings);
  document.getElementById('save-btn').addEventListener('click', saveSettings);
  document.getElementById('rescan-btn').addEventListener('click', rescan);
  document.getElementById('browse-player-btn').addEventListener('click', browsePlayer);
  document.getElementById('browse-dir-btn').addEventListener('click', async () => {
    const dir = await window.api.openDirDialog();
    if (dir) document.getElementById('download-dir').value = dir;
  });
  document.getElementById('player-select').addEventListener('change', e => {
    const p = players.find(pl => pl.name === e.target.value);
    if (p) {
      document.getElementById('player-path').value = p.path;
      document.getElementById('player-args').value = (p.args || []).join(' ');
    }
  });

  document.getElementById('language-select').addEventListener('change', e => {
    applyTranslations(e.target.value);
  });

  document.querySelectorAll('[data-lib-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-lib-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      libTypeFilter = btn.dataset.libFilter;
      renderHistory();
    });
  });
  document.getElementById('lib-sort').addEventListener('change', e => {
    libSort = e.target.value;
    renderHistory();
  });

  document.getElementById('history-btn').addEventListener('click', openHistory);
  document.getElementById('history-back-btn').addEventListener('click', closeHistory);

  document.getElementById('modal-close').addEventListener('click', closeFilePicker);
  document.getElementById('file-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('file-modal')) closeFilePicker();
  });

  document.getElementById('cast-modal-close').addEventListener('click', closeCastModal);
  document.getElementById('cast-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('cast-modal')) closeCastModal();
  });

  document.getElementById('clipboard-add').addEventListener('click', () => {
    if (pendingClipboardMagnet) doAdd(pendingClipboardMagnet);
    hideClipboardBanner();
  });
  document.getElementById('clipboard-dismiss').addEventListener('click', hideClipboardBanner);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('cast-modal').classList.contains('hidden')) closeCastModal();
    else if (!document.getElementById('file-modal').classList.contains('hidden')) closeFilePicker();
    else if (!document.getElementById('clipboard-banner').classList.contains('hidden')) hideClipboardBanner();
    else if (!document.getElementById('history-view').classList.contains('hidden')) closeHistory();
    else if (!document.getElementById('settings-view').classList.contains('hidden')) closeSettings();
  });
}

// --- Discover ---

async function loadDiscover(cat) {
  const grid = document.getElementById('discover-results');
  if (discoverCache[cat]) { renderDiscoverGrid(discoverCache[cat]); return; }
  grid.innerHTML = `<div class="discover-loading">${t('discover.loading')}</div>`;
  try {
    const items = await window.api.discoverFetch(cat);
    discoverCache[cat] = items;
    renderDiscoverGrid(items);
  } catch {
    grid.innerHTML = `<div class="discover-empty">${t('discover.error')}</div>`;
  }
}

function renderDiscoverGrid(items) {
  const grid = document.getElementById('discover-results');
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = `<div class="discover-empty">${t('discover.unavailable')}</div>`;
    return;
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'discover-card';
    const year = item.year || '';
    const rating = item.rating ? `★ ${item.rating}` : '';
    const meta = [year, rating].filter(Boolean).join(' · ');
    if (!item.posterUrl) card.classList.add('no-poster');
    card.innerHTML = `
      <div class="discover-poster">
        ${item.posterUrl ? `<img src="${item.posterUrl}" alt="" loading="lazy">` : ''}
      </div>
      <div class="discover-info">
        <span class="discover-title">${item.title}</span>
        ${meta ? `<span class="discover-meta">${meta}</span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => {
      document.querySelector('[data-tab="search"]').click();
      document.getElementById('search-input').value = item.title;
      handleSearch();
    });
    grid.appendChild(card);
  }
}

// --- Add ---

async function handleSearch() {
  const input = document.getElementById('search-input');
  const query = input.value.trim();
  if (!query) return;

  const category = searchFilters.category;
  if (category === 'tout')   { handleTorrentioSearch(query, 'all');    return; }
  if (category === 'films')  { handleTorrentioSearch(query, 'movie');  return; }
  if (category === 'series') { handleTorrentioSearch(query, 'series'); return; }
  if (category === 'anime')  { handleTorrentioSearch(query, 'anime');  return; }

  const resultsEl = document.getElementById('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.textContent = '';

  const status = document.createElement('div');
  status.className = 'search-status';
  status.textContent = t('status.searching');
  resultsEl.appendChild(status);

  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const results = await window.api.searchTorrents(query, searchFilters);
    resultsEl.textContent = '';
    if (!results.length) {
      const el = document.createElement('div');
      el.className = 'search-status';
      el.textContent = t('status.noResults');
      resultsEl.appendChild(el);
    } else {
      for (const r of results) resultsEl.appendChild(renderResult(r));
    }
  } catch {
    resultsEl.textContent = '';
    const el = document.createElement('div');
    el.className = 'search-status';
    el.textContent = t('status.networkError');
    resultsEl.appendChild(el);
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn.search');
  }
}

function extractQuality(name) {
  if (/2160p|4k|uhd/i.test(name)) return '4K';
  if (/1080p|1080i/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  if (/480p/i.test(name)) return '480p';
  return null;
}

const CLEAN_RE = /\b(2160p|1080p|1080i|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|x264|x265|h264|h265|hevc|avc|xvid|aac|ac3|dts|yify|rarbg|proper|repack|hdr|sdr|10bit|remux|extended|theatrical)\b.*/gi;
function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(CLEAN_RE, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function seedsClass(n) {
  if (n >= 100) return 'seeds-high';
  if (n >= 20)  return 'seeds-mid';
  return 'seeds-low';
}

function renderResult(r) {
  const quality   = extractQuality(r.name);
  const title     = cleanTitle(r.name);

  const row = document.createElement('div');
  row.className = 'search-row';
  row.title = r.name;
  row.innerHTML = `
    <div class="search-row-top">
      <span class="search-name">${title}</span>
      ${quality ? `<span class="search-quality q-${quality.toLowerCase()}">${quality}</span>` : ''}
    </div>
    <div class="search-raw-name">${r.name}</div>
    <div class="search-row-bottom">
      <span class="search-source search-source-${(r.source||'').toLowerCase()}">${r.source||''}</span>
      <span class="search-seeds ${seedsClass(r.seeders)}">↑ ${r.seeders}</span>
      <span class="search-leechers">↓ ${r.leechers}</span>
      <span class="search-size">${fmtSize(r.size)}</span>
    </div>
  `;
  row.addEventListener('click', () => doAdd(r.magnet));
  return row;
}

// --- Torrentio ---

async function handleTorrentioSearch(query, type) {
  torrentioTitles = [];
  torrentioCurrentItem = null;
  const resultsEl = document.getElementById('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.classList.add('expanded');
  resultsEl.innerHTML = `<div class="search-status">${t('status.searching')}</div>`;

  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const results = await window.api.torrentioSearch(query, type);
    if (!results.length) {
      resultsEl.innerHTML = `<div class="search-status">${t('status.noResults')}</div>`;
    } else {
      torrentioTitles = results;
      renderTorrentioTitles(results, type);
    }
  } catch {
    resultsEl.innerHTML = `<div class="search-status">${t('status.networkError')}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn.search');
  }
}

function renderTorrentioTitles(results, type) {
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'torrentio-grid';
  for (const item of results) {
    const card = document.createElement('div');
    card.className = 'torrentio-card';
    const meta = [item.year, item.rating ? `★ ${item.rating}` : null].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="torrentio-poster">
        ${item.poster ? `<img src="${item.poster}" alt="" loading="lazy">` : '<div class="torrentio-poster-empty">🎬</div>'}
      </div>
      <div class="torrentio-card-info">
        <div class="torrentio-card-title" title="${item.title}">${item.title}</div>
        ${meta ? `<div class="torrentio-card-meta">${meta}</div>` : ''}
      </div>
    `;
    card.addEventListener('click', () => selectTorrentioTitle(item));
    grid.appendChild(card);
  }
  resultsEl.appendChild(grid);
}

function selectTorrentioTitle(item) {
  torrentioCurrentItem = item;
  if (item.type === 'movie') {
    fetchAndRenderTorrentioStreams(item.id, 'movie', null, null, item);
  } else {
    renderTorrentioEpPicker(item);
  }
}

function renderTorrentioEpPicker(item) {
  const resultsEl = document.getElementById('search-results');
  const isAnime = item.type === 'anime';
  resultsEl.innerHTML = `
    <div class="torrentio-back">
      <button id="torrentio-back-btn">${t('torrentio.back')}</button>
      <div class="torrentio-stream-header-info">
        ${item.poster ? `<img class="torrentio-stream-poster" src="${item.poster}" alt="">` : ''}
        <div>
          <div class="torrentio-stream-title">${item.title}</div>
          ${item.year ? `<div class="torrentio-stream-year">${item.year}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="torrentio-ep-picker">
      ${!isAnime ? `<label>${t('torrentio.season')}</label><input id="t-season" type="number" min="1" value="1">` : ''}
      <label>${t('torrentio.episode')}</label><input id="t-episode" type="number" min="1" value="1">
      <button id="t-go-btn">${t('torrentio.go')}</button>
    </div>
    <div id="torrentio-streams-area"></div>
  `;
  document.getElementById('torrentio-back-btn').addEventListener('click', () => {
    renderTorrentioTitles(torrentioTitles, item.type);
  });
  document.getElementById('t-go-btn').addEventListener('click', () => {
    const season = isAnime ? null : parseInt(document.getElementById('t-season').value) || 1;
    const episode = parseInt(document.getElementById('t-episode').value) || 1;
    fetchAndRenderTorrentioStreams(item.id, item.type, season, episode, item);
  });
}

async function fetchAndRenderTorrentioStreams(id, type, season, episode, item) {
  const container = type === 'movie'
    ? document.getElementById('search-results')
    : document.getElementById('torrentio-streams-area');

  if (type === 'movie') {
    container.innerHTML = `
      <div class="torrentio-back">
        <button id="torrentio-back-btn">${t('torrentio.back')}</button>
        <div class="torrentio-stream-header-info">
          ${item.poster ? `<img class="torrentio-stream-poster" src="${item.poster}" alt="">` : ''}
          <div>
            <div class="torrentio-stream-title">${item.title}</div>
            ${item.year ? `<div class="torrentio-stream-year">${item.year}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>
    `;
    document.getElementById('torrentio-back-btn').addEventListener('click', () => {
      renderTorrentioTitles(torrentioTitles, item.type);
    });
  } else {
    container.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
  }

  try {
    const streams = await window.api.torrentioStreams(id, type, season, episode);
    if (type === 'movie') {
      const loadingEl = container.querySelector('.torrentio-loading');
      if (loadingEl) loadingEl.remove();
    } else {
      container.innerHTML = '';
    }
    if (!streams.length) {
      container.insertAdjacentHTML('beforeend', `<div class="torrentio-empty">${t('torrentio.noStreams')}</div>`);
      return;
    }
    for (const s of streams) {
      const row = document.createElement('div');
      row.className = 'torrentio-stream';
      const qualityClass = s.quality ? `q-${s.quality.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
      row.innerHTML = `
        ${s.quality ? `<span class="search-quality ${qualityClass}">${s.quality}</span>` : ''}
        <span class="torrentio-stream-name" title="${s.fileName}">${s.fileName}</span>
        ${s.seeders != null ? `<span class="search-seeds ${seedsClass(s.seeders)}">↑ ${s.seeders}</span>` : ''}
        ${s.size ? `<span class="torrentio-stream-size">${s.size}</span>` : ''}
      `;
      row.addEventListener('click', () => doAdd(s.magnet));
      container.appendChild(row);
    }
  } catch {
    container.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
  }
}

async function handleAdd() {
  const input = document.getElementById('magnet-input');
  const val = input.value.trim();
  if (!val) return;
  if (!val.startsWith('magnet:') && !val.endsWith('.torrent')) {
    toast(t('toast.invalidMagnet'), true);
    return;
  }
  input.value = '';
  doAdd(val);
}

async function doAdd(source) {
  try {
    const r = await window.api.addTorrent(source);
    toast(t('toast.added', { name: r.name }));
    if (r.videoFiles?.length > 1) openFilePicker(r.id, r.videoFiles);
  } catch (err) {
    toast(err.message, true);
  }
}

// --- Render ---

function renderList() {
  if (!document.getElementById('discover-results').classList.contains('hidden')) return;
  if (document.getElementById('search-results').classList.contains('expanded')) return;
  const list = document.getElementById('torrent-list');
  const empty = document.getElementById('empty-state');
  empty.classList.toggle('hidden', torrents.length > 0);

  for (const card of [...list.querySelectorAll('.card')]) {
    if (!torrents.find(t => t.id === card.dataset.id)) card.remove();
  }
  for (const t of torrents) {
    const existing = list.querySelector(`[data-id="${t.id}"]`);
    if (existing) updateCard(existing, t);
    else list.appendChild(createCard(t));
  }
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB/s`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
}

function fmtSize(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtTime(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtETA(ms) {
  if (!ms || ms <= 0 || !isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const locale = getLang() === 'fr' ? 'fr-FR' : 'en-US';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

function speedGraph(history) {
  if (!history || history.length < 2) return '<svg width="60" height="20"></svg>';
  const max = Math.max(...history, 1);
  const w = 60, h = 20;
  const pts = history.map((v, i) =>
    `${(i / (history.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`
  ).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function createCard(t) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = t.id;
  card.innerHTML = `
    <img class="card-poster hidden" alt="">
    <div class="card-body">
      <div class="card-top">
        <span class="drag-handle" title="${t('drag.handle')}">⠿</span>
        <span class="card-name" title="${t.name}">${t.name}</span>
        <span class="queue-badge hidden"></span>
        <span class="card-size">${fmtSize(t.size)}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill"></div></div>
      <div class="card-stats">
        <span class="pct"></span>
        <span class="downloaded"></span>
        <span class="eta"></span>
        <span class="dl"></span>
        <span class="peers"></span>
        <span class="sub-badge hidden">ST</span>
        <span class="graph"></span>
      </div>
      <div class="playback-bar hidden"></div>
      <div class="card-actions">
        <button class="btn-files hidden" title="${t('btn.chooseFile')}">📂</button>
        <button class="btn-play">${t('card.play')}</button>
        <button class="btn-local hidden">${t('card.playLocal')}</button>
        <button class="btn-cast hidden">📺</button>
        <button class="btn-seed hidden">⏸ Seeding</button>
        <button class="btn-remove">✕</button>
      </div>
    </div>
  `;

  card.querySelector('.btn-play').addEventListener('click', () => play(t.id));
  card.querySelector('.btn-local').addEventListener('click', () => playLocal(t.id));
  card.querySelector('.btn-cast').addEventListener('click', () => openCastPicker(t.id));
  card.querySelector('.btn-seed').addEventListener('click', () => stopSeed(t.id));
  card.querySelector('.btn-remove').addEventListener('click', () => remove(t.id, card));
  card.querySelector('.btn-files').addEventListener('click', () => {
    const state = torrents.find(x => x.id === t.id);
    if (state?.videoFiles?.length > 1) openFilePicker(t.id, state.videoFiles);
  });

  // Drag-and-drop for queue reordering
  card.draggable = true;
  card.addEventListener('dragstart', e => {
    if (!e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('dragging'), 0);
    }
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/plain') && !e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    }
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', e => {
    if (e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    card.classList.remove('drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (!fromId || fromId === t.id) return;

    const list = document.getElementById('torrent-list');
    const fromCard = list.querySelector(`[data-id="${fromId}"]`);
    if (!fromCard) return;

    const cards = [...list.querySelectorAll('.card')];
    const fromIdx = cards.indexOf(fromCard);
    const toIdx = cards.indexOf(card);
    if (fromIdx < toIdx) card.after(fromCard);
    else card.before(fromCard);

    const newOrder = [...list.querySelectorAll('.card')].map(c => c.dataset.id);
    window.api.reorderQueue(newOrder);
  });

  updateCard(card, t);
  return card;
}

function updateCard(card, t) {
  // Poster
  const poster = card.querySelector('.card-poster');
  if (t.meta?.poster) {
    poster.src = t.meta.poster;
    poster.classList.remove('hidden');
  } else {
    poster.classList.add('hidden');
  }

  const pct = (t.progress * 100).toFixed(1);
  card.querySelector('.progress-fill').style.width = `${pct}%`;
  card.querySelector('.progress-fill').classList.toggle('done', t.done);
  card.querySelector('.pct').textContent = t.done ? t('card.done') : `${pct}%`;
  card.querySelector('.downloaded').textContent = t.done ? '' : fmtSize(t.downloaded);
  card.querySelector('.eta').textContent = t.done ? '' : fmtETA(t.timeRemaining);
  card.querySelector('.dl').textContent = t.done ? '' : `↓ ${fmt(t.downloadSpeed)}`;

  // Peers — show upload when done + seeding
  const peersEl = card.querySelector('.peers');
  if (t.done && !t.paused && t.uploadSpeed > 0) {
    peersEl.textContent = `↑ ${fmt(t.uploadSpeed)} · ${t.numPeers}p`;
  } else {
    peersEl.textContent = `${t.numPeers} peers`;
  }

  card.querySelector('.sub-badge').classList.toggle('hidden', !t.hasSubtitle);
  card.querySelector('.graph').innerHTML = t.done ? '' : speedGraph(t.speedHistory);

  // Queue badge
  const badge = card.querySelector('.queue-badge');
  const showQueue = torrents.filter(x => !x.done).length > 1;
  if (showQueue && t.queuePos >= 0 && !t.done) {
    badge.textContent = `#${t.queuePos + 1}`;
    badge.classList.remove('hidden');
    badge.classList.toggle('queue-badge-first', t.queuePos === 0);
  } else {
    badge.classList.add('hidden');
  }

  const filesBtn = card.querySelector('.btn-files');
  filesBtn.classList.toggle('hidden', !t.videoFiles?.length);

  const localBtn = card.querySelector('.btn-local');
  localBtn.classList.toggle('hidden', !t.done);

  const castBtn = card.querySelector('.btn-cast');
  castBtn.classList.toggle('hidden', !t.ready);

  const seedBtn = card.querySelector('.btn-seed');
  seedBtn.classList.toggle('hidden', !t.done);
  if (t.done) {
    seedBtn.textContent = t.paused ? t('card.seeder') : t('card.seeding');
    seedBtn.classList.toggle('active', !t.paused);
  }

  // Playback / casting bar
  const playbackBar = card.querySelector('.playback-bar');
  if (t.casting) {
    playbackBar.textContent = t('cast.inProgress', { name: t.casting });
    playbackBar.classList.remove('hidden');
  } else if (t.playback) {
    const dur = t.playback.duration > 0 ? ` / ${fmtTime(t.playback.duration)}` : '';
    playbackBar.textContent = t('card.playing', { pos: fmtTime(t.playback.pos), dur });
    playbackBar.classList.remove('hidden');
  } else {
    playbackBar.classList.add('hidden');
  }

  const playBtn = card.querySelector('.btn-play');
  if (!t.ready) {
    playBtn.textContent = t('card.buffering');
    playBtn.classList.add('buffering');
  } else if (t.resumePos > 5) {
    playBtn.textContent = `↩ ${fmtTime(t.resumePos)}`;
    playBtn.classList.remove('buffering');
  } else {
    playBtn.textContent = t('card.play');
    playBtn.classList.remove('buffering');
  }
}

// --- Actions ---

async function play(id) {
  try { await window.api.playTorrent(id); }
  catch (err) { toast(err.message, true); }
}

async function playLocal(id) {
  try { await window.api.playLocal(id); }
  catch (err) { toast(err.message, true); }
}

async function stopSeed(id) {
  try { await window.api.stopSeed(id); }
  catch (err) { toast(err.message, true); }
}

async function remove(id, card) {
  card.classList.add('removing');
  try { await window.api.removeTorrent(id); }
  catch (err) { card.classList.remove('removing'); toast(err.message, true); }
}

// --- Chromecast ---

async function openCastPicker(id) {
  castTargetId = id;
  const modal = document.getElementById('cast-modal');
  const scanning = document.getElementById('cast-scanning');
  const deviceList = document.getElementById('device-list');
  const castEmpty = document.getElementById('cast-empty');

  scanning.classList.remove('hidden');
  deviceList.classList.add('hidden');
  castEmpty.classList.add('hidden');
  deviceList.textContent = '';
  modal.classList.remove('hidden');

  scanning.textContent = t('cast.scanning');
  try {
    const devices = await window.api.discoverDevices();
    scanning.classList.add('hidden');
    if (!devices.length) {
      castEmpty.textContent = t('cast.noDevices');
      castEmpty.classList.remove('hidden');
    } else {
      for (const d of devices) {
        const item = document.createElement('button');
        item.className = 'file-item';
        item.innerHTML = `<span class="file-item-name">📺 ${d.name}</span><span class="file-item-size">${d.host}</span>`;
        item.addEventListener('click', async () => {
          closeCastModal();
          try {
            await window.api.castToDevice(castTargetId, d.host);
            toast(t('cast.started', { name: d.name }));
          } catch (err) {
            toast(err.message, true);
          }
        });
        deviceList.appendChild(item);
      }
      deviceList.classList.remove('hidden');
    }
  } catch (err) {
    scanning.classList.add('hidden');
    castEmpty.textContent = t('cast.error', { msg: err.message });
    castEmpty.classList.remove('hidden');
  }
}

function closeCastModal() {
  document.getElementById('cast-modal').classList.add('hidden');
  castTargetId = null;
}

// --- File picker ---

function openFilePicker(torrentId, files) {
  filePickerTorrentId = torrentId;
  const list = document.getElementById('file-list');
  list.innerHTML = '';
  for (const f of files) {
    const item = document.createElement('button');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-item-name">${f.name}</span><span class="file-item-size">${fmtSize(f.size)}</span>`;
    item.addEventListener('click', async () => {
      try {
        await window.api.changeFile(torrentId, f.index);
        toast(t('toast.file', { name: f.name }));
      } catch (err) { toast(err.message, true); }
      closeFilePicker();
    });
    list.appendChild(item);
  }
  document.getElementById('file-modal').classList.remove('hidden');
}

function closeFilePicker() {
  document.getElementById('file-modal').classList.add('hidden');
  filePickerTorrentId = null;
}

// --- History ---

async function openHistory() {
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('history-view').classList.remove('hidden');
  await renderHistory();
}

function closeHistory() {
  document.getElementById('history-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
}

function isSeries(name) {
  return /\b[Ss]\d{1,2}[Ee]\d{1,2}\b/.test(name || '');
}

async function renderHistory() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('history-empty');
  grid.textContent = '';

  let history = [];
  try { history = await window.api.getHistory(); } catch {}

  const activeDone = torrents.filter(t => t.done);
  let items = [
    ...activeDone.map(t => ({
      type: 'active', id: t.id,
      poster: t.meta?.poster || null,
      title: t.meta?.title || t.name,
      year: t.meta?.year || null,
      rating: t.meta?.rating || null,
      name: t.name,
      watchedAt: null,
    })),
    ...history.map(e => ({ type: 'history', ...e })),
  ];

  if (libTypeFilter === 'movies') items = items.filter(i => !isSeries(i.name));
  else if (libTypeFilter === 'series') items = items.filter(i => isSeries(i.name));

  if (libSort === 'title') {
    items.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
  } else if (libSort === 'rating') {
    items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  empty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'lib-card';

    const posterHTML = item.poster
      ? `<img class="lib-poster" src="${item.poster}" alt="">`
      : `<div class="lib-no-poster"></div>`;

    const ratingBadge = item.rating ? `<div class="lib-rating">⭐ ${item.rating}</div>` : '';
    const activeBadge = item.type === 'active' ? `<div class="lib-active-badge">✓</div>` : '';
    const yearLine    = item.year ? `<div class="lib-info-year">${item.year}</div>` : '';

    const actionBtn = item.type === 'active'
      ? `<button class="btn-lib-play">${t('card.play')}</button>`
      : (item.magnet ? `<button class="btn-lib-redownload">↩</button>` : '');

    card.innerHTML = `
      ${posterHTML}
      ${ratingBadge}
      ${activeBadge}
      <div class="lib-info">
        <div class="lib-info-title">${item.title || item.name}</div>
        ${yearLine}
      </div>
      <div class="lib-overlay">
        <div class="lib-overlay-actions">
          ${actionBtn}
          <button class="btn-lib-remove">✕</button>
        </div>
      </div>
    `;

    if (item.type === 'active') {
      card.querySelector('.btn-lib-play')?.addEventListener('click', e => {
        e.stopPropagation();
        window.api.playTorrent(item.id);
      });
      card.querySelector('.btn-lib-remove').addEventListener('click', e => {
        e.stopPropagation();
        window.api.removeTorrent(item.id);
        card.remove();
        if (!grid.children.length) empty.classList.remove('hidden');
      });
    } else {
      card.querySelector('.btn-lib-redownload')?.addEventListener('click', e => {
        e.stopPropagation();
        doAdd(item.magnet);
        closeHistory();
        toast(t('toast.added', { name: item.name }));
      });
      card.querySelector('.btn-lib-remove').addEventListener('click', async e => {
        e.stopPropagation();
        await window.api.removeHistory(item.id);
        card.remove();
        if (!grid.children.length) empty.classList.remove('hidden');
      });
    }

    grid.appendChild(card);

    if (!item.poster && item.type === 'history') {
      window.api.fetchHistoryMeta(item.id, item.name).then(meta => {
        if (!meta?.poster) return;
        const placeholder = card.querySelector('.lib-no-poster');
        if (placeholder) {
          const img = document.createElement('img');
          img.className = 'lib-poster';
          img.src = meta.poster;
          img.alt = '';
          placeholder.replaceWith(img);
        }
        if (meta.title) card.querySelector('.lib-info-title').textContent = meta.title;
        if (meta.year && !card.querySelector('.lib-info-year')) {
          const y = document.createElement('div');
          y.className = 'lib-info-year';
          y.textContent = meta.year;
          card.querySelector('.lib-info').appendChild(y);
        }
        if (meta.rating && !card.querySelector('.lib-rating')) {
          const r = document.createElement('div');
          r.className = 'lib-rating';
          r.textContent = `⭐ ${meta.rating}`;
          card.appendChild(r);
        }
      }).catch(() => {});
    }
  }
}

// --- Clipboard banner ---

function showClipboardBanner(magnet) {
  pendingClipboardMagnet = magnet;
  const short = magnet.slice(0, 60) + '...';
  document.getElementById('clipboard-text').textContent = t('clipboard.detected', { short });
  document.getElementById('clipboard-banner').classList.remove('hidden');
}

function hideClipboardBanner() {
  document.getElementById('clipboard-banner').classList.add('hidden');
  pendingClipboardMagnet = null;
}

// --- Settings ---

function openSettings() {
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('settings-view').classList.remove('hidden');
  populateSettings();
}

function closeSettings() {
  document.getElementById('settings-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
}

function populateSettings() {
  const select = document.getElementById('player-select');
  select.innerHTML = '';
  for (const p of players) select.add(new Option(`${p.name}  —  ${p.path}`, p.name));
  if (!players.length) { const o = new Option(t('player.none'), ''); o.disabled = true; select.add(o); }

  document.getElementById('language-select').value = settings.language || 'en';
  document.getElementById('download-dir').value = settings.downloadDir || '';
  document.getElementById('delete-after-play').checked = !!settings.deleteAfterPlay;
  document.getElementById('max-download').value = settings.maxDownload || '';
  document.getElementById('max-upload').value = settings.maxUpload || '';
  document.getElementById('torrentio-url').value = settings.torrentioUrl || '';

  if (settings.player) {
    const match = players.find(p => p.path === settings.player.path);
    if (match) {
      select.value = match.name;
      document.getElementById('player-path').value = match.path;
      document.getElementById('player-args').value = (settings.player.args || []).join(' ');
    } else {
      if (!select.querySelector('option[value="__custom__"]')) select.add(new Option(t('player.custom'), '__custom__'));
      select.value = '__custom__';
      document.getElementById('player-path').value = settings.player.path;
      document.getElementById('player-args').value = (settings.player.args || []).join(' ');
    }
  } else if (players.length) {
    select.value = players[0].name;
    document.getElementById('player-path').value = players[0].path;
    document.getElementById('player-args').value = (players[0].args || []).join(' ');
  }
}

async function rescan() {
  players = await window.api.detectPlayers();
  populateSettings();
  toast(t('player.detected', { count: players.length }));
}

async function browsePlayer() {
  const p = await window.api.openPlayerDialog();
  if (!p) return;
  document.getElementById('player-path').value = p;
  document.getElementById('player-args').value = '';
  const select = document.getElementById('player-select');
  if (!select.querySelector('option[value="__custom__"]')) select.add(new Option(t('player.custom'), '__custom__'));
  select.value = '__custom__';
}

async function saveSettings() {
  const playerPath = document.getElementById('player-path').value.trim();
  const argsStr = document.getElementById('player-args').value.trim();
  const args = argsStr ? argsStr.split(/\s+/) : [];
  const downloadDir = document.getElementById('download-dir').value.trim();
  const deleteAfterPlay = document.getElementById('delete-after-play').checked;
  const maxDl = parseInt(document.getElementById('max-download').value) || 0;
  const maxUl = parseInt(document.getElementById('max-upload').value) || 0;
  const language = document.getElementById('language-select').value;
  const torrentioUrl = document.getElementById('torrentio-url').value.trim();

  settings = {
    ...settings,
    player: playerPath ? { path: playerPath, args } : null,
    downloadDir: downloadDir || null,
    deleteAfterPlay,
    maxDownload: maxDl || null,
    maxUpload: maxUl || null,
    language,
    torrentioUrl: torrentioUrl || null,
  };
  await window.api.saveSettings(settings);
  toast(t('toast.settingsSaved'));
  closeSettings();
}

// --- Toast ---

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// --- Window controls ---

async function initWinCtrl() {
  const btnMax = document.getElementById('btn-maximize');
  const setMaxIcon = (isMax) => { btnMax.innerHTML = isMax ? '&#x29C9;' : '&#x25A1;'; };

  setMaxIcon(await window.api.isMaximized());
  window.api.onMaximize(setMaxIcon);
  window.api.onUnmaximize(setMaxIcon);

  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click',    () => window.api.close());
}

init();
