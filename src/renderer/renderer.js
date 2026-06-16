'use strict';

let torrents = [];
let settings = {};
let players = [];
let pendingClipboardMagnet = null;
let filePickerTorrentId = null;
let castTargetId = null;
let searchFilters = { category: 'tout', quality: 'tout' };
let nextEpisodeData = null;
let nextEpisodeTimer = null;
let nextEpisodeReadyIv = null;
const pendingTorrents = new Map();

async function init() {
  [settings, players] = await Promise.all([window.api.getSettings(), window.api.detectPlayers()]);
  applyTranslations(settings.language || 'en');
  window.api.onState(data => { torrents = data; renderList(); updateGlobalStats(); });
  window.api.onClipboardMagnet(magnet => showClipboardBanner(magnet));
  window.api.onNextEpisode(data => showNextEpisodeBanner(data));
  window.api.onNewEpisode(data => {
    toast(t('follow.newEpisode', { label: `${data.title} ${data.label}` }));
    if (!document.getElementById('history-view').classList.contains('hidden')) renderFollows();
  });
  window.api.onUpdateAvailable(({ version, url }) => {
    const releaseUrl = url;
    const text = document.getElementById('update-text');
    const btn = document.getElementById('update-download-btn');
    const progress = document.getElementById('update-progress');
    const bar = document.getElementById('update-progress-bar');
    text.textContent = t('update.available', { version });
    btn.onclick = async () => {
      btn.disabled = true;
      progress.classList.remove('hidden');
      bar.style.width = '0%';
      text.textContent = t('update.downloading');
      const res = await window.api.downloadUpdate();
      if (res && res.ok) { text.textContent = t('update.restarting'); return; }
      if (res && res.dev) { window.api.openRelease(releaseUrl); }     // unpackaged: open GitHub
      else { text.textContent = t('update.failed'); }
      progress.classList.add('hidden');
      btn.disabled = false;
    };
    window.api.onUpdateProgress(({ pct }) => {
      bar.style.width = `${pct}%`;
      text.textContent = t('update.downloading') + ` ${pct}%`;
    });
    document.getElementById('update-dismiss-btn').onclick = () => document.getElementById('update-banner').classList.add('hidden');
    document.getElementById('update-banner').classList.remove('hidden');
  });
  bindUI();
  await initWinCtrl();
  if (!settings.player && players.length === 0) {
    document.getElementById('no-player-banner').classList.remove('hidden');
  }
  if (!settings.acceptedDisclaimer) showDisclaimer();
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

  document.getElementById('banner-open-settings').addEventListener('click', showPlayerSetup);
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
  document.getElementById('series-back-btn').addEventListener('click', closeSeriesView);

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

  document.getElementById('alt-stream-close').addEventListener('click', closeAltStreamModal);
  document.getElementById('alt-stream-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('alt-stream-modal')) closeAltStreamModal();
  });

  // Player setup wizard
  document.getElementById('player-setup-close').addEventListener('click', closePlayerSetup);
  document.getElementById('player-setup-skip').addEventListener('click', closePlayerSetup);
  document.getElementById('player-setup-rescan').addEventListener('click', async () => {
    players = await window.api.detectPlayers();
    renderPlayerSetupList();
  });
  document.getElementById('player-setup-browse').addEventListener('click', async () => {
    const p = await window.api.openPlayerDialog();
    if (!p) return;
    applySetupPlayer({ path: p, args: [] }, p.split(/[\\/]/).pop());
  });

  // External links (settings hints, install buttons)
  const LINKS = {
    opensubtitles: 'https://www.opensubtitles.com/en/consumers',
    mpv: 'https://mpv.io/installation/',
    vlc: 'https://www.videolan.org/vlc/',
  };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-link]');
    if (!el) return;
    const url = LINKS[el.dataset.link];
    if (url) window.api.openExternal(url);
  });

  document.getElementById('clipboard-add').addEventListener('click', () => {
    if (pendingClipboardMagnet) doAdd(pendingClipboardMagnet);
    hideClipboardBanner();
  });
  document.getElementById('clipboard-dismiss').addEventListener('click', hideClipboardBanner);

  document.getElementById('next-ep-play').addEventListener('click', triggerNextEpisode);
  document.getElementById('next-ep-dismiss').addEventListener('click', hideNextEpisodeBanner);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('player-setup-modal').classList.contains('hidden')) { closePlayerSetup(); return; }
      if (!document.getElementById('cast-modal').classList.contains('hidden')) { closeCastModal(); return; }
      if (!document.getElementById('alt-stream-modal').classList.contains('hidden')) { closeAltStreamModal(); return; }
      if (!document.getElementById('file-modal').classList.contains('hidden')) { closeFilePicker(); return; }
      if (!document.getElementById('clipboard-banner').classList.contains('hidden')) { hideClipboardBanner(); return; }
      if (!document.getElementById('about-modal').classList.contains('hidden')) { closeAbout(); return; }
      if (!document.getElementById('detail-view').classList.contains('hidden')) { closeDetailView(); return; }
      if (!document.getElementById('series-view').classList.contains('hidden')) { closeSeriesView(); return; }
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

