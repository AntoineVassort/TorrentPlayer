'use strict';
// Discover + Search + Torrentio + detail view. Classic script sharing global scope.

let discoverCat = 'movies';
let discoverCache = {};
let torrentioTitles = [];
let torrentioCurrentItem = null;
let torrentioBackFn = null;
let searchDebounceTimer = null;
const streamCache = new Map();
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
