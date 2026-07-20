// Shared mutable runtime state for the main process. Centralised here so the
// feature modules (torrentManager, playback, watchProgress, ipcHandlers) all
// read and mutate the same singletons without threading them through every
// call. `client` and `active` are stable references; window/tray/queue live on
// `rt` because an exported `let` can be read live by importers but not
// reassigned by them — mutating a property works from anywhere.

import WebTorrent from 'webtorrent';

export const client = new WebTorrent();

// Map<infoHash, { torrent, fileState, server, port, magnet, sockets, host,
//   streamToken, speedHistory, playback, resumePos, resumeDuration, queuePaused,
//   meta, casting, episodeContext, fetchedSubPath, _vlcTimer }>
export const active = new Map();

export const rt = {
  mainWindow: null,
  tray: null,
  queueOrder: [],
};
