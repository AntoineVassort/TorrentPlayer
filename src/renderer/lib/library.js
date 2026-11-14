'use strict';
// Library / Continue Watching + Settings + disclaimer + player wizard + About.

let libTypeFilter = 'all';
let libSort = 'date';
function showDisclaimer() {
  const modal = document.getElementById('disclaimer-modal');
  const agree = document.getElementById('disclaimer-agree');
  const accept = document.getElementById('disclaimer-accept');
  agree.checked = false;
  accept.disabled = true;
  agree.onchange = () => { accept.disabled = !agree.checked; };
  accept.onclick = async () => {
    settings = { ...settings, acceptedDisclaimer: true };
    await window.api.saveSettings(settings);
    modal.classList.add('hidden');
    if (!settings.player) showPlayerSetup();
  };
  modal.classList.remove('hidden');
}

// --- Player setup wizard ---

function showPlayerSetup() {
  renderPlayerSetupList();
  document.getElementById('player-setup-modal').classList.remove('hidden');
}

function closePlayerSetup() {
  document.getElementById('player-setup-modal').classList.add('hidden');
}

function renderPlayerSetupList() {
  const list = document.getElementById('player-setup-list');
  const none = document.getElementById('player-setup-none');
  list.innerHTML = '';
  if (players.length) {
    none.classList.add('hidden');
    for (const p of players) {
      const btn = document.createElement('button');
      btn.className = 'player-setup-item';
      btn.innerHTML = `<span class="player-setup-name">${esc(p.name)}</span><span class="player-setup-path">${esc(p.path)}</span>`;
      btn.addEventListener('click', () => applySetupPlayer({ path: p.path, args: p.args || [] }, p.name));
      list.appendChild(btn);
    }
  } else {
    none.classList.remove('hidden');
  }
}

async function applySetupPlayer(player, name) {
  settings = { ...settings, player };
  await window.api.saveSettings(settings);
  document.getElementById('no-player-banner').classList.add('hidden');
  closePlayerSetup();
  toast(t('toast.playerSet', { name }));
}

// --- UI bindings ---

async function openHistory() {
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('history-view').classList.remove('hidden');
  await renderHistory();
}

