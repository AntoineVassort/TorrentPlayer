'use strict';
// Discover + Search + Torrentio + detail view. Classic script sharing global scope.

let discoverCat = 'movies';
let discoverGenre = 'all';
let discoverSort = 'popularity';
let discoverCache = {};
let discoverPage = {};          // cat → last loaded page (1-based)
let discoverDone = {};          // cat → true when the source has no more pages
let discoverLoading = false;    // guards concurrent "load more" fetches
let detailOrigin = 'main';      // 'main' (Discover) | 'history' (Library) — where Back returns
let detailItem = null;          // currently-open detail item (guards async meta races)
let detailProgress = {};        // watched map for the open series
let detailSelectedEp = null;
let torrentioTitles = [];
let torrentioCurrentItem = null;
let torrentioBackFn = null;
let searchDebounceTimer = null;
function autoPick(streams, pref) {
  const playable = (streams || []).filter(s => !s.debrid && s.magnet);
  if (!playable.length) return null;
  if (pref === 'best') return playable.reduce((a, b) => (b.seeders ?? 0) > (a.seeders ?? 0) ? b : a);
  const tiered = pickBestStream(playable, pref);
  return tiered || pickBestStream(playable, '1080p') || pickBestStream(playable, '720p') || playable[0] || null;
}

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
  if (discoverCache[cat]) { populateGenreOptions(discoverCache[cat]); applyDiscoverView(); return; }
  discoverPage[cat] = 1;
  discoverDone[cat] = false;
  renderDiscoverSkeleton();
  try {
    const items = await window.api.discoverFetch(cat, 1);
    discoverCache[cat] = items;
    if (!items.length) discoverDone[cat] = true;
    populateGenreOptions(items);
    applyDiscoverView();
  } catch {
    grid.innerHTML = `<div class="discover-empty">${t('discover.error')}</div>`;
  }
}

// Fetch + append the next page when the user scrolls near the bottom.
async function loadMoreDiscover() {
  const cat = discoverCat;
  if (discoverLoading || discoverDone[cat] || !discoverCache[cat]) return;
  discoverLoading = true;
  setDiscoverLoadingMore(true);
  const nextPage = (discoverPage[cat] || 1) + 1;
  try {
    const items = await window.api.discoverFetch(cat, nextPage);
    if (!items.length) { discoverDone[cat] = true; return; }
    const keyOf = i => i.imdbId || i.title;
    const seen = new Set(discoverCache[cat].map(keyOf));
    const fresh = items.filter(i => !seen.has(keyOf(i)));
    discoverPage[cat] = nextPage;
    if (!fresh.length) { discoverDone[cat] = true; return; }
    discoverCache[cat] = discoverCache[cat].concat(fresh);
    populateGenreOptions(discoverCache[cat]);
    // Smooth path: default order/filter → just append the new cards in place.
    if (discoverSort === 'popularity' && discoverGenre === 'all') appendDiscoverCards(fresh);
    else applyDiscoverView(true);
  } catch { /* transient — a later scroll will retry */ }
  finally { discoverLoading = false; setDiscoverLoadingMore(false); }
}

function setDiscoverLoadingMore(on) {
  const grid = document.getElementById('discover-results');
  let el = grid.querySelector('.discover-loading-more');
  if (on) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'discover-loading-more';
      el.textContent = t('discover.loadingMore');
      grid.appendChild(el);
    }
  } else if (el) {
    el.remove();
  }
}

// Fill the Genre dropdown with the genres actually present in the loaded catalog,
// keeping the current pick if it still exists (else fall back to "All").
function populateGenreOptions(items) {
  const sel = document.getElementById('pt-genre');
  if (!sel) return;
  const genres = [...new Set((items || []).flatMap(i => i.genres || []))].sort((a, b) => a.localeCompare(b));
  if (!genres.includes(discoverGenre)) discoverGenre = 'all';
  sel.innerHTML = `<option value="all">${t('genre.all')}</option>`
    + genres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  sel.value = discoverGenre;
}

