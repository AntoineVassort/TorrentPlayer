import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, Notification, clipboard, shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import WebTorrent from 'webtorrent';
import { detect } from './playerDetector.js';
import { getSettings, saveSettings } from './settings.js';
import { addEntry, loadHistory, removeEntry, updateEntry } from './history.js';
import { loadFollows, addFollow, removeFollow, updateFollow } from './follows.js';
import { discoverDevices, castMedia, getLocalIP } from './chromecast.js';
import { discoverDlnaDevices, castDlna } from './dlna.js';
import { markEpisode, getSeriesProgress } from './series-progress.js';
import { fetchSubtitle, cleanReleaseName, parseSeasonEpisode } from './subtitles.js';
import { fetchMetaFromCinemeta, registerMetadataIpc, fetchTorrentioStreams, pickBestTorrentioStream, fetchSeriesEpisodes } from './metadata.js';
import { registerUpdaterIpc } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerMetadataIpc();
registerUpdaterIpc(() => mainWindow);

function semverNewer(latest, current) {
  const p = v => v.replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc = 0] = p(latest);
  const [ca, cb, cc = 0] = p(current);
  return la !== ca ? la > ca : lb !== cb ? lb > cb : lc > cc;
}

async function checkForUpdates(win) {
  try {
    const res = await fetch('https://api.github.com/repos/AntoineVassort/TorrentPlayer/releases/latest', {
      headers: { 'User-Agent': 'TorrentPlayer' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.tag_name && semverNewer(data.tag_name, app.getVersion())) {
      win.webContents.send('update:available', { version: data.tag_name, url: data.html_url });
    }
  } catch {}
}

const VIDEO_EXTENSIONS    = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv'];
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

function isVideo(name)    { return VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()); }
function isSubtitle(name) { return SUBTITLE_EXTENSIONS.includes(path.extname(name).toLowerCase()); }

function findSubtitle(files, videoFile) {
  const base = path.basename(videoFile.name, path.extname(videoFile.name)).toLowerCase();
  return files.find(f => {
    if (!isSubtitle(f.name)) return false;
    const subBase = path.basename(f.name, path.extname(f.name)).toLowerCase();
    return subBase === base || subBase.startsWith(base);
  }) || null;
}

function applyThrottle(settings) {
  const dl = settings.maxDownload ? settings.maxDownload * 1024 : -1;
  const ul = settings.maxUpload  ? settings.maxUpload  * 1024 : -1;
  client.throttleDownload(dl);
  client.throttleUpload(ul);
}

// --- Session persistence ---

function sessionPath() { return path.join(app.getPath('userData'), 'session.json'); }

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (Array.isArray(data)) return { torrents: data, queueOrder: [] };
    return { torrents: data.torrents || [], queueOrder: data.queueOrder || [] };
  } catch {
    return { torrents: [], queueOrder: [] };
  }
}

function saveSession() {
  const torrents = [...active.values()].map(({ torrent, magnet, resumePos }) => ({
    magnet: magnet || torrent.magnetURI,
    name: torrent.name,
    resumePos: resumePos || null,
  }));
  fs.writeFileSync(sessionPath(), JSON.stringify({ torrents, queueOrder }, null, 2));
}

// --- Queue ---

function applyQueueRules() {
  const downloading = [...active.entries()]
    .filter(([, e]) => !e.torrent.done)
    .sort(([idA], [idB]) => {
      const a = queueOrder.indexOf(idA);
      const b = queueOrder.indexOf(idB);
      return (a === -1 ? Infinity : a) - (b === -1 ? Infinity : b);
    });

  downloading.forEach(([, entry], i) => {
    if (i === 0) {
      if (entry.queuePaused) { entry.torrent.resume(); entry.queuePaused = false; }
    } else {
      if (!entry.torrent.paused) { entry.torrent.pause(); entry.queuePaused = true; }
    }
  });
}

// --- State ---

let mainWindow = null;
let tray = null;
let queueOrder = [];
const client = new WebTorrent();

// Map<infoHash, { torrent, fileState, server, port, magnet, speedHistory, playback, resumePos, queuePaused, meta, casting }>
const active = new Map();

// --- Window ---

let boundsTimer = null;

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    const s = getSettings(app.getPath('userData'));
    saveSettings(app.getPath('userData'), { ...s, windowBounds: mainWindow.getBounds() });
  }, 500);
}

