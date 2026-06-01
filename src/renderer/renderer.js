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
let torrentioBackFn = null;
let searchDebounceTimer = null;
const streamCache = new Map();
const pendingTorrents = new Map();

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ICONS = {
  grip: `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="opacity:0.5"><circle cx="3" cy="2.5" r="1.5"/><circle cx="7" cy="2.5" r="1.5"/><circle cx="3" cy="7" r="1.5"/><circle cx="7" cy="7" r="1.5"/><circle cx="3" cy="11.5" r="1.5"/><circle cx="7" cy="11.5" r="1.5"/></svg>`,
  files: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  cast: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>`,
  remove: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

// --- Init ---

async function init() {
  [settings, players] = await Promise.all([window.api.getSettings(), window.api.detectPlayers()]);
  applyTranslations(settings.language || 'en');
  window.api.onState(data => { torrents = data; renderList(); updateGlobalStats(); });
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
      torrentioBackFn = null;
      const sr = document.getElementById('search-results');
      sr.classList.add('hidden');
      sr.classList.remove('expanded');
      document.getElementById('discover-results').classList.remove('hidden');
      loadDiscover(discoverCat);
    }
    });
  }

  document.getElementById('search-btn').addEventListener('click', handleSearch);
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchDebounceTimer); handleSearch(); } });
  document.getElementById('search-input').addEventListener('input', () => {
    const query = document.getElementById('search-input').value.trim();
    clearTimeout(searchDebounceTimer);
    if (query.length < 2) return;
    searchDebounceTimer = setTimeout(() => handleSearch(), 600);
  });

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

  document.getElementById('detail-back-btn').addEventListener('click', closeDetailView);

  document.getElementById('about-btn').addEventListener('click', openAbout);
  document.getElementById('about-modal-close').addEventListener('click', closeAbout);
  document.getElementById('about-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('about-modal')) closeAbout();
  });
  document.getElementById('about-github-link').addEventListener('click', e => {
    e.preventDefault();
    window.api.openExternal('https://github.com/AntoineVassort/TorrentPlayer');
  });

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
    if (e.key === 'Escape') {
      if (!document.getElementById('cast-modal').classList.contains('hidden')) { closeCastModal(); return; }
      if (!document.getElementById('file-modal').classList.contains('hidden')) { closeFilePicker(); return; }
      if (!document.getElementById('clipboard-banner').classList.contains('hidden')) { hideClipboardBanner(); return; }
      if (!document.getElementById('about-modal').classList.contains('hidden')) { closeAbout(); return; }
      if (!document.getElementById('detail-view').classList.contains('hidden')) { closeDetailView(); return; }
      if (!document.getElementById('history-view').classList.contains('hidden')) { closeHistory(); return; }
      if (!document.getElementById('settings-view').classList.contains('hidden')) { closeSettings(); return; }
      const sr = document.getElementById('search-results');
      if (sr.classList.contains('expanded')) {
        sr.classList.add('hidden');
        sr.classList.remove('expanded');
        return;
      }
    }

    if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !isInputActive())) {
      e.preventDefault();
      document.querySelector('.add-tab[data-tab="search"]').click();
      document.getElementById('search-input').focus();
    }
  });
}

function isInputActive() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

// --- Discover ---

function renderDiscoverSkeleton() {
  const grid = document.getElementById('discover-results');
  grid.innerHTML = Array(12).fill(0).map(() => `
    <div class="discover-card skel-card">
      <div class="discover-poster"><div class="skel-poster skel-block"></div></div>
      <div class="discover-info">
        <div class="skel-line w80 skel-block"></div>
        <div class="skel-line w55 skel-block"></div>
      </div>
    </div>
  `).join('');
}

async function loadDiscover(cat) {
  const grid = document.getElementById('discover-results');
  if (discoverCache[cat]) { renderDiscoverGrid(discoverCache[cat]); return; }
  renderDiscoverSkeleton();
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
        ${item.posterUrl ? `<img src="${esc(item.posterUrl)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="discover-info">
        <span class="discover-title">${esc(item.title)}</span>
        ${meta ? `<span class="discover-meta">${esc(meta)}</span>` : ''}
      </div>
    `;
    if (item.type === 'movie' && item.imdbId) {
      const overlay = document.createElement('div');
      overlay.className = 'discover-quality-overlay';
      card.querySelector('.discover-poster').appendChild(overlay);
      let fetched = false;
      card.addEventListener('mouseenter', () => {
        if (fetched) return;
        fetched = true;
        initCardQualityOverlay(item, overlay);
      });
    }
    card.addEventListener('click', () => openDetailView(item));
    grid.appendChild(card);
  }
}

// --- Add ---

function handleSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  const category = searchFilters.category;
  if (category === 'films')  return handleTorrentioSearch(query, 'movie');
  if (category === 'series') return handleTorrentioSearch(query, 'series');
  if (category === 'anime')  return handleTorrentioSearch(query, 'anime');
  handleTorrentioSearch(query, 'all');
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
      <span class="search-name">${esc(title)}</span>
      ${quality ? `<span class="search-quality q-${quality.toLowerCase()}">${esc(quality)}</span>` : ''}
    </div>
    <div class="search-raw-name">${esc(r.name)}</div>
    <div class="search-row-bottom">
      <span class="search-source search-source-${esc((r.source||'').toLowerCase())}">${esc(r.source||'')}</span>
      <span class="search-seeds ${seedsClass(r.seeders)}">↑ ${Number(r.seeders)}</span>
      <span class="search-leechers">↓ ${Number(r.leechers)}</span>
      <span class="search-size">${fmtSize(r.size)}</span>
    </div>
  `;
  row.addEventListener('click', () => doAdd(r.magnet));
  return row;
}