// Filter (genre) + sort the cached catalog, then paint the grid. No refetch.
// preserveScroll keeps the scroll position (used when appending more on scroll).
function applyDiscoverView(preserveScroll = false) {
  const items = discoverCache[discoverCat] || [];
  let view = discoverGenre === 'all'
    ? items.slice()
    : items.filter(i => (i.genres || []).includes(discoverGenre));
  const num = v => (v == null || v === '') ? -Infinity : Number(v);
  if (discoverSort === 'rating')     view.sort((a, b) => num(b.rating) - num(a.rating));
  else if (discoverSort === 'year')  view.sort((a, b) => num(b.year) - num(a.year));
  else if (discoverSort === 'title') view.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  renderDiscoverGrid(view, preserveScroll);
}

function renderDiscoverGrid(items, preserveScroll = false) {
  const grid = document.getElementById('discover-results');
  const scrollTop = grid.scrollTop;
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = `<div class="discover-empty">${t('discover.unavailable')}</div>`;
    return;
  }
  for (const item of items) grid.appendChild(buildDiscoverCard(item));
  if (preserveScroll) grid.scrollTop = scrollTop;
}

// Append cards without re-rendering (smooth infinite scroll). The loading
// sentinel, if present, is kept last.
function appendDiscoverCards(items) {
  const grid = document.getElementById('discover-results');
  const sentinel = grid.querySelector('.discover-loading-more');
  for (const item of items) {
    const card = buildDiscoverCard(item);
    if (sentinel) grid.insertBefore(card, sentinel);
    else grid.appendChild(card);
  }
}

function buildDiscoverCard(item) {
  const card = document.createElement('div');
  card.className = 'discover-card';
  const year = item.year ? esc(String(item.year)) : '';
  const rating = item.rating ? `★ ${esc(String(item.rating))}` : '';
  if (!item.posterUrl) card.classList.add('no-poster');
  card.innerHTML = `
    <div class="discover-poster">
      ${item.posterUrl ? `<img src="${esc(item.posterUrl)}" alt="" loading="lazy" decoding="async">` : ''}
    </div>
    <div class="discover-info">
      <span class="discover-title">${esc(item.title)}</span>
      ${(year || rating) ? `<div class="discover-meta-row">
        <span class="discover-meta">${year}</span>
        ${rating ? `<span class="discover-meta discover-rating">${rating}</span>` : ''}
      </div>` : ''}
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
  return card;
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
  document.getElementById(detailOrigin === 'history' ? 'history-view' : 'main-view').classList.remove('hidden');
}

// Popcorn Time–style detail. `origin` decides where Back returns ('main' | 'history').
async function openDetailView(item, origin = 'main') {
  detailOrigin = origin;
  detailItem = item;
  detailSelectedEp = null;
  document.getElementById(origin === 'history' ? 'history-view' : 'main-view').classList.add('hidden');
  document.getElementById('detail-view').classList.remove('hidden');
  document.getElementById('detail-scroll').scrollTop = 0;

  renderDetailHero(item);

  const isSeries = item.type === 'series' || item.type === 'anime';
  document.getElementById('detail-series').classList.toggle('hidden', !isSeries);
  document.getElementById('detail-movie').classList.toggle('hidden', isSeries);

  // Enrich the hero (synopsis, runtime, status, rating) — imdb only, best-effort.
  if (item.imdbId) {
    window.api.metaDetail(item.imdbId, item.type === 'movie' ? 'movie' : 'series')
      .then(meta => { if (detailItem === item && meta) applyDetailMeta(item, meta); })
      .catch(() => {});
  }

  if (isSeries) {
    loadDetailEpisodes(item);
  } else {
    const area = document.getElementById('detail-streams-area');
    area.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
    if (item.imdbId) {
      fetchAndRenderDetailStreams(item.imdbId, 'movie', null, null, item);
    } else {
      window.api.torrentioSearch(item.title, 'anime').then(results => {
        if (results.length) fetchAndRenderDetailStreams(results[0].id, results[0].type, null, 1, results[0]);
        else area.innerHTML = `<div class="torrentio-empty">${t('status.noResults')}</div>`;
      }).catch(() => { area.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`; });
    }
  }
}

