// Torrent lifecycle: add/remove, the per-torrent HTTP streaming server, file &
// episode selection, download focus, tracker list, throttle, session
// persistence, and the download queue. Owns everything that touches the
// `active` map's torrent/server state.

import { app, Notification } from 'electron';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { client, active, rt } from './runtime.js';
import { getSettings } from './settings.js';
import { persistWatchProgress } from './watchProgress.js';

const VIDEO_EXTENSIONS    = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv'];
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

export function isVideo(name)    { return VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()); }
export function isSubtitle(name) { return SUBTITLE_EXTENSIONS.includes(path.extname(name).toLowerCase()); }

export function findSubtitle(files, videoFile) {
  const base = path.basename(videoFile.name, path.extname(videoFile.name)).toLowerCase();
  return files.find(f => {
    if (!isSubtitle(f.name)) return false;
    const subBase = path.basename(f.name, path.extname(f.name)).toLowerCase();
    return subBase === base || subBase.startsWith(base);
  }) || null;
}

// Does a filename correspond to a given season/episode? Handles the common
// release conventions: S01E06 / s1.e6 / 1x06 / "Season 1 Episode 6".
export function matchesEpisode(name, season, episode) {
  const s = String(season), e = String(episode);
  const patterns = [
    new RegExp(`s0*${s}[\\s._-]*e0*${e}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)0*${s}\\s*x\\s*0*${e}(?!\\d)`, 'i'),
    new RegExp(`season[\\s._-]*0*${s}[\\s._-]*episode[\\s._-]*0*${e}(?!\\d)`, 'i'),
  ];
  return patterns.some(p => p.test(name));
}

// Restrict a torrent's download to a single file. On a multi-file torrent
// (season pack) WebTorrent selects every file by default, so the episode we
// actually stream competes for bandwidth with the rest of the pack. Deselecting
// the others concentrates peers on the chosen episode so it buffers fast.
export function focusFile(torrent, file) {
  try {
    for (const f of torrent.files) {
      if (f !== file) { try { f.deselect(); } catch {} }
    }
    file.select();
  } catch {}
}

// Re-point an already-active season pack at a different episode (clicking "Watch
// Now" on E07 while the pack downloaded for E06 is still active). Persists the
// outgoing episode's progress, swaps the streamed file, resets episode-specific
// state, and re-focuses the download. Returns false when the episode isn't in
// the pack so the caller can fall back to the normal duplicate handling.
export function switchEpisodeFile(entry, epCtx) {
  if (!epCtx || epCtx.season == null || epCtx.episode == null) return false;
  const match = entry.torrent.files.find(f => isVideo(f.name) && matchesEpisode(f.name, epCtx.season, epCtx.episode));
  if (!match || match === entry.fileState.file) return match === entry.fileState.file;
  persistWatchProgress(entry.torrent.infoHash);
  entry.fileState.file = match;
  entry.fileState.subtitle = findSubtitle(entry.torrent.files, match);
  entry.fetchedSubPath = null;
  entry.resumePos = null;
  entry.resumeDuration = null;
  entry.playback = null;
  entry.episodeContext = epCtx;
  focusFile(entry.torrent, match);
  return true;
}

// Extra public trackers merged into every torrent's announce list (on top of
// whatever the magnet already carries) to widen peer discovery — matters most
// for Torrentio streams that arrive as a bare infohash with few/no trackers.
//
// The live list is refreshed at startup from ngosang/trackerslist (the "best"
// list, kept current by the community). DEFAULT_TRACKERS is the offline
// fallback: a curated subset of reliable UDP/HTTPS trackers used if the fetch
// fails. activeTrackers holds whichever is in effect.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://opentracker.io:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://open.dstud.io:6969/announce',
  'udp://tracker.ktrackers.com:6666/announce',
  'udp://open.free-tracker.ga:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gcrenwp.top:443/announce',
];

let activeTrackers = DEFAULT_TRACKERS;

// Pull the community-maintained "best" tracker list at startup. Falls back to
// DEFAULT_TRACKERS (already in activeTrackers) on any failure — offline, 404, etc.
export async function refreshTrackers() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
      { headers: { 'User-Agent': 'TorrentPlayer' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return;
    const list = (await res.text())
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^(udp|https?|wss?):\/\//.test(l));
    if (list.length) activeTrackers = list;
  } catch {}
}

