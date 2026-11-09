// Torrent lifecycle: add/remove, the per-torrent HTTP streaming server, file &
// episode selection, download focus, tracker list, throttle, session
// persistence, and the download queue. Owns everything that touches the
// `active` map's torrent/server state.

import { app, Notification } from 'electron';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { client, active, rt, tuning } from './runtime.js';
import { getSettings } from './settings.js';
import { persistWatchProgress } from './watchProgress.js';
import { pipeTranscoded } from './transcode.js';

const VIDEO_EXTENSIONS    = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv'];
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

export function isVideo(name)    { return VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()); }
export function isSubtitle(name) { return SUBTITLE_EXTENSIONS.includes(path.extname(name).toLowerCase()); }

// Content-Type served by the streaming server. VLC and mpv sniff the container
// and ignore this, but Chromecast and DLNA renderers trust the header — serving
// an .mkv as video/mp4 made them refuse the stream outright.
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
};

export function mimeFor(name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'video/mp4';
}

// Returned by parseRange for a syntactically valid but unsatisfiable range, so
// the caller answers 416 instead of streaming garbage.
const INVALID_RANGE = Symbol('invalid-range');

// Parse a Range header into { start, end } (inclusive), null when absent or not
// a byte range, INVALID_RANGE when unsatisfiable.
//
// Naive `parseInt(split('-'))` handles only `bytes=N-M`. Suffix ranges
// (`bytes=-500`, "the last 500 bytes") yielded start=NaN and a
// `Content-Range: bytes NaN-…`, and an oversized end was never clamped to the
// file. mpv and VLC only ever send `bytes=N-`, but Chromecast and DLNA
// renderers probe with the other forms.
export function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(.+)$/i.exec(String(header).trim());
  if (!m) return null;
  // A multi-range request would need multipart/byteranges; no player sends one,
  // so serve the first range rather than failing.
  const spec = m[1].split(',')[0].trim();
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return INVALID_RANGE;
  const [, rawStart, rawEnd] = parts;
  if (!rawStart && !rawEnd) return INVALID_RANGE;
  if (total <= 0) return INVALID_RANGE;

  let start, end;
  if (!rawStart) {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!suffix) return INVALID_RANGE;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return INVALID_RANGE;
  end = Math.min(end, total - 1);
  if (start > end || start >= total) return INVALID_RANGE;
  return { start, end };
}

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

// Steer a multi-file torrent (season pack) toward one file. WebTorrent starts
// with the WHOLE torrent selected as a single piece range, and per-file
// deselect() only removes an exact matching range — so it never touched that
// default selection: every file kept downloading at equal priority and the
// episode being streamed got no preference. Drop the whole-torrent range first,
// then select explicitly. `all` keeps the other files downloading (whole-season
// mode) at a lower priority than the focused episode.
export function focusFile(torrent, file, all = false) {
  try {
    torrent.deselect(0, torrent.pieces.length - 1);
    for (const f of torrent.files) {
      if (f === file) continue;
      try { f.deselect(); } catch {}
      if (all) { try { f.select(0); } catch {} }
    }
    torrent._tpWin = null;
    if (all) file.select(1);
    else slideWindow(torrent, file);
  } catch {}
}

