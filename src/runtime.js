// Shared mutable runtime state for the main process. Centralised here so the
// feature modules (torrentManager, playback, watchProgress, ipcHandlers) all
// read and mutate the same singletons without threading them through every
// call. `client` and `active` are stable references; window/tray/queue live on
// `rt` because an exported `let` can be read live by importers but not
// reassigned by them — mutating a property works from anywhere.

import WebTorrent from 'webtorrent';
import { app } from 'electron';
import { getSettings } from './settings.js';

// Startup-only network options come from settings (WebTorrent reads them once, when
// the client is created). userData is resolvable before app 'ready'.
let startup = {};
try { startup = getSettings(app.getPath('userData')); } catch {}
const port = parseInt(startup.torrentPort, 10);

// uTP disabled: its UDP bind throws an uncaught EACCES in the main process on
// some Windows setups (reserved port ranges / another instance); TCP is enough.
export const client = new WebTorrent({
  utp: false,
  dht: startup.dht !== false,
  lsd: startup.lsd !== false,
  natUpnp: startup.natTraversal !== false,
  natPmp: startup.natTraversal !== false,
  webSeeds: startup.webSeeds !== false,
  // 1 = protocol encryption with plaintext fallback (WebTorrent default), 0 = plaintext only.
  // Each encrypted connection runs a synchronous Diffie-Hellman exchange on the main thread.
  secure: startup.encryption === false ? 0 : 1,
  torrentPort: port >= 1024 && port <= 65535 ? port : 0,
});

// Live-tunable values (set by applyNetworkSettings in torrentManager).
export const tuning = { windowBytes: 512 * 1024 * 1024, seedRatio: 0 };
client.on('error', err => console.error('[webtorrent]', err.message));

// Map<infoHash, { torrent, fileState, server, port, magnet, sockets, host,
//   streamToken, speedHistory, playback, resumePos, resumeDuration, queuePaused,
//   meta, casting, episodeContext, fetchedSubPath, _vlcTimer }>
export const active = new Map();

// Map<infoHash, { torrent, name, magnet, checked, total }> — torrents whose metadata is in but
// whose existing files are still being hash-verified. They join `active` at WebTorrent's 'ready'.
export const verifying = new Map();

export const rt = {
  mainWindow: null,
  tray: null,
  queueOrder: [],
};