function createWindow() {
  const settings = getSettings(app.getPath('userData'));
  const bounds = settings.windowBounds || {};

  mainWindow = new BrowserWindow({
    width:     bounds.width  || 820,
    height:    bounds.height || 600,
    x:         bounds.x,
    y:         bounds.y,
    minWidth:  580,
    minHeight: 420,
    frame:     false,
    icon:      path.join(__dirname, 'assets/app.ico'),
    backgroundColor: '#0f0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move',   saveBounds);
  mainWindow.on('maximize',   () => mainWindow.webContents.send('window:maximize'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:unmaximize'));

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  mainWindow.on('focus', () => {
    const text = clipboard.readText().trim();
    if (text.startsWith('magnet:')) mainWindow.webContents.send('clipboard:magnet', text);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('TorrentPlayer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    mainWindow?.isVisible() ? mainWindow.focus() : mainWindow?.show();
  });
}

// --- mpv IPC ---

function isMpv(playerPath) {
  return path.basename(playerPath).toLowerCase().startsWith('mpv');
}

function isVlc(playerPath) {
  return path.basename(playerPath).toLowerCase().startsWith('vlc');
}

function playerKind(playerPath) {
  return isMpv(playerPath) ? 'mpv' : isVlc(playerPath) ? 'vlc' : 'other';
}

// Builds the resume + progress-tracking CLI args for the chosen player and returns
// the info needed to start tracking after spawn. Clears entry.resumePos (consumed).
function buildPlaybackArgs(entry, player, id) {
  const kind = playerKind(player.path);
  const args = [];
  if (entry.resumePos > 5) {
    if (kind === 'mpv') args.push(`--start=${Math.floor(entry.resumePos)}`);
    else if (kind === 'vlc') args.push(`--start-time=${Math.floor(entry.resumePos)}`);
  }
  entry.resumePos = null;

  let vlc = null;
  if (kind === 'mpv') {
    args.push(`--input-ipc-server=${mpvPipePath(id)}`);
  } else if (kind === 'vlc') {
    const port = 9000 + (entry.port - 8888);
    const pwd = crypto.randomBytes(12).toString('hex');
    args.push('--extraintf=http', '--http-host=127.0.0.1', `--http-port=${port}`, `--http-password=${pwd}`);
    vlc = { port, pwd };
  }
  return { kind, args, vlc };
}

function startPlaybackTracking(id, kind, vlc) {
  if (kind === 'mpv') connectMpvIPC(id);
  else if (kind === 'vlc' && vlc) connectVlcHttp(id, vlc.port, vlc.pwd);
}

function mpvPipePath(id) {
  const short = id.slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mpvTP-${short}`
    : `/tmp/mpvTP-${short}`;
}

function connectMpvIPC(id) {
  const entry = active.get(id);
  if (!entry || entry.playback) return;

  const pipePath = mpvPipePath(id);
  let retries = 0;

  const tryConnect = () => {
    const socket = net.createConnection(pipePath);
    let buffer = '';

    socket.on('connect', () => {
      entry.playback = { socket, pos: 0, duration: 0 };
      socket.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
      socket.write(JSON.stringify({ command: ['observe_property', 2, 'duration'] }) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'property-change') {
            if (msg.name === 'time-pos' && msg.data != null) entry.playback.pos = msg.data;
            else if (msg.name === 'duration' && msg.data != null) entry.playback.duration = msg.data;
          }
        } catch {}
      }
    });

    socket.on('close', () => {
      if (!entry.playback) return;
      entry.resumePos = entry.playback.pos > 5 ? entry.playback.pos : null;
      entry.resumeDuration = entry.playback.duration || entry.resumeDuration || null;
      entry.playback = null;
      saveSession();
      persistWatchProgress(id);
      maybeOfferNextEpisode(id).catch(() => {});
    });

    socket.on('error', () => {
      socket.destroy();
      if (retries < 15) { retries++; setTimeout(tryConnect, 400); }
    });
  };

  setTimeout(tryConnect, 500);
}

// VLC exposes time/length over its HTTP interface (--extraintf=http). We poll
// /requests/status.json; when VLC is closed the request fails — after a few misses
// we treat it as "playback ended" and save the resume position (same as mpv).
function connectVlcHttp(id, port, password) {
  const entry = active.get(id);
  if (!entry || entry.playback) return;
  entry.playback = { pos: 0, duration: 0, vlc: true };
  const auth = 'Basic ' + Buffer.from(':' + password).toString('base64');
  let misses = 0;

  const poll = async () => {
    const cur = active.get(id);
    if (!cur || !cur.playback) return;            // removed or ended
    try {
      const res = await fetch(`http://127.0.0.1:${port}/requests/status.json`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const s = await res.json();
        misses = 0;
        if (typeof s.time === 'number') cur.playback.pos = s.time;
        if (typeof s.length === 'number' && s.length > 0) cur.playback.duration = s.length;
        if (s.state === 'stopped' && cur.playback.pos > 0) { endVlcPlayback(id); return; }
      } else {
        misses++;
      }
    } catch { misses++; }
    if (misses >= 5) { endVlcPlayback(id); return; }
    cur._vlcTimer = setTimeout(poll, 1000);
  };

  // Give VLC ~2 s to boot its HTTP interface before the first poll.
  entry._vlcTimer = setTimeout(poll, 2000);
}

function endVlcPlayback(id) {
  const entry = active.get(id);
  if (!entry || !entry.playback) return;
  clearTimeout(entry._vlcTimer);
  entry.resumePos = entry.playback.pos > 5 ? entry.playback.pos : null;
  entry.resumeDuration = entry.playback.duration || entry.resumeDuration || null;
  entry.playback = null;
  saveSession();
  persistWatchProgress(id);
  maybeOfferNextEpisode(id).catch(() => {});
}

// --- Subtitles (OpenSubtitles auto-fetch) ---

async function ensureSubtitle(entry, settings) {
  if (entry.fileState.subtitle) return null;            // embedded .srt present
  if (entry.fetchedSubPath && fs.existsSync(entry.fetchedSubPath)) return entry.fetchedSubPath;

  const lang = settings.subtitleLanguage;
  const key = settings.openSubtitlesApiKey;
  if (!lang || lang === 'off' || !key) return null;

  try {
    const fileName = entry.fileState.file?.name || entry.torrent.name;
    const { season, episode } = parseSeasonEpisode(fileName);
    const result = await fetchSubtitle(key, {
      query: cleanReleaseName(fileName),
      language: lang,
      season,
      episode,
      userAgent: `TorrentPlayer v${app.getVersion()}`,
    });
    if (!result) return null;

    const videoFull = path.join(entry.torrent.path, entry.fileState.file.path);
    const dir = path.dirname(videoFull);
    const base = path.basename(videoFull, path.extname(videoFull));
    const subPath = path.join(dir, `${base}.${lang}.srt`);
    fs.writeFileSync(subPath, result.text, 'utf8');
    entry.fetchedSubPath = subPath;
    return subPath;
  } catch { return null; }
}

// --- Watch progress (Continue Watching) ---

function persistWatchProgress(id) {
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
async function maybeOfferNextEpisode(id) {
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
  mainWindow?.webContents.send('episode:next', {
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
async function grabFollowedEpisode({ imdbId, season, episode, title, poster }) {
  const settings = getSettings(app.getPath('userData'));
  const streams = await fetchTorrentioStreams(imdbId, 'series', season, episode, settings.torrentioUrl);
  const best = pickBestTorrentioStream(streams);
  if (!best || !best.magnet) return null;
  const result = await addTorrentInternal(best.magnet, best.magnet, settings.downloadDir, null, {
    id: imdbId, type: 'series', season, episode, title: title || null, poster: poster || null,
  });
  if (!queueOrder.includes(result.id)) {
    queueOrder.push(result.id);
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
  mainWindow?.webContents.send('follow:newEpisode', {
    imdbId: follow.imdbId, title: follow.title, poster: follow.poster, season: ep.season, number: ep.number, label,
  });
}

// Poll every followed series for newly-aired episodes. Notifies (and auto-grabs if
// enabled) and refreshes each follow's lastAiredSeen / nextAir / pendingEpisode.
async function checkFollows() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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

// --- Add torrent (shared logic) ---

function addTorrentInternal(torrentId, magnet, downloadDir, resumePos = null, episodeContext = null) {
  return new Promise((resolve, reject) => {
    const opts = downloadDir ? { path: downloadDir } : {};

    const pending = client.add(torrentId, opts, (torrent) => {
      clearTimeout(timer);
      if (active.has(torrent.infoHash)) {
        return resolve({ id: torrent.infoHash, name: torrent.name, videoFiles: [] });
      }

      const videoFiles = torrent.files
        .filter(f => isVideo(f.name))
        .map((f, _, arr) => ({ name: f.name, size: f.length, index: torrent.files.indexOf(f) }))
        .sort((a, b) => b.size - a.size);

      if (!videoFiles.length) {
        client.remove(torrent.infoHash);
        return reject(new Error('Aucun fichier vidéo dans ce torrent'));
      }

      const file = torrent.files[videoFiles[0].index];
      const subtitle = findSubtitle(torrent.files, file);
      const fileState = { file, subtitle };

      const server = http.createServer((req, res) => {
        const f = fileState.file;
        const total = f.length;
        const range = req.headers['range'];
        if (range) {
          const [s, e] = range.replace('bytes=', '').split('-');
          const start = parseInt(s, 10);
          const end = e ? parseInt(e, 10) : total - 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': 'video/mp4',
          });
          const stream = f.createReadStream({ start, end });
          stream.on('error', () => {}); stream.pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
          const stream = f.createReadStream();
          stream.on('error', () => {}); stream.pipe(res);
        }
      });

      // Track live connections so the server can be torn down / rebound cleanly.
      const sockets = new Set();
      server.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });

      // Bind to loopback only by default — the stream is reachable from this
      // machine, not the whole LAN. ensureLanReachable() rebinds to 0.0.0.0
      // on demand when the user casts (Chromecast needs LAN access).
      const tryListen = (port) => {
        server.listen(port, '127.0.0.1', () => {
          active.set(torrent.infoHash, {
            torrent, fileState, server, port, magnet, sockets, host: '127.0.0.1',
            speedHistory: [], playback: null, resumePos,
            queuePaused: false, meta: null, casting: null,
            episodeContext: episodeContext || null,
          });
          saveSession();

          torrent.once('done', () => {
            if (Notification.isSupported()) {
              const s = getSettings(app.getPath('userData'));
              const body = s.language === 'fr'
                ? `${fileState.file.name} — téléchargement terminé`
                : `${fileState.file.name} — download complete`;
              new Notification({ title: 'TorrentPlayer', body }).show();
            }
            tray?.setToolTip('TorrentPlayer');
            applyQueueRules();
          });

          resolve({ id: torrent.infoHash, name: file.name, videoFiles: videoFiles.length > 1 ? videoFiles : [] });
        });
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') tryListen(port + 1);
          else reject(err);
        });
      };
      tryListen(8888);
    });

    const timer = setTimeout(() => {
      try { client.remove(pending); } catch {}
      reject(new Error('Aucun peer trouvé (timeout 60s). Essayez un autre stream.'));
    }, 60000);
  });
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Progress updates
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const state = [...active.values()].map(({ torrent, fileState, port, speedHistory, playback, resumePos, resumeDuration, meta, casting, episodeContext }) => {
      speedHistory.push(torrent.downloadSpeed);
      if (speedHistory.length > 30) speedHistory.shift();

      const file = fileState.file;
      const fileProgress = file && file.length > 0 ? file.downloaded / file.length : torrent.progress;
      return {
        id: torrent.infoHash,
        name: file ? file.name : torrent.name,
        size: file ? file.length : 0,
        downloaded: file ? file.downloaded : 0,
        progress: fileProgress,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        numPeers: torrent.numPeers,
        done: torrent.done,
        paused: torrent.paused,
        ready: fileProgress >= 0.05 || torrent.done,
        timeRemaining: torrent.timeRemaining,
        hasSubtitle: !!fileState.subtitle,
        speedHistory: [...speedHistory],
        playback: playback ? { pos: playback.pos, duration: playback.duration } : null,
        resumePos: resumePos || null,
        resumeDuration: resumeDuration || null,
        port,
        meta: meta || null,
        queuePos: queueOrder.indexOf(torrent.infoHash),
        casting: casting || null,
        episodeContext: episodeContext || null,
      };
    });

    mainWindow.webContents.send('torrent:state', state);

    // Update tray tooltip with live download speed
    if (tray) {
      const downloading = state.filter(s => !s.done);
      if (downloading.length) {
        const totalDl = downloading.reduce((s, t) => s + t.downloadSpeed, 0);
        const fmtSpd = totalDl < 1024 * 1024
          ? `${(totalDl / 1024).toFixed(0)} KB/s`
          : `${(totalDl / 1024 / 1024).toFixed(1)} MB/s`;
        tray.setToolTip(`TorrentPlayer — ↓ ${fmtSpd} · ${downloading.length} active`);
      } else {
        tray.setToolTip('TorrentPlayer');
      }
    }
  }, 1000);

  // Check for updates
  mainWindow.webContents.once('did-finish-load', () => checkForUpdates(mainWindow));

  // Followed-series new-episode poll: once shortly after launch, then every 6 h.
  setTimeout(() => { checkFollows().catch(() => {}); }, 20000);
  setInterval(() => { checkFollows().catch(() => {}); }, 6 * 60 * 60 * 1000);

  // Restore session
  mainWindow.webContents.once('did-finish-load', async () => {
    const settings = getSettings(app.getPath('userData'));
    applyThrottle(settings);
    const { torrents, queueOrder: savedQueue } = loadSession();
    queueOrder = savedQueue;
    for (const { magnet, resumePos } of torrents) {
      try {
        const result = await addTorrentInternal(magnet, magnet, settings.downloadDir, resumePos);
        if (result.name) {
          fetchMetaFromCinemeta(result.name).then(meta => {
            const entry = active.get(result.id);
            if (entry && meta) entry.meta = meta;
          }).catch(() => {});
        }
      } catch { /* skip */ }
    }
    applyQueueRules();
  });
});