// WebTorrent's per-peer request loop (validateWire/_updateWire) scans EVERY piece of
// every selected range on each update. Selecting a 20 GB file whole pinned the main
// process at 100% of a core (profiled: ~80% in validateWire + bitfield.get). Select
// only a window ahead of the first missing piece and slide it as the download
// advances; the file still downloads fully, just in bounded chunks.
export function slideWindow(torrent, file) {
  const pl = torrent.pieceLength;
  if (!pl || !torrent.bitfield || file.length === 0 || torrent.destroyed) return;
  const first = Math.floor(file.offset / pl);
  const last = Math.floor((file.offset + file.length - 1) / pl);
  const w = torrent._tpWin || (torrent._tpWin = { cursor: first, sel: null });
  // Self-heal: if WebTorrent no longer holds any selection (it drops completed or
  // deselected ranges), our bookkeeping is stale and nothing would be requested.
  if (w.sel && torrent._selections) {
    let held = false;
    for (let i = 0; i < torrent._selections.length; i++) {
      const s = torrent._selections.get(i);
      if (!s.isStreamSelection && s.to >= w.cursor) { held = true; break; }
    }
    if (!held) w.sel = null;
  }
  let p = Math.max(w.cursor, first);
  while (p <= last && torrent.bitfield.get(p)) p++;
  w.cursor = p;
  if (p > last) {
    if (w.sel) { try { torrent.deselect(w.sel[0], w.sel[1]); } catch {} w.sel = null; }
    return;
  }
  const span = Math.ceil(tuning.windowBytes / pl);
  // Keep the current window until the cursor has eaten a quarter of it (limits churn).
  if (w.sel && p - w.sel[0] < span / 4) return;
  const to = Math.min(last, p + span);
  const old = w.sel;
  // select() MERGES overlapping ranges, so the old and new windows become one
  // [old.from, to] range. Only trim the already-downloaded prefix [old.from, p-1];
  // deselecting the whole old window would carve out still-missing pieces.
  torrent.select(p, to, 1);
  w.sel = [p, to];
  if (old && p - 1 >= old[0]) { try { torrent.deselect(old[0], p - 1); } catch {} }
}

// Head buffer required before playback is offered: 5% of the file, capped.
// Uncapped, a 15 GB 4K remux made the user wait for 750 MB when mpv/VLC only
// need a few tens of MB to start.
const READY_MAX_BYTES = 40 * 1024 * 1024;