async function doAdd(source, resumePos = null, episodeContext = null) {
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
    const r = await window.api.addTorrent(source, resumePos, episodeContext);
    pendingTorrents.delete(pid);
    toast(t('toast.added', { name: r.name }));
    if (r.diskWarning) {
      toast(t('toast.diskLow', { need: fmtSize(r.diskWarning.need), free: fmtSize(r.diskWarning.free) }), true);
    }
    if (r.videoFiles?.length > 1) openFilePicker(r.id, r.videoFiles);
    return r;
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
        <button class="btn-retry hidden"></button>
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
  card.querySelector('.btn-retry').addEventListener('click', () => {
    const state = torrents.find(x => x.id === torrent.id);
    if (state?.episodeContext) openAlternateStreams(torrent.id, state.episodeContext);
    else retryTorrent(torrent.id);
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

  // Stall detection — no peers and no speed while still downloading
  const stalled = !torrent.done && torrent.numPeers === 0 && torrent.downloadSpeed === 0;
  card.classList.toggle('stalled', stalled);

  // Stalled action: switch release (if we know the episode) or just re-announce
  const retryBtn = card.querySelector('.btn-retry');
  retryBtn.classList.toggle('hidden', !stalled);
  if (stalled) retryBtn.textContent = torrent.episodeContext ? t('card.altStream') : t('card.retry');

  // Peers — show upload when done + seeding
  const peersEl = card.querySelector('.peers');
  if (stalled) {
    peersEl.textContent = t('card.stalled');
    peersEl.classList.add('peers-stalled');
  } else {
    peersEl.classList.remove('peers-stalled');
    if (torrent.done && !torrent.paused && torrent.uploadSpeed > 0) {
      peersEl.textContent = `↑ ${fmt(torrent.uploadSpeed)} · ${torrent.numPeers}p`;
    } else {
      peersEl.textContent = `${torrent.numPeers} peers`;
    }
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
            await window.api.castToDevice(castTargetId, d.host, d.type);
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

// --- Stalled torrent recovery ---

// Re-announce the same magnet to look for fresh peers (no episode context to switch).
async function retryTorrent(id) {
  try {
    await window.api.retryTorrent(id);
    toast(t('toast.retrying'));
  } catch (err) { toast(err.message, true); }
}

// Show alternate Torrentio releases for the same episode; picking one drops the
// stalled torrent and adds the chosen release (keeping the episode context).
async function openAlternateStreams(id, ctx) {
  const modal = document.getElementById('alt-stream-modal');
  const list = document.getElementById('alt-stream-list');
  list.innerHTML = `<div class="torrentio-loading">${t('torrentio.loadingStreams')}</div>`;
  modal.classList.remove('hidden');
  let streams;
  try {
    streams = await window.api.torrentioStreams(ctx.id, ctx.type, ctx.season, ctx.episode);
  } catch {
    list.innerHTML = `<div class="torrentio-empty">${t('status.networkError')}</div>`;
    return;
  }
  const playable = (streams || []).filter(s => !s.debrid && s.magnet);
  if (!playable.length) {
    list.innerHTML = `<div class="torrentio-empty">${t('torrentio.noStreams')}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const s of playable) {
    const qualityClass = s.quality ? `q-${s.quality.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    const row = document.createElement('div');
    row.className = 'torrentio-stream';
    row.innerHTML = `
      ${s.quality ? `<span class="search-quality ${qualityClass}">${esc(s.quality)}</span>` : ''}
      <span class="torrentio-stream-name" title="${esc(s.fileName)}">${esc(s.fileName)}</span>
      ${s.seeders != null ? `<span class="search-seeds ${seedsClass(s.seeders)}">↑ ${Number(s.seeders)}</span>` : ''}
      ${s.size ? `<span class="torrentio-stream-size">${esc(s.size)}</span>` : ''}
    `;
    row.addEventListener('click', async () => {
      closeAltStreamModal();
      try { await window.api.removeTorrent(id); } catch {}
      doAdd(s.magnet, null, ctx);
    });
    list.appendChild(row);
  }
}

function closeAltStreamModal() {
  document.getElementById('alt-stream-modal').classList.add('hidden');
}

// --- History ---

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

// --- Next episode ---

function showNextEpisodeBanner(data) {
  if (!data || !data.magnet) return;
  nextEpisodeData = data;
  const banner = document.getElementById('next-episode-banner');
  const poster = document.getElementById('next-ep-poster');
  const text = document.getElementById('next-ep-text');
  if (data.poster) { poster.src = data.poster; poster.classList.remove('hidden'); }
  else poster.classList.add('hidden');

  clearTimeout(nextEpisodeTimer);
  if (data.autoPlay) {
    let s = 8;
    const tick = () => {
      if (s < 0) { triggerNextEpisode(); return; }
      text.textContent = t('nextEp.countdown', { label: data.label, s });
      s--;
      nextEpisodeTimer = setTimeout(tick, 1000);
    };
    tick();
  } else {
    text.textContent = t('nextEp.label', { label: data.label });
  }
  banner.classList.remove('hidden');
}

function hideNextEpisodeBanner() {
  clearTimeout(nextEpisodeTimer);
  nextEpisodeTimer = null;
  document.getElementById('next-episode-banner').classList.add('hidden');
}

async function triggerNextEpisode() {
  const data = nextEpisodeData;
  hideNextEpisodeBanner();
  if (!data) return;
  document.querySelector('.add-tab[data-tab="magnet"]')?.click();
  try {
    const r = await doAdd(data.magnet, null, data.context);
    if (r && r.id) autoPlayWhenReady(r.id);
  } catch {}
}

function autoPlayWhenReady(id) {
  clearInterval(nextEpisodeReadyIv);
  let tries = 0;
  nextEpisodeReadyIv = setInterval(() => {
    tries++;
    const tr = torrents.find(x => x.id === id);
    if (tr && tr.ready) { clearInterval(nextEpisodeReadyIv); play(id); }
    else if (tries > 150) clearInterval(nextEpisodeReadyIv);   // give up after ~2.5 min
  }, 1000);
}

// --- About ---

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
