// Watch-progress (Continue Watching), the "play next episode" offer, and
// followed-series tracking with new-episode alerts. Reads playback position off
// the `active` map entries and pushes updates to the renderer / history.

import { app, Notification } from 'electron';
import { active, rt } from './runtime.js';
import { getSettings } from './settings.js';
import { addEntry, loadHistory } from './history.js';
import { markKey, setMarks, getAllMarks, loadTitles, updateTitle } from './series-progress.js';
import { parseSeasonEpisode } from './subtitles.js';
import { fetchTorrentioStreams, pickBestTorrentioStream, fetchSeriesEpisodes } from './metadata.js';
import { loadFollows, updateFollow } from './follows.js';
import { addTorrentInternal, applyQueueRules, saveSession, isVideo } from './torrentManager.js';

// --- Library identity & change notifications ---

let libraryNotifyTimer = null;
// Tell the renderer the Library changed (debounced: a season pack can finish many files at once).
export function notifyLibraryChanged() {
  clearTimeout(libraryNotifyTimer);
  libraryNotifyTimer = setTimeout(() => {
    if (rt.mainWindow && !rt.mainWindow.isDestroyed()) rt.mainWindow.webContents.send('library:changed');
  }, 400);
}

// Which title / episode a file of an active torrent is. The episode context (set when the
// torrent was started from Discover / a series page) wins for the streamed file; other files
// of a season pack are identified from their SxxExx name. Torrents added by raw magnet fall
// back on the Cinemeta match (`entry.meta`), which may arrive after the download finished.
export function libraryIdentity(entry, file = entry.fileState?.file) {
  const ctx = entry.episodeContext;
  const meta = entry.meta || {};
  const titleId = ctx?.id || meta.imdbId || null;
  let kind = ctx ? (ctx.type === 'movie' ? 'movie' : 'series') : (meta.kind || null);
  let season = null, episode = null;
  if (kind !== 'movie') {
    if (ctx?.episode != null && file === entry.fileState?.file) ({ season, episode } = ctx);
    else ({ season, episode } = parseSeasonEpisode(file?.name));
    if (episode != null) kind = 'series';
  }
  return { imdbId: titleId, kind, season, episode };
}

const hasKey = (id) => id.imdbId && (id.episode != null || id.kind === 'movie');
// Drop null fields so an unknown identity never erases one already stored in history.
const known = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
export const knownIdentity = (entry, file) => known(libraryIdentity(entry, file));
// Title / poster of the start context: the Library fallback when Cinemeta found no match
// (the Cinemeta meta, spread after it, wins when there is one).
const ctxInfo = (entry) => known({ title: entry.episodeContext?.title, poster: entry.episodeContext?.poster });

// Mark key of a history entry ("movie" or "season:episode"), or null if it can't be placed.
export function historyKey(e) {
  if (e.kind === 'movie') return 'movie';
  let { season, episode } = e;
  if (episode == null) ({ season, episode } = parseSeasonEpisode(e.name));
  if (episode != null) return markKey(season, episode);
  return e.kind === 'series' ? null : (e.imdbId ? 'movie' : null);
}

export function persistWatchProgress(id) {
  const entry = active.get(id);
  if (!entry || !entry.resumePos) return;
  const magnet = entry.magnet || entry.torrent.magnetURI;
  if (!magnet) return;
  const userData = app.getPath('userData');
  const watched = entry.resumeDuration > 0 && entry.resumePos / entry.resumeDuration >= 0.85;
  const ident = libraryIdentity(entry);
  addEntry(userData, {
    id,
    name: entry.fileState.file?.name || entry.torrent.name,
    magnet,
    watchedAt: new Date().toISOString(),
    resumePos: entry.resumePos,
    resumeDuration: entry.resumeDuration || null,
    watched,
    ...ctxInfo(entry),
    ...(entry.meta || {}),
    ...known(ident),
    completed: !!entry.fileState.file?.done,
  });
  if (watched && hasKey(ident)) {
    setMarks(userData, 'watched', ident.imdbId, [markKey(ident.season, ident.episode)], true);
  }
  notifyLibraryChanged();
}

