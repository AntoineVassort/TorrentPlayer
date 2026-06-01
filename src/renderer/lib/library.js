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

  const ratingBadge = item.rating ? `<div class="lib-rating">⭐ ${esc(String(item.rating))}</div>` : '';
  const activeBadge = item.type === 'active' ? `<div class="lib-active-badge">✓</div>` : '';
  const yearLine    = item.year ? `<div class="lib-info-year">${esc(String(item.year))}</div>` : '';

  const frac = watchFraction(item);
  const progressBar = frac > 0.01
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
    ${activeBadge}
    ${progressBar}
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
      onRemove(card);
    });
  } else {
    const resumeOrRedl = card.querySelector('.btn-lib-resume') || card.querySelector('.btn-lib-redownload');
    resumeOrRedl?.addEventListener('click', e => {
      e.stopPropagation();
      const resume = isResumable(item) ? item.resumePos : null;
      doAdd(item.magnet, resume);
      closeHistory();
      toast(t('toast.added', { name: item.name }));
    });
    card.querySelector('.btn-lib-remove').addEventListener('click', async e => {
      e.stopPropagation();
      await window.api.removeHistory(item.id);
      onRemove(card);
    });
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
        r.textContent = `⭐ ${meta.rating}`;
        card.appendChild(r);
      }
    }).catch(() => {});
  }

  return card;
}

async function renderHistory() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('history-empty');
  const continueSection = document.getElementById('continue-section');
  const continueGrid = document.getElementById('continue-grid');
  grid.textContent = '';
  continueGrid.textContent = '';

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
      resumePos: t.resumePos || null,
      resumeDuration: t.resumeDuration || null,
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

  // Continue Watching shelf — resumable items (deduped by id)
  const continueItems = items.filter(isResumable);
  continueSection.classList.toggle('hidden', continueItems.length === 0);
  document.getElementById('lib-all-title').classList.toggle('hidden', items.length === 0);

  const onRemove = (card) => {
    card.remove();
    if (!grid.children.length) empty.classList.remove('hidden');
  };

  for (const item of continueItems) {
    continueGrid.appendChild(createLibCard(item, () => renderHistory()));
  }
  for (const item of items) {
    grid.appendChild(createLibCard(item, onRemove));
  }
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
  document.getElementById('download-dir').value = settings.downloadDir || '';
  document.getElementById('delete-after-play').checked = !!settings.deleteAfterPlay;
  document.getElementById('max-download').value = settings.maxDownload || '';
  document.getElementById('max-upload').value = settings.maxUpload || '';
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
  const language = document.getElementById('language-select').value;
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
    language,
    torrentioUrl: torrentioUrl || null,
    subtitleLanguage,
    openSubtitlesApiKey: openSubtitlesApiKey || null,
  };
  await window.api.saveSettings(settings);
  toast(t('toast.settingsSaved'));
  closeSettings();
}

// --- Toast ---