// Is enough of the START of the file downloaded to hand it to the player?
//
// The old rule compared `file.downloaded / file.length` to 5%, which is wrong
// twice over: it over-waits on big files, and `downloaded` counts bytes
// ANYWHERE in the file — 5% scattered across the middle leaves the player with
// nothing to read. Check the actual leading pieces via the bitfield instead.
export function isReadyToPlay(torrent, file) {
  if (torrent.done) return true;
  if (!file || !file.length) return false;
  const need = Math.min(file.length * 0.05, READY_MAX_BYTES);
  const { pieceLength, bitfield } = torrent;
  // Metadata not in yet (no bitfield) — fall back to the old ratio.
  if (!pieceLength || !bitfield) return file.downloaded / file.length >= 0.05;
  const firstPiece = Math.floor(file.offset / pieceLength);
  const lastPiece  = Math.floor((file.offset + need - 1) / pieceLength);
  for (let i = firstPiece; i <= lastPiece; i++) {
    if (!bitfield.get(i)) return false;
  }
  return true;
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
  focusFile(entry.torrent, match, entry.downloadAll);
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

// Apply every setting WebTorrent lets us change on a live client. (DHT / LSD /
// NAT / web seeds / listen port are read once at client creation — see runtime.js.)
export function applyNetworkSettings(settings) {
  const dl = settings.maxDownload ? settings.maxDownload * 1024 : -1;
  const ul = settings.maxUpload  ? settings.maxUpload  * 1024 : -1;
  client.throttleDownload(dl);
  client.throttleUpload(ul);
  const mc = parseInt(settings.maxConns, 10);
  client.maxConns = mc > 0 ? Math.min(mc, 500) : 55;
  const mb = parseInt(settings.aheadWindowMB, 10);
  tuning.windowBytes = (mb > 0 ? Math.min(Math.max(mb, 64), 8192) : 512) * 1024 * 1024;
  tuning.strategy = settings.strategy === 'rarest' ? 'rarest' : 'sequential';
  tuning.seedRatio = Math.max(0, Number(settings.seedRatioLimit) || 0);
  for (const t of client.torrents) t.strategy = tuning.strategy;
}

// Stop seeding for real. torrent.pause() only flips a flag: it blocks NEW
// connections but leaves already-connected wires open (and the rechoke loop keeps
// unchoking them), so upload never stops and the UI still shows active peers.
// Pause (rejects any reconnect, in or out), zero the rechoke slots, then destroy
// the open wires so peers actually disconnect (numPeers → 0). slice() because
// wire.destroy() removes it from t.wires mid-iteration.
export function pauseSeeding(t) {
  t.pause();
  t._rechokeNumSlots = 0;
  t.wires.slice().forEach(w => w.destroy());
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
  const torrents = [...active.values()].map(({ torrent, magnet, resumePos, episodeContext, downloadAll }) => ({
    magnet: magnet || torrent.magnetURI,
    name: torrent.name,
    resumePos: resumePos || null,
    // Persist the episode so a restored season pack re-selects the right file
    // instead of falling back to the largest one.
    episodeContext: episodeContext || null,
    downloadAll: !!downloadAll,
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

// Players (VLC especially) open many Range requests and drop them on seek/probe,
// often with an open-ended range up to EOF. pipe() does NOT destroy the source
// when the destination closes, so each abandoned stream kept reading and
// prioritising pieces of a multi-GB file forever. Tear the source down with the socket.
function pipeFileStream(stream, res) {
  stream.on('error', () => {});
  const cleanup = () => { if (!stream.destroyed) stream.destroy(); };
  res.on('close', cleanup);
  res.on('error', cleanup);
  stream.pipe(res);
}

export function addTorrentInternal(torrentId, magnet, downloadDir, resumePos = null, episodeContext = null, downloadAll = false) {
  return new Promise((resolve, reject) => {
    const opts = { announce: activeTrackers, strategy: tuning.strategy };
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
      // No episode requested: on a multi-file pack the largest file is an
      // arbitrary episode, so start from the first one in name order instead.
      let selectedIndex = videoFiles.length > 1
        ? [...videoFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0].index
        : videoFiles[0].index;
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
      focusFile(torrent, file, downloadAll);

      // Random token gating LAN access. Loopback requests (the local player) are
      // always allowed; once the server is rebound to 0.0.0.0 for casting, any
      // non-loopback request must carry this token in its path, so exposing the
      // port no longer means unauthenticated LAN disclosure of the media.
      const streamToken = crypto.randomBytes(16).toString('hex');

      const server = http.createServer((req, res) => {
        const remote = req.socket.remoteAddress || '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        const [seg, sub] = (req.url || '/').split('?')[0].replace(/^\/+/, '').split('/');
        if (!isLoopback && seg !== streamToken) { res.writeHead(403); res.end(); return; }

        // Chromecast fetches media + text tracks cross-origin, so it needs CORS. Only
        // sent to remote (non-loopback) requests so local web pages can't read the stream.
        const cors = isLoopback ? {} : {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

        if (sub === 'sub.vtt') {
          const vtt = active.get(torrent.infoHash)?.subVtt;
          if (!vtt) { res.writeHead(404, cors); res.end(); return; }
          res.writeHead(200, { ...cors, 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': Buffer.byteLength(vtt) });
          res.end(vtt);
          return;
        }

        // Same media with the audio converted to AAC, for receivers that can't decode it.
        if (sub === 't.mp4') {
          if (req.method === 'HEAD') { res.writeHead(200, { ...cors, 'Content-Type': 'video/mp4' }); res.end(); return; }
          pipeTranscoded(`http://127.0.0.1:${server.address().port}/`, res, cors);
          return;
        }
        const f = fileState.file;
        const total = f.length;
        const contentType = mimeFor(f.name);
        const range = parseRange(req.headers['range'], total);

        if (range === INVALID_RANGE) {
          res.writeHead(416, { ...cors, 'Content-Range': `bytes */${total}`, 'Content-Type': contentType });
          res.end();
          return;
        }
        if (range) {
          const { start, end } = range;
          res.writeHead(206, {
            ...cors,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': contentType,
          });
          pipeFileStream(f.createReadStream({ start, end }), res);
        } else {
          res.writeHead(200, { ...cors, 'Content-Length': total, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
          pipeFileStream(f.createReadStream(), res);
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
            downloadAll,
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
