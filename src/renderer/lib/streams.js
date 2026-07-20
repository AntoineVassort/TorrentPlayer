'use strict';
// Torrentio search flow + stream rendering (title grid, episode picker, quality
// shortcuts, per-card quality overlay, stream rows). Classic script sharing the
// global scope with browse.js — relies on its detail/nav helpers (autoPick,
// episodeCtx, attachFollowButton, torrentioGoBack, torrentioTitles…).

const streamCache = new Map();

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
  // Follow toggle for imdb-backed series (search results from Cinemeta use tt… ids).
  if (item.type === 'series' && /^tt/.test(item.id || '')) {
    const host = resultsEl.querySelector('.torrentio-stream-header-info > div');
    if (host) attachFollowButton(host, { imdbId: item.id, title: item.title, poster: item.poster || null });
  }
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
      watchNow(best.magnet, null, { title: item.title, poster: item.posterUrl || item.poster || null });
    });
    overlay.appendChild(btn);
  }
  if (!hasAny) overlay.remove();
}

function renderStreamRows(container, streams, episodeContext = null, watchMeta = null) {
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
    if (!s.debrid) row.addEventListener('click', () => {
      if (watchMeta) watchNow(s.magnet, episodeContext, watchMeta);
      else doAdd(s.magnet, null, episodeContext);
    });
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
    const pref = settings.preferredQuality;
    if (pref) {
      const best = autoPick(streams, pref);
      if (best) {
        container.innerHTML = '';
        toast(t('toast.autoAdding', { quality: pref === 'best' ? t('quality.best') : pref }));
        doAdd(best.magnet, null, episodeCtx(id, type, season, episode, item));
        return;
      }
    }
    if (type === 'movie') {
      container.querySelector('.torrentio-loading')?.remove();
    } else {
      container.innerHTML = '';
    }
    renderStreamRows(container, streams, episodeCtx(id, type, season, episode, item));
  } catch {
    container.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
  }
}