// --- Torrentio ---

function torrentioGoBack(type) {
  if (torrentioBackFn) {
    const fn = torrentioBackFn;
    torrentioBackFn = null;
    fn();
  } else {
    renderTorrentioTitles(torrentioTitles, type);
  }
}

function closeDetailView() {
  document.getElementById('detail-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
}

function openDetailView(item) {
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('detail-view').classList.remove('hidden');

  const posterUrl = item.posterUrl || null;
  const bg = document.getElementById('detail-hero-bg');
  bg.style.backgroundImage = posterUrl ? `url("${posterUrl}")` : '';
  const posterImg = document.getElementById('detail-poster-img');
  if (posterUrl) {
    posterImg.src = posterUrl;
    posterImg.style.display = '';
  } else {
    posterImg.style.display = 'none';
  }
  document.getElementById('detail-title-text').textContent = item.title;
  const parts = [item.year, item.rating ? `★ ${item.rating}` : null].filter(Boolean);
  document.getElementById('detail-meta-text').textContent = parts.join(' · ');

  document.getElementById('detail-ep-picker').classList.add('hidden');
  document.getElementById('detail-streams-area').innerHTML = '';

  if (item.imdbId) {
    if (item.type === 'movie') {
      fetchAndRenderDetailStreams(item.imdbId, 'movie', null, null);
    } else {
      setupDetailEpPicker({ id: item.imdbId, type: item.type });
    }
  } else {
    const area = document.getElementById('detail-streams-area');
    area.innerHTML = `<div class="torrentio-loading">${t('status.searching')}</div>`;
    window.api.torrentioSearch(item.title, 'anime').then(results => {
      area.innerHTML = '';
      if (results.length) setupDetailEpPicker(results[0]);
      else area.innerHTML = `<div class="torrentio-empty">${t('status.noResults')}</div>`;
    }).catch(() => {
      area.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
    });
  }
}

function setupDetailEpPicker(item) {
  const isAnime = item.type === 'anime';
  document.getElementById('detail-season-group').classList.toggle('hidden', isAnime);
  document.getElementById('detail-ep-picker').classList.remove('hidden');

  const oldBtn = document.getElementById('detail-go-btn');
  const newBtn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(newBtn);
  newBtn.addEventListener('click', () => {
    const season = isAnime ? null : parseInt(document.getElementById('detail-season').value) || 1;
    const episode = parseInt(document.getElementById('detail-episode').value) || 1;
    fetchAndRenderDetailStreams(item.id, item.type, season, episode);
  });
}

async function fetchAndRenderDetailStreams(id, type, season, episode) {
  const container = document.getElementById('detail-streams-area');
  container.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
  try {
    const streams = await window.api.torrentioStreams(id, type, season, episode);
    container.innerHTML = '';
    renderQualityShortcuts(container, streams);
    renderStreamRows(container, streams);
  } catch {
    container.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
  }
}

async function handleTorrentioSearch(query, type) {
  torrentioTitles = [];
  torrentioCurrentItem = null;
  const resultsEl = document.getElementById('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.classList.add('expanded');

  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.textContent = '...';

  resultsEl.innerHTML = `<div class="torrentio-grid">${Array(8).fill(0).map(() => `
    <div class="torrentio-card skel-card">
      <div class="torrentio-poster"><div class="skel-poster skel-block"></div></div>
      <div style="padding:5px 6px 7px">
        <div class="skel-line w80 skel-block" style="height:7px"></div>
        <div class="skel-line w55 skel-block" style="height:6px;margin-top:5px"></div>
      </div>
    </div>
  `).join('')}</div>`;

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
        ${item.poster ? `<img src="${esc(item.poster)}" alt="" loading="lazy">` : '<div class="torrentio-poster-empty">🎬</div>'}
      </div>
      <div class="torrentio-card-info">
        <div class="torrentio-card-title" title="${esc(item.title)}">${esc(item.title)}</div>
        ${meta ? `<div class="torrentio-card-meta">${esc(meta)}</div>` : ''}
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
        ${item.poster ? `<img class="torrentio-stream-poster" src="${esc(item.poster)}" alt="">` : ''}
        <div>
          <div class="torrentio-stream-title">${esc(item.title)}</div>
          ${item.year ? `<div class="torrentio-stream-year">${esc(String(item.year))}</div>` : ''}
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
  document.getElementById('torrentio-back-btn').addEventListener('click', () => torrentioGoBack(item.type));
  document.getElementById('t-go-btn').addEventListener('click', () => {
    const season = isAnime ? null : parseInt(document.getElementById('t-season').value) || 1;
    const episode = parseInt(document.getElementById('t-episode').value) || 1;
    fetchAndRenderTorrentioStreams(item.id, item.type, season, episode, item);
  });
}

function pickBestStream(streams, tier) {
  const test = {
    '4K':    s => /2160p|4k|uhd/i.test(s.quality),
    '1080p': s => /1080/i.test(s.quality),
    '720p':  s => /720p/i.test(s.quality),
    '480p':  s => /480p/i.test(s.quality),
  }[tier];
  if (!test) return null;
  const candidates = streams.filter(s => !s.debrid && s.magnet && test(s));
  if (!candidates.length) return null;
  return candidates.reduce((best, s) => (s.seeders ?? 0) > (best.seeders ?? 0) ? s : best);
}

const QUALITY_REGEX = {
  '4K':    /2160p|4k|uhd/i,
  '1080p': /1080/i,
  '720p':  /720p/i,
  '480p':  /480p/i,
};

function renderQualityShortcuts(container, streams) {
  const available = ['4K', '1080p', '720p', '480p'].filter(t => pickBestStream(streams, t));
  if (!available.length) return;

  const bar = document.createElement('div');
  bar.className = 'quality-shortcuts';

  const allBtn = document.createElement('button');
  allBtn.className = 'quality-shortcut-btn active';
  allBtn.dataset.tier = 'all';
  allBtn.textContent = 'All';
  bar.appendChild(allBtn);

  for (const tier of available) {
    const btn = document.createElement('button');
    btn.className = 'quality-shortcut-btn';
    btn.dataset.tier = tier;
    btn.textContent = tier;
    bar.appendChild(btn);
  }

  container.prepend(bar);

  bar.addEventListener('click', e => {
    const btn = e.target.closest('.quality-shortcut-btn');
    if (!btn) return;
    bar.querySelectorAll('.quality-shortcut-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tier = btn.dataset.tier;
    container.querySelectorAll('.torrentio-stream').forEach(row => {
      if (tier === 'all') { row.style.display = ''; return; }
      const quality = row.querySelector('.search-quality')?.textContent || '';
      row.style.display = QUALITY_REGEX[tier]?.test(quality) ? '' : 'none';
    });
  });
}

async function initCardQualityOverlay(item, overlay) {
  if (!streamCache.has(item.imdbId)) {
    overlay.innerHTML = '<span class="dq-loading">· · ·</span>';
    try {
      const streams = await window.api.torrentioStreams(item.imdbId, 'movie', null, null);
      streamCache.set(item.imdbId, streams);
    } catch {
      streamCache.set(item.imdbId, []);
    }
  }
  const streams = streamCache.get(item.imdbId);
  overlay.innerHTML = '';
  let hasAny = false;
  for (const tier of ['4K', '1080p', '720p', '480p']) {
    const best = pickBestStream(streams, tier);
    if (!best) continue;
    hasAny = true;
    const btn = document.createElement('button');
    btn.className = 'dq-btn';
    btn.textContent = tier;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelector('.add-tab[data-tab="magnet"]').click();
      doAdd(best.magnet);
    });
    overlay.appendChild(btn);
  }
  if (!hasAny) overlay.remove();
}

function renderStreamRows(container, streams) {
  if (!streams.length) {
    container.insertAdjacentHTML('beforeend', `<div class="torrentio-empty">${t('torrentio.noStreams')}</div>`);
    return;
  }
  const playable = streams.filter(s => !s.debrid);
  const debridOnly = streams.filter(s => s.debrid);
  for (const s of streams) {
    const row = document.createElement('div');
    row.className = s.debrid ? 'torrentio-stream torrentio-stream-debrid' : 'torrentio-stream';
    const qualityClass = s.quality ? `q-${s.quality.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    row.innerHTML = `
      ${s.quality ? `<span class="search-quality ${qualityClass}">${esc(s.quality)}</span>` : ''}
      <span class="torrentio-stream-name" title="${esc(s.fileName)}">${esc(s.fileName)}</span>
      ${s.debrid ? '<span class="torrentio-debrid-badge">🔒 Debrid</span>' : ''}
      ${!s.debrid && s.seeders != null ? `<span class="search-seeds ${seedsClass(s.seeders)}">↑ ${Number(s.seeders)}</span>` : ''}
      ${s.size ? `<span class="torrentio-stream-size">${esc(s.size)}</span>` : ''}
    `;
    if (!s.debrid) row.addEventListener('click', () => doAdd(s.magnet));
    container.appendChild(row);
  }
  if (debridOnly.length && !playable.length) {
    container.insertAdjacentHTML('beforeend', `<div class="torrentio-debrid-note">🔒 Ces streams nécessitent un compte Debrid (RealDebrid, AllDebrid…) — configure ton URL Torrentio dans les paramètres.</div>`);
  }
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
          ${item.poster ? `<img class="torrentio-stream-poster" src="${esc(item.poster)}" alt="">` : ''}
          <div>
            <div class="torrentio-stream-title">${esc(item.title)}</div>
            ${item.year ? `<div class="torrentio-stream-year">${esc(String(item.year))}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>
    `;
    document.getElementById('torrentio-back-btn').addEventListener('click', () => torrentioGoBack(item.type));
  } else {
    container.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
  }

  try {
    const streams = await window.api.torrentioStreams(id, type, season, episode);
    if (type === 'movie') {
      container.querySelector('.torrentio-loading')?.remove();
    } else {
      container.innerHTML = '';
    }
    renderStreamRows(container, streams);
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
  const pid = 'pending-' + Date.now();
  pendingTorrents.set(pid, {
    id: pid, name: t('card.buffering'), connecting: true,
    size: 0, downloaded: 0, progress: 0,
    downloadSpeed: 0, uploadSpeed: 0, numPeers: 0,
    done: false, paused: false, ready: false,
    timeRemaining: null, hasSubtitle: false,
    speedHistory: [], playback: null, resumePos: null,
    port: null, meta: null, queuePos: -1, casting: null, videoFiles: [],
  });
  renderList();
  try {
    const r = await window.api.addTorrent(source);
    pendingTorrents.delete(pid);
    toast(t('toast.added', { name: r.name }));
    if (r.videoFiles?.length > 1) openFilePicker(r.id, r.videoFiles);
  } catch (err) {
    pendingTorrents.delete(pid);
    renderList();
    const msg = err.message === 'already_downloading' ? t('toast.alreadyActive') : err.message;
    toast(msg, err.message !== 'already_downloading');
  }
}

// --- Render ---

function renderList() {
  if (!document.getElementById('detail-view').classList.contains('hidden')) return;
  if (!document.getElementById('discover-results').classList.contains('hidden')) return;
  if (document.getElementById('search-results').classList.contains('expanded')) return;
  const list = document.getElementById('torrent-list');
  const empty = document.getElementById('empty-state');
  const allItems = [...torrents, ...pendingTorrents.values()];
  empty.classList.toggle('hidden', allItems.length > 0);

  for (const card of [...list.querySelectorAll('.card')]) {
    if (!allItems.find(t => t.id === card.dataset.id)) card.remove();
  }
  for (const t of allItems) {
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

function updateGlobalStats() {
  const el = document.getElementById('global-stats');
  if (!el) return;
  const active = torrents.filter(x => !x.done);
  if (!active.length && !torrents.some(x => x.uploadSpeed > 0)) {
    el.classList.add('hidden');
    return;
  }
  const totalDl = torrents.reduce((s, x) => s + x.downloadSpeed, 0);
  const totalUl = torrents.reduce((s, x) => s + x.uploadSpeed, 0);
  const totalPeers = torrents.reduce((s, x) => s + x.numPeers, 0);
  el.classList.remove('hidden');
  el.querySelector('.gs-dl').textContent = `↓ ${fmt(totalDl)}`;
  el.querySelector('.gs-ul').textContent = `↑ ${fmt(totalUl)}`;
  el.querySelector('.gs-peers').textContent = `${totalPeers} peers`;
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

function createCard(torrent) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = torrent.id;
  card.innerHTML = `
    <img class="card-poster hidden" alt="">
    <div class="card-body">
      <div class="card-top">
        <span class="drag-handle" title="${t('drag.handle')}">${ICONS.grip}</span>
        <span class="card-name" title="${esc(torrent.name)}">${esc(torrent.name)}</span>
        <span class="queue-badge hidden"></span>
        <span class="card-size">${fmtSize(torrent.size)}</span>
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
        <button class="btn-files hidden" title="${t('btn.chooseFile')}">${ICONS.files}</button>
        <button class="btn-play">${torrent.connecting ? t('card.buffering') : t('card.play')}</button>
        <button class="btn-local hidden">${t('card.playLocal')}</button>
        <button class="btn-cast hidden" title="Cast">${ICONS.cast}</button>
        <button class="btn-seed hidden">⏸ Seeding</button>
        <button class="btn-remove" title="Remove">${ICONS.remove}</button>
      </div>
    </div>
  `;

  if (torrent.connecting) card.querySelector('.btn-play').classList.add('buffering');

  card.querySelector('.btn-play').addEventListener('click', () => play(torrent.id));
  card.querySelector('.btn-local').addEventListener('click', () => playLocal(torrent.id));
  card.querySelector('.btn-cast').addEventListener('click', () => openCastPicker(torrent.id));
  card.querySelector('.btn-seed').addEventListener('click', () => stopSeed(torrent.id));
  card.querySelector('.btn-remove').addEventListener('click', () => {
    if (pendingTorrents.has(torrent.id)) {
      pendingTorrents.delete(torrent.id);
      renderList();
      return;
    }
    remove(torrent.id, card);
  });
  card.querySelector('.btn-files').addEventListener('click', () => {
    const state = torrents.find(x => x.id === torrent.id);
    if (state?.videoFiles?.length > 1) openFilePicker(torrent.id, state.videoFiles);
  });

  // Drag-and-drop for queue reordering
  card.draggable = true;
  card.addEventListener('dragstart', e => {
    if (!e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.setData('text/plain', torrent.id);
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
    if (!fromId || fromId === torrent.id) return;

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

  updateCard(card, torrent);
  return card;
}

function updateCard(card, torrent) {
  if (torrent.connecting) return;

  // Now-playing indicator
  card.classList.toggle('playing', !!torrent.playback);

  // Poster
  const poster = card.querySelector('.card-poster');
  if (torrent.meta?.poster) {
    poster.src = torrent.meta.poster;
    poster.classList.remove('hidden');
  } else {
    poster.classList.add('hidden');
  }

  const pct = (torrent.progress * 100).toFixed(1);
  card.querySelector('.progress-fill').style.width = `${pct}%`;
  card.querySelector('.progress-fill').classList.toggle('done', torrent.done);
  card.querySelector('.pct').textContent = torrent.done ? t('card.done') : `${pct}%`;
  card.querySelector('.downloaded').textContent = torrent.done ? '' : fmtSize(torrent.downloaded);
  card.querySelector('.eta').textContent = torrent.done ? '' : fmtETA(torrent.timeRemaining);
  card.querySelector('.dl').textContent = torrent.done ? '' : `↓ ${fmt(torrent.downloadSpeed)}`;

  // Peers — show upload when done + seeding
  const peersEl = card.querySelector('.peers');
  if (torrent.done && !torrent.paused && torrent.uploadSpeed > 0) {
    peersEl.textContent = `↑ ${fmt(torrent.uploadSpeed)} · ${torrent.numPeers}p`;
  } else {
    peersEl.textContent = `${torrent.numPeers} peers`;
  }

  card.querySelector('.sub-badge').classList.toggle('hidden', !torrent.hasSubtitle);
  card.querySelector('.graph').innerHTML = torrent.done ? '' : speedGraph(torrent.speedHistory);

  // Queue badge
  const badge = card.querySelector('.queue-badge');
  const showQueue = torrents.filter(x => !x.done).length > 1;
  if (showQueue && torrent.queuePos >= 0 && !torrent.done) {
    badge.textContent = `#${torrent.queuePos + 1}`;
    badge.classList.remove('hidden');
    badge.classList.toggle('queue-badge-first', torrent.queuePos === 0);
  } else {
    badge.classList.add('hidden');
  }

  const filesBtn = card.querySelector('.btn-files');
  filesBtn.classList.toggle('hidden', !torrent.videoFiles?.length);

  const localBtn = card.querySelector('.btn-local');
  localBtn.classList.toggle('hidden', !torrent.done);

  const castBtn = card.querySelector('.btn-cast');
  castBtn.classList.toggle('hidden', !torrent.ready);

  const seedBtn = card.querySelector('.btn-seed');
  seedBtn.classList.toggle('hidden', !torrent.done);
  if (torrent.done) {
    seedBtn.textContent = torrent.paused ? t('card.seeder') : t('card.seeding');
    seedBtn.classList.toggle('active', !torrent.paused);
  }

  // Playback / casting bar
  const playbackBar = card.querySelector('.playback-bar');
  if (torrent.casting) {
    playbackBar.textContent = t('cast.inProgress', { name: torrent.casting });
    playbackBar.classList.remove('hidden');
  } else if (torrent.playback) {
    const dur = torrent.playback.duration > 0 ? ` / ${fmtTime(torrent.playback.duration)}` : '';
    playbackBar.textContent = t('card.playing', { pos: fmtTime(torrent.playback.pos), dur });
    playbackBar.classList.remove('hidden');
  } else {
    playbackBar.classList.add('hidden');
  }

  const playBtn = card.querySelector('.btn-play');
  if (!torrent.ready) {
    playBtn.textContent = t('card.buffering');
    playBtn.classList.add('buffering');
  } else if (torrent.resumePos > 5) {
    playBtn.textContent = `↩ ${fmtTime(torrent.resumePos)}`;
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
        item.innerHTML = `<span class="file-item-name">📺 ${esc(d.name)}</span><span class="file-item-size">${esc(d.host)}</span>`;
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
    item.innerHTML = `<span class="file-item-name">${esc(f.name)}</span><span class="file-item-size">${fmtSize(f.size)}</span>`;
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
      ? `<img class="lib-poster" src="${esc(item.poster)}" alt="">`
      : `<div class="lib-no-poster"></div>`;

    const ratingBadge = item.rating ? `<div class="lib-rating">⭐ ${esc(String(item.rating))}</div>` : '';
    const activeBadge = item.type === 'active' ? `<div class="lib-active-badge">✓</div>` : '';
    const yearLine    = item.year ? `<div class="lib-info-year">${esc(String(item.year))}</div>` : '';

    const actionBtn = item.type === 'active'
      ? `<button class="btn-lib-play">${t('card.play')}</button>`
      : (item.magnet ? `<button class="btn-lib-redownload">↩</button>` : '');

    card.innerHTML = `
      ${posterHTML}
      ${ratingBadge}
      ${activeBadge}
      <div class="lib-info">
        <div class="lib-info-title">${esc(item.title || item.name)}</div>
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

// --- About ---

async function openAbout() {
  const version = await window.api.getVersion();
  document.getElementById('about-version').textContent = `v${version}`;
  document.getElementById('about-modal').classList.remove('hidden');
}

function closeAbout() {
  document.getElementById('about-modal').classList.add('hidden');
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
  const setMaxIcon = (isMax) => { btnMax.textContent = isMax ? '⧉' : '▢'; };

  setMaxIcon(await window.api.isMaximized());
  window.api.onMaximize(setMaxIcon);
  window.api.onUnmaximize(setMaxIcon);

  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click',    () => window.api.close());
}

init();