// A video file of an active torrent finished downloading: mark it "downloaded" and, for the
// streamed file, record the torrent in the Library (once — restored sessions re-fire this).
export function recordFileDone(entry, file) {
  if (!entry || !file) return;
  const userData = app.getPath('userData');
  const ident = libraryIdentity(entry, file);
  let changed = false;
  if (hasKey(ident)) {
    changed = setMarks(userData, 'downloaded', ident.imdbId, [markKey(ident.season, ident.episode)], true);
    const ctx = entry.episodeContext;
    updateTitle(userData, ident.imdbId, {
      kind: ident.kind, title: ctx?.title || entry.meta?.title || null, poster: ctx?.poster || null,
    });
  }
  const magnet = entry.magnet || entry.torrent.magnetURI;
  const id = entry.torrent.infoHash;
  if (file === entry.fileState.file && magnet) {
    const prev = loadHistory(userData).find(e => e.id === id);
    if (!prev?.completed || (ident.imdbId && !prev.imdbId)) {
      addEntry(userData, {
        id, name: file.name, magnet,
        watchedAt: prev?.watchedAt || new Date().toISOString(),
        ...ctxInfo(entry), ...(entry.meta || {}), ...known(ident), completed: true,
      });
      changed = true;
    }
  }
  if (changed) notifyLibraryChanged();
}

// Re-run after the Cinemeta match lands (it gives the identity of a raw-magnet torrent).
export function recordDoneFiles(entry) {
  for (const f of entry.torrent.files) if (f.done && isVideo(f.name)) recordFileDone(entry, f);
}

// Keep a TVmaze episode list for every series in the Library (history, marks, follows), so
// the Library can show "x/y watched" and whether the next episode is out. Each series is
// re-fetched at most every 6 h; runs one at a time.
let refreshingSeries = false;
export async function refreshLibrarySeries({ force = false } = {}) {
  if (refreshingSeries) return;
  refreshingSeries = true;
  try {
    const userData = app.getPath('userData');
    const ids = new Set();
    for (const e of loadHistory(userData)) {
      if (e.imdbId && e.kind === 'series') ids.add(e.imdbId);
    }
    const { watched, downloaded } = getAllMarks(userData);
    for (const m of [watched, downloaded]) {
      for (const [tid, keys] of Object.entries(m)) if (Object.keys(keys).some(k => k !== 'movie')) ids.add(tid);
    }
    for (const f of loadFollows(userData)) ids.add(f.imdbId);

    const titles = loadTitles(userData);
    const now = Date.now();
    let changed = false;
    for (const tid of ids) {
      if (!/^tt\d+$/.test(tid)) continue;               // TVmaze lookups need an IMDb id
      const cur = titles[tid] || {};
      if (!force && cur.checkedAt && now - cur.checkedAt < 6 * 60 * 60 * 1000) continue;
      const { tvmazeId, episodes } = await fetchSeriesEpisodes(tid, cur.tvmazeId || null);
      if (!episodes.length) continue;                   // keep the stale list on a network error
      updateTitle(userData, tid, {
        kind: 'series', tvmazeId,
        episodes: episodes.map(e => ({ season: e.season, number: e.number, name: e.name, airstamp: e.airstamp })),
        checkedAt: now,
      });
      changed = true;
    }
    if (changed) notifyLibraryChanged();
  } finally {
    refreshingSeries = false;
  }
}

// After a series/anime episode finishes (~watched to the end), find the next episode's
// best stream and notify the renderer so it can offer "Play next episode".
export async function maybeOfferNextEpisode(id) {
  const entry = active.get(id);
  if (!entry) return;
  const ctx = entry.episodeContext;
  if (!ctx || ctx.episode == null) return;

  const pos = entry.resumePos, dur = entry.resumeDuration;
  if (!pos || !dur || dur <= 0 || pos / dur < 0.85) return;   // not finished enough

  const settings = getSettings(app.getPath('userData'));
  const nextEpisode = ctx.episode + 1;
  const streams = await fetchTorrentioStreams(ctx.id, ctx.type, ctx.season, nextEpisode, settings.torrentioUrl);
  const best = pickBestTorrentioStream(streams);
  if (!best || !best.magnet) return;

  const label = ctx.type === 'anime' ? `E${nextEpisode}` : `S${ctx.season ?? 1}E${nextEpisode}`;
  rt.mainWindow?.webContents.send('episode:next', {
    magnet: best.magnet,
    label,
    title: ctx.title || null,
    poster: ctx.poster || null,
    autoPlay: settings.autoPlayNext !== false,   // default on, matches Settings checkbox
    context: { id: ctx.id, type: ctx.type, season: ctx.season, episode: nextEpisode, title: ctx.title, poster: ctx.poster },
  });
}