function renderDetailHero(item) {
  const posterUrl = item.posterUrl || item.poster || null;
  document.getElementById('detail-hero-bg').style.backgroundImage = posterUrl ? `url("${posterUrl}")` : '';
  const posterImg = document.getElementById('detail-poster-img');
  if (posterUrl) { posterImg.src = posterUrl; posterImg.style.display = ''; }
  else posterImg.style.display = 'none';
  document.getElementById('detail-title-text').textContent = item.title;
  document.getElementById('detail-synopsis').textContent = '';
  renderDetailChips(item, null);

  const host = document.getElementById('detail-bookmark-host');
  host.innerHTML = '';
  if ((item.type === 'series' || item.type === 'anime') && item.imdbId) {
    attachFollowButton(host, { imdbId: item.imdbId, title: item.title, poster: posterUrl });
  }
}

function applyDetailMeta(item, meta) {
  if (meta.description) document.getElementById('detail-synopsis').textContent = meta.description;
  renderDetailChips(item, meta);
}

// Build the "2011 · 60 min · Continuing · Action · IMDb 9.2 · ★★★★★" chip row.
function renderDetailChips(item, meta) {
  const chips = [];
  const year = item.year || meta?.year;
  if (year) chips.push(esc(String(year)));
  if (meta?.runtime) chips.push(esc(meta.runtime));
  if (meta?.status) chips.push(esc(meta.status));
  const genre = (item.genres && item.genres[0]) || (meta?.genres && meta.genres[0]);
  if (genre) chips.push(esc(genre));
  let html = chips.map(c => `<span class="dchip">${c}</span>`).join('<span class="dsep">·</span>');
  const rating = meta?.imdbRating || item.rating;
  if (rating) {
    if (html) html += '<span class="dsep">·</span>';
    html += `<span class="dchip dchip-imdb">IMDb ${esc(String(rating))}</span>`
          + `<span class="dstars">${starRating(rating)}</span>`;
  }
  document.getElementById('detail-meta-text').innerHTML = html;
}

