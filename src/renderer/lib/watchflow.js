'use strict';
// Popcorn-Time watch flow: the fullscreen "Watch Now" download/buffering overlay
// and the end-of-episode "next episode" banner (with auto-play countdown).
// Classic script sharing the global scope with renderer.js (doAdd, play,
// torrents, toast, t, fmt).

let downloadOverlayId = null;     // torrent id tracked by the Popcorn Time download overlay
let downloadOverlayIv = null;
let nextEpisodeData = null;
let nextEpisodeTimer = null;
let nextEpisodeReadyIv = null;

// --- Download overlay (Popcorn Time "Watch Now" → buffering screen) ---

// Add a torrent and show the fullscreen download overlay; auto-launch the player
// once enough is buffered. `meta` = { title, poster } for the overlay backdrop/title.
function watchNow(magnet, episodeContext, meta) {
  showDownloadOverlay(meta);
  doAdd(magnet, null, episodeContext).then(r => {
    if (!r || !r.id) { hideDownloadOverlay(); return; }
    downloadOverlayId = r.id;
    updateDownloadOverlay();
    clearInterval(downloadOverlayIv);
    let tries = 0;
    downloadOverlayIv = setInterval(() => {
      tries++;
      const tr = torrents.find(x => x.id === downloadOverlayId);
      if (tr && tr.playback) { clearInterval(downloadOverlayIv); hideDownloadOverlay(); }
      else if (tr && tr.ready) { clearInterval(downloadOverlayIv); play(downloadOverlayId); hideDownloadOverlay(); }
      else if (tries > 180) { clearInterval(downloadOverlayIv); hideDownloadOverlay(); toast(t('overlay.background')); }
    }, 1000);
  }).catch(() => hideDownloadOverlay());
}

function showDownloadOverlay(meta) {
  document.getElementById('dl-ov-title').textContent = meta?.title || '';
  document.getElementById('dl-ov-bg').style.backgroundImage = meta?.poster ? `url("${meta.poster}")` : '';
  document.getElementById('dl-ov-bar').style.width = '0%';
  document.getElementById('dl-ov-pct').textContent = '0%';
  document.getElementById('dl-ov-dl').textContent = '—';
  document.getElementById('dl-ov-ul').textContent = '—';
  document.getElementById('dl-ov-peers').textContent = '0';
  document.getElementById('download-overlay').classList.remove('hidden');
}

function hideDownloadOverlay() {
  clearInterval(downloadOverlayIv);
  downloadOverlayId = null;
  document.getElementById('download-overlay').classList.add('hidden');
}

function updateDownloadOverlay() {
  if (document.getElementById('download-overlay').classList.contains('hidden')) return;
  const tr = torrents.find(x => x.id === downloadOverlayId);
  if (!tr) return;
  const pct = Math.round((tr.progress || 0) * 100);
  document.getElementById('dl-ov-bar').style.width = pct + '%';
  document.getElementById('dl-ov-pct').textContent = pct + '%';
  document.getElementById('dl-ov-dl').textContent = fmt(tr.downloadSpeed || 0);
  document.getElementById('dl-ov-ul').textContent = fmt(tr.uploadSpeed || 0);
  document.getElementById('dl-ov-peers').textContent = String(tr.numPeers || 0);
}

function cancelDownloadOverlay() {
  const id = downloadOverlayId;
  hideDownloadOverlay();
  if (id) window.api.removeTorrent(id).catch(() => {});
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