// --- Followed series (persistent tracking + new-episode alerts) ---

// Fetch the best stream for a specific series episode and add it to the queue.
export async function grabFollowedEpisode({ imdbId, season, episode, title, poster }) {
  const settings = getSettings(app.getPath('userData'));
  const streams = await fetchTorrentioStreams(imdbId, 'series', season, episode, settings.torrentioUrl);
  const best = pickBestTorrentioStream(streams);
  if (!best || !best.magnet) return null;
  const result = await addTorrentInternal(best.magnet, best.magnet, settings.downloadDir, null, {
    id: imdbId, type: 'series', season, episode, title: title || null, poster: poster || null,
  });
  if (!rt.queueOrder.includes(result.id)) {
    rt.queueOrder.push(result.id);
    applyQueueRules();
    saveSession();
  }
  return result;
}

function notifyNewEpisode(follow, ep) {
  const label = `S${ep.season}E${ep.number}`;
  if (Notification.isSupported()) {
    const s = getSettings(app.getPath('userData'));
    const body = s.language === 'fr'
      ? `${follow.title} — nouvel épisode ${label}`
      : `${follow.title} — new episode ${label}`;
    new Notification({ title: 'TorrentPlayer', body }).show();
  }
  rt.mainWindow?.webContents.send('follow:newEpisode', {
    imdbId: follow.imdbId, title: follow.title, poster: follow.poster, season: ep.season, number: ep.number, label,
  });
}

// Poll every followed series for newly-aired episodes. Notifies (and auto-grabs if
// enabled) and refreshes each follow's lastAiredSeen / nextAir / pendingEpisode.
export async function checkFollows() {
  if (!rt.mainWindow || rt.mainWindow.isDestroyed()) return;
  const userData = app.getPath('userData');
  const settings = getSettings(userData);
  const now = Date.now();
  for (const f of loadFollows(userData)) {
    try {
      const { tvmazeId, episodes } = await fetchSeriesEpisodes(f.imdbId, f.tvmazeId);
      if (!episodes.length) continue;
      const ts = (e) => new Date(e.airstamp).getTime();
      const aired = episodes.filter(e => e.airstamp && ts(e) <= now);
      const upcoming = episodes.filter(e => e.airstamp && ts(e) > now).sort((a, b) => ts(a) - ts(b))[0] || null;
      const lastSeen = f.lastAiredSeen ? new Date(f.lastAiredSeen).getTime() : 0;
      const newestAired = aired.reduce((m, e) => Math.max(m, ts(e)), lastSeen);

      const fields = {
        tvmazeId: tvmazeId || f.tvmazeId || null,
        lastAiredSeen: newestAired ? new Date(newestAired).toISOString() : f.lastAiredSeen,
        nextAir: upcoming ? { season: upcoming.season, number: upcoming.number, airstamp: upcoming.airstamp } : null,
      };

      // Only alert on a follow we've already snapshotted (lastAiredSeen set at follow time),
      // to avoid spamming about the whole back-catalogue.
      const fresh = f.lastAiredSeen != null ? aired.filter(e => ts(e) > lastSeen) : [];
      if (fresh.length) {
        const newest = fresh.sort((a, b) => ts(b) - ts(a))[0];
        notifyNewEpisode(f, newest);
        if (settings.autoGrabFollowed) {
          grabFollowedEpisode({ imdbId: f.imdbId, season: newest.season, episode: newest.number, title: f.title, poster: f.poster }).catch(() => {});
        } else {
          fields.pendingEpisode = { season: newest.season, number: newest.number, label: `S${newest.season}E${newest.number}` };
        }
      }
      updateFollow(userData, f.imdbId, fields);
    } catch { /* skip this follow */ }
  }
}
