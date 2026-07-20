// Watch-progress (Continue Watching), the "play next episode" offer, and
// followed-series tracking with new-episode alerts. Reads playback position off
// the `active` map entries and pushes updates to the renderer / history.

import { app, Notification } from 'electron';
import { active, rt } from './runtime.js';
import { getSettings } from './settings.js';
import { addEntry } from './history.js';
import { markEpisode } from './series-progress.js';
import { fetchTorrentioStreams, pickBestTorrentioStream, fetchSeriesEpisodes } from './metadata.js';
import { loadFollows, updateFollow } from './follows.js';
import { addTorrentInternal, applyQueueRules, saveSession } from './torrentManager.js';

export function persistWatchProgress(id) {
  const entry = active.get(id);
  if (!entry || !entry.resumePos) return;
  const magnet = entry.magnet || entry.torrent.magnetURI;
  if (!magnet) return;
  const watched = entry.resumeDuration > 0 && entry.resumePos / entry.resumeDuration >= 0.85;
  addEntry(app.getPath('userData'), {
    id,
    name: entry.fileState.file?.name || entry.torrent.name,
    magnet,
    watchedAt: new Date().toISOString(),
    resumePos: entry.resumePos,
    resumeDuration: entry.resumeDuration || null,
    watched,
    ...(entry.meta || {}),
  });
  if (watched && entry.episodeContext?.id && entry.episodeContext?.season != null && entry.episodeContext?.episode != null) {
    markEpisode(app.getPath('userData'), entry.episodeContext.id, entry.episodeContext.season, entry.episodeContext.episode, true);
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