app.on('before-quit', (event) => {
  app.isQuitting = true;
  // Idempotent: the deleteAfterPlay branch calls app.quit() again from its .finally,
  // which re-fires before-quit. Tear down only once to avoid double client.destroy().
  if (app.tornDown) return;
  app.tornDown = true;
  const settings = getSettings(app.getPath('userData'));

  if (settings.deleteAfterPlay && active.size > 0) {
    event.preventDefault();
    const toDelete = [...active.values()].map(e => {
      const ref = e.torrent;
      try { e.server.close(); } catch {}
      try { if (!e.torrent.destroyed) e.torrent.destroy(); } catch {}
      return ref;
    });
    active.clear();
    queueOrder = [];
    saveSession();
    try { if (!client.destroyed) client.destroy(); } catch {}
    Promise.all(toDelete.map(deleteTorrentFiles)).finally(() => app.quit());
  } else {
    saveSession();
    try { if (!client.destroyed) client.destroy(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---

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
      if (active.has(hash)) throw new Error('already_downloading');
    }
  }

  if (!magnet) {
    try { torrentId = fs.readFileSync(source); }
    catch (e) { throw new Error(`Impossible de lire le fichier : ${e.message}`); }
  }
  const settings = getSettings(app.getPath('userData'));
  const result = await addTorrentInternal(torrentId, magnet, settings.downloadDir, resume, epCtx);
  if (active.has(result.id) && queueOrder.includes(result.id)) throw new Error('already_downloading');

  if (!queueOrder.includes(result.id)) {
    queueOrder.push(result.id);
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

ipcMain.handle('torrent:changeFile', (_, id, fileIndex) => {
  const entry = active.get(id);
  if (!entry) throw new Error('Torrent introuvable');
  const file = entry.torrent.files[fileIndex];
  if (!file) throw new Error('Fichier introuvable');
  entry.fileState.file = file;
  entry.fileState.subtitle = findSubtitle(entry.torrent.files, file);
  return true;
});

async function deleteTorrentFiles(torrent) {
  const folder = path.join(torrent.path, torrent.name);
  try {
    await fs.promises.rm(folder, { recursive: true, force: true });
    return;
  } catch {}
  for (const f of torrent.files) {
    try { await fs.promises.unlink(path.join(torrent.path, f.path)); } catch {}
  }
}

ipcMain.handle('torrent:play', async (_, id) => {
  const entry = active.get(id);
  if (!entry) throw new Error('Torrent introuvable');

  const settings = getSettings(app.getPath('userData'));
  const player = settings.player || detect()[0];
  if (!player) throw new Error('Aucun player configuré. Ouvrez les paramètres.');
  if (!fs.existsSync(player.path)) throw new Error(`Player introuvable : ${player.path}`);

  const subArgs = [];
  if (entry.fileState.subtitle) {
    const subPath = path.join(
      settings.downloadDir || app.getPath('downloads'),
      entry.torrent.name,
      entry.fileState.subtitle.path
    );
    if (fs.existsSync(subPath)) subArgs.push(`--sub-file=${subPath}`);
  } else {
    const fetched = await ensureSubtitle(entry, settings);
    if (fetched) subArgs.push(`--sub-file=${fetched}`);
  }

  const { kind, args: extraArgs, vlc } = buildPlaybackArgs(entry, player, id);

  const url = `http://localhost:${entry.port}/`;
  const child = spawn(player.path, [...(player.args || []), ...subArgs, ...extraArgs, url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});

  startPlaybackTracking(id, kind, vlc);

  child.unref();
  return true;
});

ipcMain.handle('torrent:stopSeed', (_, id) => {
  const entry = active.get(id);
  if (!entry) return;
  if (entry.torrent.paused) entry.torrent.resume();
  else entry.torrent.pause();
  return true;
});

ipcMain.handle('torrent:playLocal', async (_, id) => {
  const entry = active.get(id);
  if (!entry) throw new Error('Torrent introuvable');

  const settings = getSettings(app.getPath('userData'));
  const player = settings.player || detect()[0];
  if (!player) throw new Error('Aucun player configuré. Ouvrez les paramètres.');
  if (!fs.existsSync(player.path)) throw new Error(`Player introuvable : ${player.path}`);

  const filePath = path.join(entry.torrent.path, entry.fileState.file.path);
  if (!fs.existsSync(filePath)) throw new Error(`Fichier introuvable sur le disque : ${filePath}`);

  const subArgs = [];
  if (entry.fileState.subtitle) {
    const subPath = path.join(entry.torrent.path, entry.fileState.subtitle.path);
    if (fs.existsSync(subPath)) subArgs.push(`--sub-file=${subPath}`);
  } else {
    const fetched = await ensureSubtitle(entry, settings);
    if (fetched) subArgs.push(`--sub-file=${fetched}`);
  }

  const { kind, args: extraArgs, vlc } = buildPlaybackArgs(entry, player, id);

  const child = spawn(player.path, [...(player.args || []), ...subArgs, ...extraArgs, filePath], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  startPlaybackTracking(id, kind, vlc);
  child.unref();
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
  queueOrder = queueOrder.filter(i => i !== id);
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
  const settings = getSettings(app.getPath('userData'));

  entry.playback?.socket?.destroy();
  clearTimeout(entry._vlcTimer);
  entry.server.close();
  await new Promise(res => entry.torrent.destroy({}, () => res()));
  active.delete(id);

  const result = await addTorrentInternal(magnet, magnet, settings.downloadDir, resumePos, episodeContext);
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
  queueOrder = order;
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

// Rebind a torrent's stream server from loopback to 0.0.0.0 so a Chromecast on
// the LAN can reach it. Existing connections (e.g. a local player) are dropped —
// acceptable since casting deliberately moves playback to the TV. Once exposed
// it stays exposed (0.0.0.0 already covers loopback).
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

ipcMain.handle('cast:play', async (_, id, host, deviceType) => {
  const entry = active.get(id);
  if (!entry) throw new Error('Torrent introuvable');
  await ensureLanReachable(entry);
  const url = `http://${getLocalIP()}:${entry.port}/`;
  if (deviceType === 'dlna') await castDlna(host, url);
  else await castMedia(host, url);
  entry.casting = host;
  return true;
});

function safeOpenExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    shell.openExternal(url);
  } catch {}
}

ipcMain.on('update:openRelease', (_, url) => safeOpenExternal(url));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('app:openExternal', (_, url) => safeOpenExternal(url));

ipcMain.handle('settings:get', () => getSettings(app.getPath('userData')));

ipcMain.handle('settings:save', (_, settings) => {
  saveSettings(app.getPath('userData'), settings);
  applyThrottle(settings);
  return true;
});

ipcMain.handle('players:detect', () => detect());

ipcMain.handle('dialog:torrent', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
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
  const r = await dialog.showOpenDialog(mainWindow, { filters, properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
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

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => {
  if (!app.isQuitting) mainWindow?.hide();
});
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
