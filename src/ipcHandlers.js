// The bulk of the renderer→main IPC surface: add/remove/retry torrents, file
// switching, seeding control, queue, history, follows, casting, settings,
// native dialogs, series data, and window controls. Playback (torrent:play*)
// lives in playback.js; metadata/updater register their own handlers.

import { app, ipcMain, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { active, rt } from './runtime.js';
import { getSettings, saveSettings } from './settings.js';
import { detect } from './playerDetector.js';
import { addEntry, loadHistory, removeEntry, updateEntry } from './history.js';
import { loadFollows, addFollow, removeFollow, updateFollow } from './follows.js';
import { markEpisode, getSeriesProgress } from './series-progress.js';
import { fetchMetaFromCinemeta, fetchSeriesEpisodes } from './metadata.js';
import { discoverDevices, castMedia, stopCast, setSubtitles, getLocalIP, resolveHostIPv4 } from './chromecast.js';
import { needsAudioTranscode } from './transcode.js';
import { discoverDlnaDevices, castDlna, stopDlna } from './dlna.js';
import {
  addTorrentInternal, applyQueueRules, saveSession, switchEpisodeFile,
  findSubtitle, focusFile, applyNetworkSettings, pauseSeeding, mimeFor,
} from './torrentManager.js';
import { grabFollowedEpisode, checkFollows } from './watchProgress.js';
import { ensureSubtitle } from './playback.js';
import { srtToVtt, mkvSubtitleVtt } from './subtitles.js';

// Warn (don't block) when free disk space is below the torrent's total size.
// Metadata is resolved by now, so torrent.length is known.
async function checkDiskSpace(id, downloadDir) {
  const entry = active.get(id);
  const need = entry?.torrent?.length;
  if (!need) return null;
  // downloadDir may not be created yet when this runs — fall back to userData,
  // which sits on the same volume in the default config.
  for (const dir of [downloadDir, app.getPath('userData')]) {
    try {
      const stat = await fs.promises.statfs(dir);
      const free = stat.bavail * stat.bsize;
      return free < need ? { free, need } : null;
    } catch {}
  }
  return null;
}

// Subtitle for the casted file as WebVTT text, or null. Sources, in order: a
// .srt/.vtt shipped in the torrent, a text track embedded in the (fully
// downloaded) MKV, then the OpenSubtitles auto-fetch. Chromecast can't read
// ASS/SSA/SUB files or bitmap tracks (PGS/VobSub).
async function loadSubtitleVtt(entry) {
  try {
    const settings = getSettings(app.getPath('userData'));
    const sub = entry.fileState.subtitle;
    if (sub && /\.(srt|vtt)$/i.test(sub.name)) {
      const subPath = path.join(entry.torrent.path, sub.path);
      if (fs.existsSync(subPath)) return srtToVtt(fs.readFileSync(subPath));
    }
    const file = entry.fileState.file;
    if (/\.mkv$/i.test(file.name) && file.progress === 1) {
      const vtt = await mkvSubtitleVtt(path.join(entry.torrent.path, file.path), settings.subtitleLanguage);
      if (vtt) return vtt;
    }
    if (!sub) {
      const fetched = await ensureSubtitle(entry, settings);
      if (fetched && fs.existsSync(fetched)) return srtToVtt(fs.readFileSync(fetched));
    }
  } catch {}
  return null;
}

// Rebind a torrent's stream server from loopback to 0.0.0.0 so a Chromecast on
// the LAN can reach it. Existing connections (e.g. a local player) are dropped —
// acceptable since casting deliberately moves playback to the TV. It stays bound
// to 0.0.0.0 afterwards, but non-loopback requests now require entry.streamToken
// (see the server handler), so the wider bind is not an open LAN endpoint.
function ensureLanReachable(entry) {
  if (entry.host === '0.0.0.0') return Promise.resolve();
  return new Promise((resolve, reject) => {
    entry.server.once('close', () => {
      entry.server.once('error', reject);
      entry.server.listen(entry.port, '0.0.0.0', () => {
        entry.host = '0.0.0.0';
        resolve();
      });
    });
    entry.server.close();
    for (const sock of entry.sockets) sock.destroy();
  });
}

export function safeOpenExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    shell.openExternal(url);
  } catch {}
}

