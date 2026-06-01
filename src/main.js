import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, Notification, clipboard, shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import net from 'net';
import fs from 'fs';
import { spawn } from 'child_process';
import WebTorrent from 'webtorrent';
import { detect } from './playerDetector.js';
import { getSettings, saveSettings } from './settings.js';
import { addEntry, loadHistory, removeEntry, updateEntry } from './history.js';
import { discoverDevices, castMedia, getLocalIP } from './chromecast.js';
import { fetchSubtitle, cleanReleaseName, parseSeasonEpisode } from './subtitles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function pickFile(files) {
  const videos = files.filter(f => isVideo(f.name));
  if (!videos.length) return null;
  return videos.reduce((a, b) => (a.length > b.length ? a : b));
}

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
    });

    socket.on('error', () => {
      socket.destroy();
      if (retries < 15) { retries++; setTimeout(tryConnect, 400); }
    });
  };

  setTimeout(tryConnect, 500);
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
  addEntry(app.getPath('userData'), {
    id,
    name: entry.fileState.file?.name || entry.torrent.name,
    magnet,
    watchedAt: new Date().toISOString(),
    resumePos: entry.resumePos,
    resumeDuration: entry.resumeDuration || null,
    ...(entry.meta || {}),
  });
}

// --- Add torrent (shared logic) ---