function closeHistory() {
  document.getElementById('history-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
}

function createLibCard(item, onRemove) {
  const card = document.createElement('div');
  card.className = 'lib-card';

  const posterHTML = item.poster
    ? `<img class="lib-poster" src="${esc(item.poster)}" alt="">`
    : `<div class="lib-no-poster"></div>`;

  const ratingBadge = item.rating ? `<div class="lib-rating">★ ${esc(String(item.rating))}</div>` : '';
  const yearLine    = item.year ? `<div class="lib-info-year">${esc(String(item.year))}</div>` : '';

  const frac = watchFraction(item);
  const watchedItem = item._watched ?? (item.watched || frac >= 0.85);
  const downloadedItem = item._downloaded ?? (item.completed || item.type === 'active');
  const chips = (watchedItem || downloadedItem) ? `<div class="lib-chips">
      ${watchedItem ? `<span class="lib-chip lib-chip-watched">${ICONS.check}<span>${esc(t('status.watched'))}</span></span>` : ''}
      ${downloadedItem ? `<span class="lib-chip">${ICONS.download}<span>${esc(t('status.downloaded'))}</span></span>` : ''}
    </div>` : '';
  const progressBar = frac > 0.01 && !watchedItem
    ? `<div class="lib-progress"><div class="lib-progress-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>`
    : '';

  // Resumable history entries get a Resume button; active get Play; others Re-download
  let actionBtn;
  if (item.type === 'active') {
    actionBtn = `<button class="btn-lib-play">${item.resumePos > 5 ? t('lib.resume', { time: fmtTime(item.resumePos) }) : t('card.play')}</button>`;
  } else if (item.magnet && isResumable(item)) {
    actionBtn = `<button class="btn-lib-resume">↩ ${fmtTime(item.resumePos)}</button>`;
  } else if (item.magnet) {
    actionBtn = `<button class="btn-lib-redownload">↩</button>`;
  } else {
    actionBtn = '';
  }

  card.innerHTML = `
    ${posterHTML}
    ${ratingBadge}
    ${progressBar}
    <div class="lib-info">
      <div class="lib-info-title">${esc(item.title || item.name)}</div>
      ${yearLine}
      ${chips}
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
      onRemove(card);
    });
  } else {
    const resumeOrRedl = card.querySelector('.btn-lib-resume') || card.querySelector('.btn-lib-redownload');
    resumeOrRedl?.addEventListener('click', e => {
      e.stopPropagation();
      const resume = isResumable(item) ? item.resumePos : null;
      doAdd(item.magnet, resume, libraryContext(item));
      closeHistory();
      toast(t('toast.added', { name: item.name }));
    });
    card.querySelector('.btn-lib-remove').addEventListener('click', async e => {
      e.stopPropagation();
      if (item.type === 'mark') {
        // Known only through manual checks: removing it clears them.
        try {
          await window.api.libraryMark(item.imdbId, 'watched', ['movie'], false);
          await window.api.libraryMark(item.imdbId, 'downloaded', ['movie'], false);
        } catch (err) { toast(friendlyError(err), true); return; }
      } else {
        await window.api.removeHistory(item.id);
      }
      onRemove(card);
    });
  }

  // A recognised movie opens its page (watched / downloaded checks, play, sources).
  if (item.imdbId && item.kind !== 'series' && !isSeries(item.name)) {
    card.addEventListener('click', () => openDetailView({
      imdbId: item.imdbId, title: item.title || item.name, posterUrl: item.poster || null,
      year: item.year || null, rating: item.rating || null, type: 'movie',
    }, 'history'));
  }

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
        r.textContent = `★ ${meta.rating}`;
        card.appendChild(r);
      }
    }).catch(() => {});
  }

  return card;
}

// Torrent-start context for a Library item, so a re-download keeps its series / episode /
// movie identity (next-episode offer, "downloaded" mark, right file of a season pack).
function libraryContext(item) {
  if (!item.imdbId) return null;
  const movie = item.kind === 'movie' || (!item.kind && !isSeries(item.name));
  const poster = typeof item.poster === 'string' && !item.poster.startsWith('data:') ? item.poster : null;
  return {
    id: item.imdbId, type: movie ? 'movie' : 'series',
    season: movie ? null : (item.season ?? null), episode: movie ? null : (item.episode ?? null),
    title: item.title || null, poster,
  };
}

let libRenderSeq = 0;   // drops the result of an older render that finished late

// Library: "Continue" shelf, then one card per series, one per movie, and the torrents the
// app could not identify. Rebuilt on open and whenever the main process says it changed.
async function renderHistory() {
  const seq = ++libRenderSeq;
  let lib = null, follows = [];
  try {
    [lib, follows] = await Promise.all([window.api.libraryGet(), window.api.followList().catch(() => [])]);
  } catch {}
  if (seq !== libRenderSeq) return;
  lib = lib || { history: [], watched: {}, downloaded: {}, inProgress: {}, sources: {}, titles: {} };

  // History records, with finished active torrents merged in (same id = same torrent).
  const byId = new Map();
  for (const e of lib.history || []) byId.set(e.id, { type: 'history', ...e });
  for (const tr of torrents.filter(x => x.done)) {
    const prev = byId.get(tr.id) || {};
    const ctx = tr.episodeContext;
    byId.set(tr.id, {
      ...prev, type: 'active', id: tr.id, name: tr.name,
      poster: prev.poster || tr.meta?.poster || null,
      title: prev.title || tr.meta?.title || tr.name,
      year: prev.year || tr.meta?.year || null,
      rating: prev.rating || tr.meta?.rating || null,
      imdbId: prev.imdbId || ctx?.id || tr.meta?.imdbId || null,
      kind: prev.kind || (ctx ? (ctx.type === 'movie' ? 'movie' : 'series') : tr.meta?.kind) || null,
      resumePos: tr.resumePos || prev.resumePos || null,
      resumeDuration: tr.resumeDuration || prev.resumeDuration || null,
      completed: true,
    });
  }
  const items = [...byId.values()];
  const titles = lib.titles || {};

  const seriesMap = new Map();
  const group = (id) => {
    if (!seriesMap.has(id)) seriesMap.set(id, { imdbId: id, title: null, poster: null, year: null, rating: null, last: 0, following: false });
    return seriesMap.get(id);
  };
  const movies = [], others = [];
  const now = Date.now();
  for (const it of items) {
    const ser = it.kind === 'series' || (it.kind !== 'movie' && isSeries(it.name));
    if (ser && it.imdbId) {
      const g = group(it.imdbId);
      g.title ||= it.title || null;
      g.poster ||= it.poster || null;
      g.year ||= it.year || null;
      g.rating ||= it.rating || null;
      g.last = Math.max(g.last, it.watchedAt ? Date.parse(it.watchedAt) || 0 : now);
    } else if (ser) {
      others.push(it);
    } else {
      it._watched = !!(it.watched || watchFraction(it) >= 0.85 || (it.imdbId && lib.watched[it.imdbId]?.movie));
      it._downloaded = !!(it.completed || it.type === 'active' || (it.imdbId && lib.downloaded[it.imdbId]?.movie));
      movies.push(it);
    }
  }

  // Titles known only through manual checks, the episode cache or a follow.
  const markedIds = new Set([...Object.keys(lib.watched || {}), ...Object.keys(lib.downloaded || {})]);
  const movieIds = new Set(movies.map(m => m.imdbId).filter(Boolean));
  for (const id of markedIds) {
    const keys = [...Object.keys(lib.watched[id] || {}), ...Object.keys(lib.downloaded[id] || {})];
    const info = titles[id] || {};
    if (keys.some(k => k !== 'movie')) {
      group(id);
    } else if (!movieIds.has(id) && info.title) {
      movies.push({
        type: 'mark', id: `mark:${id}`, imdbId: id, kind: 'movie', name: info.title, title: info.title,
        poster: info.poster || null, _watched: !!lib.watched[id]?.movie, _downloaded: !!lib.downloaded[id]?.movie,
      });
    }
  }
  for (const f of follows || []) {
    const g = group(f.imdbId);
    g.following = true;
    g.title ||= f.title;
    g.poster ||= f.poster || null;
  }
  const seriesGroups = [...seriesMap.values()].filter(g => {
    const info = titles[g.imdbId] || {};
    g.title ||= info.title || null;
    g.poster ||= info.poster || null;
    g.status = seriesStatus(info.episodes, lib.watched[g.imdbId], lib.downloaded[g.imdbId]);
    g.tvmazeId = info.tvmazeId || null;
    return !!g.title;
  });

  // Filters / sort (Recent = last activity, then title / rating).
  const showSeries = libTypeFilter !== 'movies';
  const showMovies = libTypeFilter !== 'series';
  const byTitle = (a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || '');
  const byRating = (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0);
  if (libSort === 'title') { seriesGroups.sort(byTitle); movies.sort(byTitle); others.sort(byTitle); }
  else if (libSort === 'rating') { seriesGroups.sort(byRating); movies.sort(byRating); }
  else seriesGroups.sort((a, b) => b.last - a.last);

  const fill = (sectionId, gridId, list, make) => {
    const grid = document.getElementById(gridId);
    grid.textContent = '';
    for (const x of list) grid.appendChild(make(x));
    document.getElementById(sectionId).classList.toggle('hidden', !list.length);
  };
  const rerender = () => renderHistory();
  const continueItems = items.filter(isResumable);
  fill('continue-section', 'continue-grid', continueItems, it => createLibCard(it, rerender));
  fill('lib-series-section', 'lib-series-grid', showSeries ? seriesGroups : [], createSeriesCard);
  fill('lib-movies-section', 'lib-movies-grid', showMovies ? movies : [], it => createLibCard(it, rerender));
  fill('lib-other-section', 'library-grid', showSeries ? others : [], it => createLibCard(it, rerender));

  const total = continueItems.length + seriesGroups.length + movies.length + others.length;
  document.getElementById('history-empty').classList.toggle('hidden', total > 0);
}

// One card per series: progress "x/y watched" and where the next episode stands.
function createSeriesCard(g) {
  const card = document.createElement('div');
  card.className = 'lib-card lib-series-card';
  const st = g.status;
  const posterHTML = g.poster
    ? `<img class="lib-poster" src="${esc(g.poster)}" alt="">`
    : `<div class="lib-no-poster"></div>`;

  let badge = '';
  if (st.next && st.state === 'available') {
    badge = `<div class="lib-next lib-next-new">${esc(t('lib.nextNew', { ep: epLabel(st.next.season, st.next.number) }))}</div>`;
  } else if (st.next && st.state === 'ready') {
    badge = `<div class="lib-next lib-next-ready">${esc(t('lib.nextReady', { ep: epLabel(st.next.season, st.next.number) }))}</div>`;
  } else if (st.state === 'done') {
    badge = `<div class="lib-next lib-next-done">${esc(t('lib.upToDate'))}</div>`;
  }
  const count = st.airedCount
    ? t('lib.watchedOf', { n: st.watchedCount, total: st.airedCount })
    : (st.watchedCount ? t('lib.watchedN', { n: st.watchedCount }) : '');
  const frac = st.airedCount ? st.watchedCount / st.airedCount : 0;
  const bar = frac > 0
    ? `<div class="lib-progress"><div class="lib-progress-fill lib-progress-series" style="width:${(Math.min(frac, 1) * 100).toFixed(1)}%"></div></div>`
    : '';

  card.innerHTML = `
    ${posterHTML}
    ${g.following ? `<div class="lib-follow-star" title="${esc(t('follow.remove'))}">★</div>` : ''}
    ${badge}
    ${bar}
    <div class="lib-info">
      <div class="lib-info-title">${esc(g.title)}</div>
      ${count ? `<div class="lib-info-year">${esc(count)}</div>` : ''}
    </div>
  `;
  card.addEventListener('click', () => openDetailView({
    imdbId: g.imdbId, tvmazeId: g.tvmazeId, title: g.title, posterUrl: g.poster,
    year: g.year, rating: g.rating, type: 'series',
  }, 'history'));
  return card;
}


// --- Series episode view ---

function closeSeriesView() {
  document.getElementById('series-view').classList.add('hidden');
  document.getElementById('history-view').classList.remove('hidden');
}

// Followed-series cards now open the unified Popcorn Time detail view (3-pane).
function openSeriesView(follow) {
  openDetailView({
    imdbId: follow.imdbId,
    tvmazeId: follow.tvmazeId || null,
    title: follow.title,
    posterUrl: follow.poster || null,
    type: 'series',
  }, 'history');
}

// --- Clipboard banner ---

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
  document.getElementById('auto-play-next').checked = settings.autoPlayNext !== false;
  document.getElementById('auto-grab-followed').checked = !!settings.autoGrabFollowed;
  document.getElementById('preferred-quality').value = settings.preferredQuality || '';
  document.getElementById('download-dir').value = settings.downloadDir || '';
  document.getElementById('delete-after-play').checked = !!settings.deleteAfterPlay;
  // Side-nav: show one panel at a time (display:none keeps hidden panels free), always open on General.
  const showPanel = name => {
    document.querySelectorAll('#settings-nav .snav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    document.querySelectorAll('#settings-content .spanel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
    document.getElementById('settings-content').scrollTop = 0;
  };
  document.querySelectorAll('#settings-nav .snav-btn').forEach(b => { b.onclick = () => showPanel(b.dataset.panel); });
  showPanel('general');

  // Network & performance. Defaults mirror settings.js (main process).
  const fillNet = n => {
    document.getElementById('max-download').value = n.maxDownload || '';
    document.getElementById('max-upload').value = n.maxUpload || '';
    document.getElementById('max-conns').value = n.maxConns ?? 55;
    document.getElementById('seed-ratio').value = n.seedRatioLimit ?? 0;
    document.getElementById('ahead-window').value = n.aheadWindowMB ?? 512;
    document.getElementById('net-dht').checked = n.dht !== false;
    document.getElementById('net-lsd').checked = n.lsd !== false;
    document.getElementById('net-nat').checked = n.natTraversal !== false;
    document.getElementById('net-webseeds').checked = n.webSeeds !== false;
    document.getElementById('net-encryption').checked = n.encryption !== false;
    document.getElementById('net-port').value = n.torrentPort || 0;
  };
  fillNet(settings);
  document.getElementById('net-defaults-btn').onclick = () => fillNet({});
  document.getElementById('torrentio-url').value = settings.torrentioUrl || '';
  document.getElementById('subtitle-language').value = settings.subtitleLanguage || 'off';
  document.getElementById('opensubtitles-key').value = settings.openSubtitlesApiKey || '';

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
  const maxConns = Math.min(Math.max(parseInt(document.getElementById('max-conns').value) || 55, 1), 500);
  const seedRatioLimit = Math.max(parseFloat(document.getElementById('seed-ratio').value) || 0, 0);
  const aheadWindowMB = Math.min(Math.max(parseInt(document.getElementById('ahead-window').value) || 512, 64), 8192);
  const portRaw = parseInt(document.getElementById('net-port').value) || 0;
  const torrentPort = portRaw >= 1024 && portRaw <= 65535 ? portRaw : 0;
  const language = document.getElementById('language-select').value;
  const autoPlayNext = document.getElementById('auto-play-next').checked;
  const autoGrabFollowed = document.getElementById('auto-grab-followed').checked;
  const preferredQuality = document.getElementById('preferred-quality').value || null;
  const torrentioUrl = document.getElementById('torrentio-url').value.trim();
  const subtitleLanguage = document.getElementById('subtitle-language').value;
  const openSubtitlesApiKey = document.getElementById('opensubtitles-key').value.trim();

  settings = {
    ...settings,
    player: playerPath ? { path: playerPath, args } : null,
    downloadDir: downloadDir || null,
    deleteAfterPlay,
    maxDownload: maxDl || null,
    maxUpload: maxUl || null,
    maxConns,
    seedRatioLimit,
    aheadWindowMB,
    dht: document.getElementById('net-dht').checked,
    lsd: document.getElementById('net-lsd').checked,
    natTraversal: document.getElementById('net-nat').checked,
    webSeeds: document.getElementById('net-webseeds').checked,
    encryption: document.getElementById('net-encryption').checked,
    torrentPort,
    language,
    autoPlayNext,
    autoGrabFollowed,
    preferredQuality,
    torrentioUrl: torrentioUrl || null,
    subtitleLanguage,
    openSubtitlesApiKey: openSubtitlesApiKey || null,
  };
  await window.api.saveSettings(settings);
  toast(t('toast.settingsSaved'));
  closeSettings();
}

// --- Toast ---