export function registerAppIpc() {
  ipcMain.handle('torrent:add', async (_, source, resumePos = null, episodeContext = null) => {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Invalid source');
    const resume = (typeof resumePos === 'number' && resumePos > 5) ? resumePos : null;
    const epCtx = (episodeContext && typeof episodeContext.id === 'string')
      ? {
          id: episodeContext.id,
          type: episodeContext.type === 'anime' ? 'anime' : 'series',
          season: Number.isInteger(episodeContext.season) ? episodeContext.season : null,
          episode: Number.isInteger(episodeContext.episode) ? episodeContext.episode : null,
          title: typeof episodeContext.title === 'string' ? episodeContext.title : null,
          poster: typeof episodeContext.poster === 'string' ? episodeContext.poster : null,
        }
      : null;

    let torrentId = source;
    const magnet = source.startsWith('magnet:') ? source : null;

    // Early duplicate check via infoHash from magnet URI
    if (magnet) {
      const hashMatch = magnet.match(/xt=urn:btih:([0-9a-f]{40}|[A-Z2-7]{32})/i);
      if (hashMatch) {
        const hash = hashMatch[1].toLowerCase();
        const entry = active.get(hash);
        if (entry) {
          // Same season pack already active — if a different episode was requested,
          // switch the streamed file instead of rejecting as a duplicate.
          if (epCtx && switchEpisodeFile(entry, epCtx)) {
            saveSession();
            return { id: hash, name: entry.fileState.file.name, videoFiles: [], episodeMatched: true, diskWarning: null };
          }
          throw new Error('already_downloading');
        }
      }
    }

    if (!magnet) {
      try { torrentId = fs.readFileSync(source); }
      catch (e) { throw new Error(`Impossible de lire le fichier : ${e.message}`); }
    }
    const settings = getSettings(app.getPath('userData'));
    const result = await addTorrentInternal(torrentId, magnet, settings.downloadDir, resume, epCtx);
    if (active.has(result.id) && rt.queueOrder.includes(result.id)) throw new Error('already_downloading');

    if (!rt.queueOrder.includes(result.id)) {
      rt.queueOrder.push(result.id);
      applyQueueRules();
      saveSession();
    }

    if (result.name) {
      fetchMetaFromCinemeta(result.name).then(meta => {
        const entry = active.get(result.id);
        if (entry && meta) entry.meta = meta;
      }).catch(() => {});
    }

    return { ...result, diskWarning: await checkDiskSpace(result.id, settings.downloadDir) };
  });

  ipcMain.handle('torrent:changeFile', (_, id, fileIndex) => {
    const entry = active.get(id);
    if (!entry) throw new Error('Torrent introuvable');
    const file = entry.torrent.files[fileIndex];
    if (!file) throw new Error('Fichier introuvable');
    entry.fileState.file = file;
    entry.fileState.subtitle = findSubtitle(entry.torrent.files, file);
    focusFile(entry.torrent, file, entry.downloadAll);
    return true;
  });

  // "Download the whole season": keep every file of the pack downloading, the
  // currently selected episode first. Idempotent; persisted so a restart/retry
  // doesn't silently narrow the download back to one episode.
  ipcMain.handle('torrent:downloadAll', (_, id) => {
    const entry = active.get(id);
    if (!entry) throw new Error('Torrent introuvable');
    entry.downloadAll = true;
    focusFile(entry.torrent, entry.fileState.file, true);
    saveSession();
    return true;
  });

  ipcMain.handle('torrent:stopSeed', (_, id) => {
    const entry = active.get(id);
    if (!entry) return;
    const t = entry.torrent;
    if (t.paused) {
      // Resume seeding: restore upload slots, then reconnect/unchoke as usual.
      t._rechokeNumSlots = 10;
      t.resume();
    } else {
      pauseSeeding(t);
    }
    return true;
  });

  ipcMain.handle('torrent:remove', (_, id) => {
    const entry = active.get(id);
    if (!entry) return;

    const magnet = entry.magnet || entry.torrent.magnetURI;
    if (magnet) {
      addEntry(app.getPath('userData'), {
        id,
        name: entry.fileState.file?.name || entry.torrent.name,
        magnet,
        watchedAt: new Date().toISOString(),
        resumePos: entry.resumePos || null,
        resumeDuration: entry.resumeDuration || null,
        ...(entry.meta || {}),
      });
    }

    entry.playback?.socket?.destroy();
    clearTimeout(entry._vlcTimer);
    entry.server.close();
    entry.torrent.destroy();
    active.delete(id);
    rt.queueOrder = rt.queueOrder.filter(i => i !== id);
    applyQueueRules();
    saveSession();
    return true;
  });

  // Re-add the same magnet to force a fresh DHT/tracker peer search (for stalled
  // torrents with no episode context to switch streams). The infoHash — and thus
  // the card id — is unchanged, so the queue position is preserved automatically.
  ipcMain.handle('torrent:retry', async (_, id) => {
    const entry = active.get(id);
    if (!entry) throw new Error('Torrent introuvable');
    const magnet = entry.magnet || entry.torrent.magnetURI;
    if (!magnet) throw new Error('Pas de magnet à relancer');
    const episodeContext = entry.episodeContext || null;
    const resumePos = entry.resumePos || null;
    const downloadAll = !!entry.downloadAll;
    const settings = getSettings(app.getPath('userData'));

    entry.playback?.socket?.destroy();
    clearTimeout(entry._vlcTimer);
    entry.server.close();
    await new Promise(res => entry.torrent.destroy({}, () => res()));
    active.delete(id);

    const result = await addTorrentInternal(magnet, magnet, settings.downloadDir, resumePos, episodeContext, downloadAll);
    applyQueueRules();
    saveSession();
    if (result.name) {
      fetchMetaFromCinemeta(result.name).then(meta => {
        const e = active.get(result.id);
        if (e && meta) e.meta = meta;
      }).catch(() => {});
    }
    return result;
  });

  ipcMain.handle('queue:reorder', (_, order) => {
    rt.queueOrder = order;
    applyQueueRules();
    saveSession();
    return true;
  });

  ipcMain.handle('history:get', () => loadHistory(app.getPath('userData')));

  ipcMain.handle('history:fetchMeta', async (_, id, name) => {
    const meta = await fetchMetaFromCinemeta(name);
    if (meta) updateEntry(app.getPath('userData'), id, meta);
    return meta;
  });

  ipcMain.handle('history:remove', (_, id) => {
    removeEntry(app.getPath('userData'), id);
    return true;
  });

  ipcMain.handle('follow:list', () => loadFollows(app.getPath('userData')));

  ipcMain.handle('follow:add', async (_, item) => {
    if (!item?.imdbId) throw new Error('imdbId requis');
    const userData = app.getPath('userData');
    // Snapshot current episode state so we don't alert about already-aired episodes.
    const { tvmazeId, episodes } = await fetchSeriesEpisodes(item.imdbId);
    const now = Date.now();
    const ts = (e) => new Date(e.airstamp).getTime();
    const aired = episodes.filter(e => e.airstamp && ts(e) <= now);
    const upcoming = episodes.filter(e => e.airstamp && ts(e) > now).sort((a, b) => ts(a) - ts(b))[0] || null;
    const newestAired = aired.reduce((m, e) => Math.max(m, ts(e)), 0);
    addFollow(userData, {
      imdbId: item.imdbId, type: 'series', title: item.title || item.imdbId, poster: item.poster || null,
      tvmazeId: tvmazeId || null,
      lastAiredSeen: newestAired ? new Date(newestAired).toISOString() : null,
      nextAir: upcoming ? { season: upcoming.season, number: upcoming.number, airstamp: upcoming.airstamp } : null,
      pendingEpisode: null,
    });
    return loadFollows(userData);
  });

  ipcMain.handle('follow:remove', (_, imdbId) => {
    removeFollow(app.getPath('userData'), imdbId);
    return loadFollows(app.getPath('userData'));
  });

  ipcMain.handle('follow:check', async () => {
    await checkFollows();
    return loadFollows(app.getPath('userData'));
  });

  ipcMain.handle('follow:grab', async (_, imdbId) => {
    const userData = app.getPath('userData');
    const f = loadFollows(userData).find(x => x.imdbId === imdbId);
    if (!f || !f.pendingEpisode) throw new Error('Aucun épisode à télécharger');
    const ep = f.pendingEpisode;
    const result = await grabFollowedEpisode({ imdbId, season: ep.season, episode: ep.number, title: f.title, poster: f.poster });
    if (!result) throw new Error('Aucun stream trouvé');
    updateFollow(userData, imdbId, { pendingEpisode: null });
    return result;
  });

  ipcMain.handle('cast:discover', async () => {
    const [cc, dlna] = await Promise.all([discoverDevices(4000), discoverDlnaDevices(4000)]);
    const ccTagged = cc.map(d => ({ ...d, type: 'chromecast' }));
    const seen = new Set(ccTagged.map(d => d.host));
    return [...ccTagged, ...dlna.filter(d => !seen.has(d.host))];
  });

  ipcMain.handle('cast:play', async (_, id, host, deviceType) => {
    const entry = active.get(id);
    if (!entry) throw new Error('Torrent introuvable');
    await ensureLanReachable(entry);
    const base = `http://${getLocalIP(await resolveHostIPv4(host))}:${entry.port}/${entry.streamToken}`;
    // Receivers stay silent on audio they can't decode (E-AC-3, DTS…): convert it on the fly.
    const convert = await needsAudioTranscode(`http://127.0.0.1:${entry.port}/`);
    const url = convert ? `${base}/t.mp4` : base;
    const type = convert ? 'video/mp4' : mimeFor(entry.fileState.file.name);
    if (deviceType === 'dlna') await castDlna(host, url, type);
    else {
      entry.subVtt = await loadSubtitleVtt(entry);
      entry.castSubsOn = !!entry.subVtt;
      await castMedia(host, url, type, entry.subVtt ? `${base}/sub.vtt` : null);
    }
    entry.casting = host;
    entry.castType = deviceType;
    return true;
  });

  ipcMain.handle('cast:subtitles', async (_, id, on) => {
    const entry = active.get(id);
    if (!entry?.casting || !entry.subVtt || entry.castType === 'dlna') return false;
    entry.castSubsOn = !!on;
    await setSubtitles(entry.casting, !!on);
    return true;
  });

  ipcMain.handle('cast:stop', async (_, id) => {
    const entry = active.get(id);
    if (!entry || !entry.casting) return false;
    const host = entry.casting;
    entry.casting = null;
    if (entry.castType === 'dlna') await stopDlna(host);
    else await stopCast(host);
    return true;
  });

  ipcMain.on('update:openRelease', (_, url) => safeOpenExternal(url));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.on('app:openExternal', (_, url) => safeOpenExternal(url));

  ipcMain.handle('settings:get', () => getSettings(app.getPath('userData')));

  ipcMain.handle('settings:save', (_, settings) => {
    saveSettings(app.getPath('userData'), settings);
    applyNetworkSettings(settings);
    return true;
  });

  ipcMain.handle('players:detect', () => detect());

  ipcMain.handle('dialog:torrent', async () => {
    const r = await dialog.showOpenDialog(rt.mainWindow, {
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:player', async () => {
    const filters = process.platform === 'win32'
      ? [{ name: 'Exécutables', extensions: ['exe'] }]
      : process.platform === 'darwin'
      ? [{ name: 'Applications', extensions: ['app', '*'] }]
      : [{ name: 'Tous les fichiers', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(rt.mainWindow, { filters, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:directory', async () => {
    const r = await dialog.showOpenDialog(rt.mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('series:episodes', async (_, imdbId, tvmazeId) => {
    return fetchSeriesEpisodes(imdbId, tvmazeId || null);
  });

  ipcMain.handle('series:progress', (_, imdbId) => {
    return getSeriesProgress(app.getPath('userData'), imdbId);
  });

  ipcMain.handle('series:markWatched', (_, imdbId, season, episode, watched) => {
    markEpisode(app.getPath('userData'), imdbId, season, episode, watched !== false);
    return true;
  });

  // --- Window controls ---

  ipcMain.on('window:minimize', () => rt.mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (rt.mainWindow?.isMaximized()) rt.mainWindow.restore();
    else rt.mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => {
    if (!app.isQuitting) rt.mainWindow?.hide();
  });
  ipcMain.handle('window:isMaximized', () => rt.mainWindow?.isMaximized() ?? false);
}
