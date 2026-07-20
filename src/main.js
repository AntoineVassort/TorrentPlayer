// Main-process bootstrap: window, tray, app lifecycle, the 1 s state-push loop,
// update check, and wiring the feature modules' IPC together. Torrent, playback,
// watch-progress and the bulk IPC surface live in their own modules.

import { app, BrowserWindow, Menu, Tray, nativeImage, clipboard } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { client, active, rt } from './runtime.js';
import { getSettings, saveSettings } from './settings.js';
import { registerMetadataIpc, fetchMetaFromCinemeta } from './metadata.js';
import { registerUpdaterIpc } from './updater.js';
import {
  refreshTrackers, applyThrottle, loadSession, saveSession,
  applyQueueRules, addTorrentInternal, deleteTorrentFiles,
} from './torrentManager.js';
import { registerPlaybackIpc } from './playback.js';
import { checkFollows } from './watchProgress.js';
import { registerAppIpc } from './ipcHandlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerMetadataIpc();
registerUpdaterIpc(() => rt.mainWindow);
registerPlaybackIpc();
registerAppIpc();

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

// --- Window ---

let boundsTimer = null;

function saveBounds() {
  const win = rt.mainWindow;
  if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    const s = getSettings(app.getPath('userData'));
    saveSettings(app.getPath('userData'), { ...s, windowBounds: win.getBounds() });
  }, 500);
}

function createWindow() {
  const settings = getSettings(app.getPath('userData'));
  const bounds = settings.windowBounds || {};

  const win = new BrowserWindow({
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
  rt.mainWindow = win;

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  win.on('resize', saveBounds);
  win.on('move',   saveBounds);
  win.on('maximize',   () => win.webContents.send('window:maximize'));
  win.on('unmaximize', () => win.webContents.send('window:unmaximize'));

  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });

  win.on('focus', () => {
    const text = clipboard.readText().trim();
    if (text.startsWith('magnet:')) win.webContents.send('clipboard:magnet', text);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon);
  rt.tray = tray;
  tray.setToolTip('TorrentPlayer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher', click: () => rt.mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    rt.mainWindow?.isVisible() ? rt.mainWindow.focus() : rt.mainWindow?.show();
  });
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Refresh the public tracker list in the background (non-blocking — torrents
  // added before it resolves just use the curated fallback).
  refreshTrackers();

  // Progress updates
  setInterval(() => {
    if (!rt.mainWindow || rt.mainWindow.isDestroyed()) return;

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
        queuePos: rt.queueOrder.indexOf(torrent.infoHash),
        casting: casting || null,
        episodeContext: episodeContext || null,
      };
    });

    rt.mainWindow.webContents.send('torrent:state', state);

    // Update tray tooltip with live download speed
    if (rt.tray) {
      const downloading = state.filter(s => !s.done);
      if (downloading.length) {
        const totalDl = downloading.reduce((s, t) => s + t.downloadSpeed, 0);
        const fmtSpd = totalDl < 1024 * 1024
          ? `${(totalDl / 1024).toFixed(0)} KB/s`
          : `${(totalDl / 1024 / 1024).toFixed(1)} MB/s`;
        rt.tray.setToolTip(`TorrentPlayer — ↓ ${fmtSpd} · ${downloading.length} active`);
      } else {
        rt.tray.setToolTip('TorrentPlayer');
      }
    }
  }, 1000);

  // Check for updates
  rt.mainWindow.webContents.once('did-finish-load', () => checkForUpdates(rt.mainWindow));

  // Followed-series new-episode poll: once shortly after launch, then every 6 h.
  setTimeout(() => { checkFollows().catch(() => {}); }, 20000);
  setInterval(() => { checkFollows().catch(() => {}); }, 6 * 60 * 60 * 1000);

  // Restore session
  rt.mainWindow.webContents.once('did-finish-load', async () => {
    const settings = getSettings(app.getPath('userData'));
    applyThrottle(settings);
    const { torrents, queueOrder: savedQueue } = loadSession();
    rt.queueOrder = savedQueue;
    for (const { magnet, resumePos, episodeContext } of torrents) {
      try {
        const result = await addTorrentInternal(magnet, magnet, settings.downloadDir, resumePos, episodeContext || null);
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
    rt.queueOrder = [];
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
