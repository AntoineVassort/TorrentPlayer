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
import { searchTorrents } from './torrentSearch.js';
import { fetchMeta } from './tmdb.js';
import { addEntry, loadHistory, removeEntry, updateEntry } from './history.js';
import { discoverDevices, castMedia, getLocalIP } from './chromecast.js';

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
      entry.playback = null;
      saveSession();
    });

    socket.on('error', () => {
      socket.destroy();
      if (retries < 15) { retries++; setTimeout(tryConnect, 400); }
    });
  };

  setTimeout(tryConnect, 500);
}

// --- Add torrent (shared logic) ---

function addTorrentInternal(torrentId, magnet, downloadDir, resumePos = null) {
  return new Promise((resolve, reject) => {
    const opts = downloadDir ? { path: downloadDir } : {};

    client.add(torrentId, opts, (torrent) => {
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
  });
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Progress updates
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const state = [...active.values()].map(({ torrent, fileState, port, speedHistory, playback, resumePos, meta, casting }) => {
      speedHistory.push(torrent.downloadSpeed);
      if (speedHistory.length > 30) speedHistory.shift();

      const file = fileState.file;
      return {
        id: torrent.infoHash,
        name: file ? file.name : torrent.name,
        size: file ? file.length : 0,
        downloaded: file ? file.downloaded : 0,
        progress: torrent.progress,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        numPeers: torrent.numPeers,
        done: torrent.done,
        paused: torrent.paused,
        ready: torrent.progress >= 0.05 || torrent.done,
        timeRemaining: torrent.timeRemaining,
        hasSubtitle: !!fileState.subtitle,
        speedHistory: [...speedHistory],
        playback: playback ? { pos: playback.pos, duration: playback.duration } : null,
        resumePos: resumePos || null,
        port,
        meta: meta || null,
        queuePos: queueOrder.indexOf(torrent.infoHash),
        casting: casting || null,
      };
    });

    mainWindow.webContents.send('torrent:state', state);
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
        if (settings.tmdbApiKey && result.name) {
          fetchMeta(result.name, settings.tmdbApiKey).then(meta => {
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

ipcMain.handle('torrent:add', async (_, source) => {
  let torrentId = source;
  const magnet = source.startsWith('magnet:') ? source : null;
  if (!magnet) {
    try { torrentId = fs.readFileSync(source); }
    catch (e) { throw new Error(`Impossible de lire le fichier : ${e.message}`); }
  }
  const settings = getSettings(app.getPath('userData'));
  const result = await addTorrentInternal(torrentId, magnet, settings.downloadDir);

  if (!queueOrder.includes(result.id)) {
    queueOrder.push(result.id);
    applyQueueRules();
    saveSession();
  }

  if (settings.tmdbApiKey && result.name) {
    fetchMeta(result.name, settings.tmdbApiKey).then(meta => {
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

ipcMain.handle('torrent:play', (_, id) => {
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

ipcMain.handle('torrent:playLocal', (_, id) => {
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
  const settings = getSettings(app.getPath('userData'));
  if (!settings.tmdbApiKey) return null;
  const meta = await fetchMeta(name, settings.tmdbApiKey);
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

ipcMain.on('update:openRelease', (_, url) => shell.openExternal(url));

ipcMain.handle('settings:get', () => getSettings(app.getPath('userData')));

ipcMain.handle('settings:testTmdb', async (_, apiKey) => {
  const meta = await fetchMeta('The Dark Knight', apiKey);
  return meta ? { ok: true, title: meta.title, year: meta.year, poster: !!meta.poster } : { ok: false };
});

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
    : [{ name: 'Tous les fichiers', extensions: ['*'] }];
  const r = await dialog.showOpenDialog(mainWindow, { filters, properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('search:query', async (_, query, options) => searchTorrents(query, options));

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
