// External-player launch and playback tracking. Builds resume/tracking CLI args
// per player, spawns the detached player against the local stream (or the file
// on disk), and follows playback position over mpv's IPC pipe or VLC's HTTP
// interface so resume + Continue Watching work. Also fetches subtitles on play.

import { app, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { active } from './runtime.js';
import { getSettings } from './settings.js';
import { detect } from './playerDetector.js';
import { fetchSubtitle, cleanReleaseName, parseSeasonEpisode } from './subtitles.js';
import { saveSession } from './torrentManager.js';
import { persistWatchProgress, maybeOfferNextEpisode } from './watchProgress.js';

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

export function registerPlaybackIpc() {
  ipcMain.handle('torrent:play', async (_, id) => {
    const entry = active.get(id);
    if (!entry) throw new Error('Torrent introuvable');

    const settings = getSettings(app.getPath('userData'));
    const player = settings.player || detect()[0];
    if (!player) throw new Error('Aucun player configuré. Ouvrez les paramètres.');
    if (!fs.existsSync(player.path)) throw new Error(`Player introuvable : ${player.path}`);

    const subArgs = [];
    if (entry.fileState.subtitle) {
      // subtitle.path already contains the torrent-name segment for multi-file
      // torrents, and torrent.path already equals the download dir — join them the
      // same way torrent:playLocal does (joining downloadDir + torrent.name here
      // doubled the segment, so the file was never found and subs were dropped).
      const subPath = path.join(entry.torrent.path, entry.fileState.subtitle.path);
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
}