function starRating(rating10) {
  const filled = Math.max(0, Math.min(5, Math.round((Number(rating10) || 0) / 2)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

// --- Series 3-pane (Seasons | Episodes | Episode info) ---

async function loadDetailEpisodes(item) {
  const seasonList = document.getElementById('detail-season-list');
  const epList = document.getElementById('detail-episode-list');
  const epInfo = document.getElementById('detail-epinfo');
  seasonList.innerHTML = '';
  epInfo.innerHTML = '';
  epList.innerHTML = `<div class="torrentio-loading">${t('status.searching')}</div>`;
  document.querySelector('.detail-col-seasons').classList.remove('hidden');

  if (item.type === 'anime' || !item.imdbId) { loadDetailAnime(item); return; }

  let episodes = [], progress = {};
  try {
    [{ episodes }, progress] = await Promise.all([
      window.api.seriesEpisodes(item.imdbId, item.tvmazeId || null),
      window.api.seriesProgress(item.imdbId),
    ]);
  } catch {
    epList.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
    return;
  }
  if (detailItem !== item) return;
  if (!episodes.length) { loadDetailAnime(item); return; }

  detailProgress = progress || {};
  const seasons = {};
  for (const ep of episodes) (seasons[ep.season] = seasons[ep.season] || []).push(ep);
  const seasonKeys = Object.keys(seasons).map(Number).sort((a, b) => a - b);

  seasonList.innerHTML = '';
  seasonKeys.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'detail-season-tab' + (i === 0 ? ' active' : '');
    b.textContent = t('series.season', { n: s });
    b.addEventListener('click', () => {
      seasonList.querySelectorAll('.detail-season-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderDetailEpisodeList(item, seasons[s]);
    });
    seasonList.appendChild(b);
  });
  renderDetailEpisodeList(item, seasons[seasonKeys[0]]);
}

function renderDetailEpisodeList(item, eps) {
  const epList = document.getElementById('detail-episode-list');
  epList.innerHTML = '';
  for (const ep of eps) {
    const key = `${ep.season}:${ep.number}`;
    const watched = !!detailProgress[key];
    const row = document.createElement('div');
    row.className = 'detail-ep-row' + (watched ? ' ep-watched' : '');
    row.innerHTML = `
      <span class="detail-ep-num">${esc(String(ep.number))}</span>
      <span class="detail-ep-name">${esc(ep.name || `Episode ${ep.number}`)}</span>
      <button class="detail-ep-eye" title="${watched ? t('series.markUnwatched') : t('series.markWatched')}">${ICONS.eye}</button>
    `;
    row.addEventListener('click', e => {
      if (e.target.closest('.detail-ep-eye')) return;
      selectDetailEpisode(item, ep, row);
    });
    row.querySelector('.detail-ep-eye').addEventListener('click', async e => {
      e.stopPropagation();
      const nw = !detailProgress[key];
      try { await window.api.seriesMarkWatched(item.imdbId, ep.season, ep.number, nw); } catch {}
      if (nw) detailProgress[key] = true; else delete detailProgress[key];
      row.classList.toggle('ep-watched', nw);
    });
    epList.appendChild(row);
  }
  const first = epList.querySelector('.detail-ep-row');
  if (first) selectDetailEpisode(item, eps[0], first);
}

function selectDetailEpisode(item, ep, row) {
  detailSelectedEp = ep;
  document.querySelectorAll('.detail-ep-row.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  const info = document.getElementById('detail-epinfo');
  const aired = ep.airstamp ? fmtDate(ep.airstamp) : '';
  info.innerHTML = `
    <div class="epinfo-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
    <div class="epinfo-sub">${esc(t('detail.seasonEp', { s: ep.season, e: ep.number }))}</div>
    ${aired ? `<div class="epinfo-aired">${esc(t('detail.aired', { date: aired }))}</div>` : ''}
    ${ep.summary ? `<p class="epinfo-summary">${esc(ep.summary)}</p>` : ''}
    <div class="epinfo-footer">
      <button class="epinfo-watch btn-pt">${t('detail.watchNow')}</button>
    </div>
  `;
  info.querySelector('.epinfo-watch').addEventListener('click', () => watchEpisode(item, ep));
}

async function watchEpisode(item, ep) {
  const btn = document.querySelector('.epinfo-watch');
  if (btn) { btn.disabled = true; btn.textContent = t('status.searching'); }
  try {
    const streams = await window.api.torrentioStreams(item.imdbId, 'series', ep.season, ep.number);
    const best = autoPick(streams, settings.preferredQuality || 'best');
    if (!best) { toast(t('torrentio.noStreams'), true); return; }
    const ctx = { id: item.imdbId, type: 'series', season: ep.season, episode: ep.number, title: item.title, poster: item.posterUrl || item.poster || null };
    const label = `${item.title} — ${t('detail.seasonEp', { s: ep.season, e: ep.number })}${ep.name ? ` — ${ep.name}` : ''}`;
    watchNow(best.magnet, ctx, { title: label, poster: item.posterUrl || item.poster || null });
  } catch { toast(t('status.networkError'), true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('detail.watchNow'); } }
}

// Anime / no-imdb fallback: flat episode-number picker (no TVmaze season data).
async function loadDetailAnime(item) {
  document.querySelector('.detail-col-seasons').classList.add('hidden');
  const epList = document.getElementById('detail-episode-list');
  const epInfo = document.getElementById('detail-epinfo');
  epInfo.innerHTML = '';

  let streamId = item.imdbId || item.id || null;
  const streamType = item.type === 'anime' ? 'anime' : (item.type || 'series');
  if (!streamId) {
    epList.innerHTML = `<div class="torrentio-loading">${t('status.searching')}</div>`;
    try {
      const results = await window.api.torrentioSearch(item.title, 'anime');
      if (results.length) streamId = results[0].id;
    } catch {}
  }
  if (detailItem !== item) return;
  if (!streamId) { epList.innerHTML = `<div class="torrentio-empty">${t('status.noResults')}</div>`; return; }

  epList.innerHTML = `
    <div class="detail-anime-picker">
      <label>${t('torrentio.episode')}</label>
      <input id="detail-anime-ep" type="number" min="1" value="1">
      <button class="epinfo-watch btn-pt">${t('detail.watchNow')}</button>
    </div>`;
  epList.querySelector('.epinfo-watch').addEventListener('click', () => {
    const e = parseInt(document.getElementById('detail-anime-ep').value) || 1;
    watchAnime(item, streamId, streamType, e);
  });
}

async function watchAnime(item, id, type, episode) {
  const btn = document.querySelector('.epinfo-watch');
  if (btn) { btn.disabled = true; btn.textContent = t('status.searching'); }
  try {
    const streams = await window.api.torrentioStreams(id, type, null, episode);
    const best = autoPick(streams, settings.preferredQuality || 'best');
    if (!best) { toast(t('torrentio.noStreams'), true); return; }
    const ctx = { id, type, season: null, episode, title: item.title, poster: item.posterUrl || item.poster || null };
    const label = `${item.title} — ${t('torrentio.episode')} ${episode}`;
    watchNow(best.magnet, ctx, { title: label, poster: item.posterUrl || item.poster || null });
  } catch { toast(t('status.networkError'), true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('detail.watchNow'); } }
}

// Create + wire a ★ follow toggle for a series, appended to `host`. Shared by the
// Discover detail view and the search episode picker (TVmaze-backed → imdb required).
async function attachFollowButton(host, { imdbId, title, poster }) {
  if (!imdbId) return;
  const btn = document.createElement('button');
  btn.className = 'detail-follow';
  btn.textContent = t('follow.add');
  host.appendChild(btn);

  let following = false;
  try { following = (await window.api.followList()).some(f => f.imdbId === imdbId); } catch {}
  const paint = () => {
    btn.textContent = following ? t('follow.remove') : t('follow.add');
    btn.classList.toggle('following', following);
  };
  paint();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (following) await window.api.followRemove(imdbId);
      else await window.api.followAdd({ imdbId, title, poster: poster || null });
      following = !following;
      paint();
      toast(following ? t('toast.followed', { name: title }) : t('toast.unfollowed', { name: title }));
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });
}

// Build the episode context passed to doAdd → enables "auto-play next episode".
// Returns null for movies (nothing to chain).
function episodeCtx(id, type, season, episode, item) {
  if (type === 'movie' || episode == null) return null;
  return {
    id, type, season, episode,
    title: item?.title || null,
    poster: item?.poster || item?.posterUrl || null,
  };
}

async function fetchAndRenderDetailStreams(id, type, season, episode, item = null) {
  const container = document.getElementById('detail-streams-area');
  container.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
  const watchMeta = { title: item?.title || '', poster: item?.posterUrl || item?.poster || null };
  try {
    const streams = await window.api.torrentioStreams(id, type, season, episode);
    const ctx = episodeCtx(id, type, season, episode, item);
    const pref = settings.preferredQuality;
    if (pref) {
      const best = autoPick(streams, pref);
      if (best) {
        container.innerHTML = '';
        watchNow(best.magnet, ctx, watchMeta);
        return;
      }
    }
    container.innerHTML = '';
    renderQualityShortcuts(container, streams);
    renderStreamRows(container, streams, ctx, watchMeta);
  } catch {
    container.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
  }
}