function addTorrentInternal(torrentId, magnet, downloadDir, resumePos = null) {
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

      const tryListen = (port) => {
        server.listen(port, () => {
          active.set(torrent.infoHash, {
            torrent, fileState, server, port, magnet,
            speedHistory: [], playback: null, resumePos,
            queuePaused: false, meta: null, casting: null,
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

    const state = [...active.values()].map(({ torrent, fileState, port, speedHistory, playback, resumePos, resumeDuration, meta, casting }) => {
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
  const settings = getSettings(app.getPath('userData'));

  if (settings.deleteAfterPlay && active.size > 0) {
    event.preventDefault();
    const toDelete = [...active.values()].map(e => {
      const ref = e.torrent;
      e.server.close();
      e.torrent.destroy();
      return ref;
    });
    active.clear();
    queueOrder = [];
    saveSession();
    client.destroy();
    Promise.all(toDelete.map(deleteTorrentFiles)).finally(() => app.quit());
  } else {
    saveSession();
    client.destroy();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---

ipcMain.handle('torrent:add', async (_, source, resumePos = null) => {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Invalid source');
  const resume = (typeof resumePos === 'number' && resumePos > 5) ? resumePos : null;

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
  const result = await addTorrentInternal(torrentId, magnet, settings.downloadDir, resume);
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

  return result;
});

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

  const extraArgs = [];
  if (entry.resumePos > 5) extraArgs.push(`--start=${Math.floor(entry.resumePos)}`);
  entry.resumePos = null;
  if (isMpv(player.path)) extraArgs.push(`--input-ipc-server=${mpvPipePath(id)}`);

  const url = `http://localhost:${entry.port}/`;
  const child = spawn(player.path, [...(player.args || []), ...subArgs, ...extraArgs, url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});

  if (isMpv(player.path)) connectMpvIPC(id);

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

  const extraArgs = [];
  if (entry.resumePos > 5) extraArgs.push(`--start=${Math.floor(entry.resumePos)}`);
  entry.resumePos = null;
  if (isMpv(player.path)) extraArgs.push(`--input-ipc-server=${mpvPipePath(id)}`);

  const child = spawn(player.path, [...(player.args || []), ...subArgs, ...extraArgs, filePath], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  if (isMpv(player.path)) connectMpvIPC(id);
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
  entry.server.close();
  entry.torrent.destroy();
  active.delete(id);
  queueOrder = queueOrder.filter(i => i !== id);
  applyQueueRules();
  saveSession();
  return true;
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

ipcMain.handle('cast:discover', () => discoverDevices(4000));

ipcMain.handle('cast:play', async (_, id, host) => {
  const entry = active.get(id);
  if (!entry) throw new Error('Torrent introuvable');
  const url = `http://${getLocalIP()}:${entry.port}/`;
  await castMedia(host, url);
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


async function fetchItunesPoster(title, year, kind = 'movie') {
  try {
    const entity = kind === 'tv' ? 'tvSeason' : 'movie';
    const q = encodeURIComponent(title);
    const res = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=${entity}&limit=5&country=us`,
      { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const item = data.results?.find(r => year && r.releaseDate?.startsWith(String(year)))
                 || data.results?.[0];
    if (!item?.artworkUrl100) return null;
    return await fetchImgBase64(item.artworkUrl100.replace('100x100bb', '600x600bb'));
  } catch { return null; }
}

async function fetchImgBase64(url, referer) {
  if (!url) return null;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'image/webp,image/jpeg,image/*,*/*',
  };
  if (referer) { headers['Referer'] = referer; headers['Origin'] = new URL(referer).origin; }
  const candidates = [url];
  if (url.includes('img.yts.mx')) candidates.push(url.replace('img.yts.mx', 'img.accel.li'));
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(5000), headers });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
    } catch {}
  }
  return null;
}

async function fetchMetaFromCinemeta(name) {
  const clean = name
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|webrip|web-dl|hdrip|dvdrip|x264|x265|hevc|avc|aac|ac3|dts|yify|rarbg|hdr|10bit|remux)\b.*/gi, '')
    .trim();
  const q = encodeURIComponent(clean);
  const opts = { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } };
  for (const type of ['movie', 'series']) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${q}.json`, opts);
      const data = await res.json();
      const m = data.metas?.[0];
      if (!m) continue;
      return {
        title: m.name,
        year: m.year || null,
        rating: m.imdbRating || null,
        poster: await fetchImgBase64(m.poster || null),
      };
    } catch {}
  }
  return null;
}

ipcMain.handle('discover:fetch', async (_, cat) => {
  const opts = { signal: AbortSignal.timeout(8000) };
  try {
    if (cat === 'movies') {
      const res = await fetch('https://v3-cinemeta.strem.io/catalog/movie/top.json', opts);
      const data = await res.json();
      const movies = (data.metas || []).slice(0, 24);
      return await Promise.all(movies.map(async m => ({
        title: m.name,
        year: m.year || null,
        rating: m.imdbRating || null,
        imdbId: m.id || null,
        type: 'movie',
        posterUrl: await fetchImgBase64(m.poster || null),
      })));
    }
    if (cat === 'series') {
      const today = new Date().toISOString().split('T')[0];
      const res = await fetch(`https://api.tvmaze.com/schedule/web?date=${today}`, opts);
      const episodes = await res.json();
      const seen = new Set();
      const shows = [];
      for (const ep of episodes) {
        const show = ep.show || ep._embedded?.show;
        if (!show || seen.has(show.id) || !show.image?.medium) continue;
        seen.add(show.id);
        shows.push({
          title: show.name,
          year: show.premiered ? show.premiered.slice(0, 4) : null,
          rating: show.rating?.average || null,
          imdbId: show.externals?.imdb || null, type: 'series',
          posterUrl: show.image.medium,
        });
      }
      const top = shows.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 24);
      return await Promise.all(top.map(async s => ({
        ...s, posterUrl: await fetchImgBase64(s.posterUrl),
      })));
    }
    if (cat === 'anime') {
      const res = await fetch('https://api.jikan.moe/v4/top/anime?type=tv&limit=24', opts);
      const data = await res.json();
      return await Promise.all((data?.data || []).map(async a => ({
        title: a.title_english || a.title,
        year: a.year || null,
        rating: a.score || null,
        posterUrl: await fetchImgBase64(
                     a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
                     'https://myanimelist.net'
                   ) || await fetchItunesPoster(a.title_english || a.title, a.year, 'tv'),
      })));
    }
  } catch { /* network blocked or timeout — return empty */ }
  return [];
});

const DEFAULT_TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://9.rarbg.to:2720/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
];

function buildMagnet(s) {
  const fromSources = (s.sources || [])
    .filter(src => src.startsWith('tracker:'))
    .map(src => src.slice(8));
  const trackers = [...new Set([...fromSources, ...DEFAULT_TRACKERS])];
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${s.infoHash}${tr}`;
}

// --- Torrentio ---

ipcMain.handle('torrentio:search', async (_, query, type) => {
  try {
    if (type === 'anime') {
      const res = await fetch(
        `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=12`,
        { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/vnd.api+json' } }
      );
      const data = await res.json();
      return await Promise.all((data.data || []).slice(0, 12).map(async a => ({
        id: `kitsu:${a.id}`,
        title: a.attributes.canonicalTitle,
        year: a.attributes.startDate ? a.attributes.startDate.slice(0, 4) : null,
        poster: await fetchImgBase64(
          a.attributes.posterImage?.small || a.attributes.posterImage?.original || null,
          'https://kitsu.io'
        ),
        type: 'anime',
        episodeCount: a.attributes.episodeCount || null,
      })));
    }
    if (type === 'all') {
      const opts = { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } };
      const q = encodeURIComponent(query);
      const [movRes, serRes] = await Promise.allSettled([
        fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${q}.json`, opts).then(r => r.json()),
        fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${q}.json`, opts).then(r => r.json()),
      ]);
      const movies  = (movRes.status  === 'fulfilled' ? movRes.value.metas  || [] : []).map(m => ({ ...m, _type: 'movie' }));
      const series  = (serRes.status  === 'fulfilled' ? serRes.value.metas  || [] : []).map(m => ({ ...m, _type: 'series' }));
      const seen = new Set();
      const merged = [...movies, ...series].filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; }).slice(0, 12);
      return await Promise.all(merged.map(async m => ({
        id: m.id, title: m.name, year: m.year || null,
        poster: await fetchImgBase64(m.poster || null),
        type: m._type, rating: m.imdbRating || null,
      })));
    }
    const cinType = type === 'movie' ? 'movie' : 'series';
    const res = await fetch(
      `https://v3-cinemeta.strem.io/catalog/${cinType}/top/search=${encodeURIComponent(query)}.json`,
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    return await Promise.all((data.metas || []).slice(0, 12).map(async m => ({
      id: m.id,
      title: m.name,
      year: m.year || null,
      poster: await fetchImgBase64(m.poster || null),
      type: cinType,
      rating: m.imdbRating || null,
    })));
  } catch { return []; }
});

ipcMain.handle('torrentio:streams', async (_, id, type, season, episode) => {
  const settings = getSettings(app.getPath('userData'));
  const baseUrl = (settings.torrentioUrl || 'https://torrentio.strem.fun').replace(/\/$/, '');
  let streamId = id;
  if (type === 'series' && season != null) streamId = `${id}:${season}:${episode}`;
  else if (type === 'anime' && episode != null) streamId = `${id}:${episode}`;
  try {
    const res = await fetch(`${baseUrl}/stream/${type}/${streamId}.json`, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await res.json();
    return (data.streams || []).map(s => {
      const nameParts = (s.name || '').split('\n');
      const quality = nameParts[1]?.trim() || '';
      const titleLines = (s.title || '').split('\n');
      const fileName = titleLines[0] || '';
      const metaLine = titleLines.slice(1).join(' ');
      const seedersMatch = metaLine.match(/👤\s*(\d+)/);
      const sizeMatch = metaLine.match(/💾\s*([\d.,]+ ?(?:GB|MB|TB))/);
      return {
        quality,
        fileName,
        seeders: seedersMatch ? parseInt(seedersMatch[1]) : null,
        size: sizeMatch ? sizeMatch[1] : null,
        magnet: s.infoHash ? buildMagnet(s) : null,
        debrid: !s.infoHash,
      };
    });
  } catch { return []; }
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