export function applyThrottle(settings) {
  const dl = settings.maxDownload ? settings.maxDownload * 1024 : -1;
  const ul = settings.maxUpload  ? settings.maxUpload  * 1024 : -1;
  client.throttleDownload(dl);
  client.throttleUpload(ul);
}

// --- Session persistence ---

function sessionPath() { return path.join(app.getPath('userData'), 'session.json'); }

export function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (Array.isArray(data)) return { torrents: data, queueOrder: [] };
    return { torrents: data.torrents || [], queueOrder: data.queueOrder || [] };
  } catch {
    return { torrents: [], queueOrder: [] };
  }
}

export function saveSession() {
  const torrents = [...active.values()].map(({ torrent, magnet, resumePos, episodeContext }) => ({
    magnet: magnet || torrent.magnetURI,
    name: torrent.name,
    resumePos: resumePos || null,
    // Persist the episode so a restored season pack re-selects the right file
    // instead of falling back to the largest one.
    episodeContext: episodeContext || null,
  }));
  fs.writeFileSync(sessionPath(), JSON.stringify({ torrents, queueOrder: rt.queueOrder }, null, 2));
}

// --- Queue ---

export function applyQueueRules() {
  const downloading = [...active.entries()]
    .filter(([, e]) => !e.torrent.done)
    .sort(([idA], [idB]) => {
      const a = rt.queueOrder.indexOf(idA);
      const b = rt.queueOrder.indexOf(idB);
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

// --- Add torrent (shared logic) ---

export function addTorrentInternal(torrentId, magnet, downloadDir, resumePos = null, episodeContext = null) {
  return new Promise((resolve, reject) => {
    const opts = { announce: activeTrackers };
    if (downloadDir) opts.path = downloadDir;

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

      // Default to the largest video file. But when an episode was requested
      // (season pack from "Watch Now"), pick the file that matches SxxExx so we
      // stream the RIGHT episode instead of the biggest one.
      let selectedIndex = videoFiles[0].index;
      let episodeMatched = false;
      if (episodeContext && episodeContext.season != null && episodeContext.episode != null) {
        const match = videoFiles.find(vf => matchesEpisode(vf.name, episodeContext.season, episodeContext.episode));
        if (match) { selectedIndex = match.index; episodeMatched = true; }
      }
      const file = torrent.files[selectedIndex];
      const subtitle = findSubtitle(torrent.files, file);
      const fileState = { file, subtitle };

      // Focus the download on the chosen file. Without this a season pack
      // downloads all episodes with no priority, so the picked episode's pieces
      // trickle in "randomly" and playback never reaches the 5% ready threshold.
      focusFile(torrent, file);

      // Random token gating LAN access. Loopback requests (the local player) are
      // always allowed; once the server is rebound to 0.0.0.0 for casting, any
      // non-loopback request must carry this token in its path, so exposing the
      // port no longer means unauthenticated LAN disclosure of the media.
      const streamToken = crypto.randomBytes(16).toString('hex');

      const server = http.createServer((req, res) => {
        const remote = req.socket.remoteAddress || '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLoopback) {
          const reqPath = (req.url || '/').split('?')[0].replace(/^\/+/, '');
          if (reqPath !== streamToken) { res.writeHead(403); res.end(); return; }
        }
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
            torrent, fileState, server, port, magnet, sockets, host: '127.0.0.1', streamToken,
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
            rt.tray?.setToolTip('TorrentPlayer');
            applyQueueRules();
          });

          resolve({ id: torrent.infoHash, name: file.name, videoFiles: videoFiles.length > 1 ? videoFiles : [], episodeMatched });
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

export async function deleteTorrentFiles(torrent) {
  // torrent.name comes straight from the .torrent metadata and is NOT sanitized
  // by parse-torrent (unlike file.path), so it can contain `..`/separators. Never
  // feed it raw to rm(): basename it and confirm the target stays inside the
  // download dir before a recursive force-delete.
  const root = path.resolve(torrent.path);
  const folder = path.resolve(root, path.basename(torrent.name));
  if (folder !== root && folder.startsWith(root + path.sep)) {
    try {
      await fs.promises.rm(folder, { recursive: true, force: true });
      return;
    } catch {}
  }
  for (const f of torrent.files) {
    try { await fs.promises.unlink(path.join(torrent.path, f.path)); } catch {}
  }
}
