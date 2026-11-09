import path from 'path';
import fs from 'fs';

const FILENAME = 'settings.json';

export function getDefaults(userDataPath) {
  return {
    player: null,
    downloadDir: path.join(userDataPath, 'downloads'),
    deleteAfterPlay: false,
    windowBounds: null,
    language: 'en',
    subtitleLanguage: 'off',
    openSubtitlesApiKey: null,
    autoPlayNext: true,
    autoGrabFollowed: false,
    preferredQuality: null,
    // Network & performance. Speed limits: KB/s, null = unlimited.
    maxDownload: null,
    maxUpload: null,
    maxConns: 55,            // per torrent (WebTorrent default)
    aheadWindowMB: 512,      // how far ahead of the playhead the download is scheduled
    seedRatioLimit: 0,       // stop seeding at this upload/size ratio; 0 = never
    // Applied at startup only (WebTorrent reads them when the client is created):
    dht: true,
    lsd: true,
    natTraversal: true,      // UPnP + NAT-PMP port mapping
    webSeeds: true,
    encryption: true,        // BitTorrent protocol encryption (MSE) with plaintext fallback
    torrentPort: 0,          // 0 = random
  };
}

export function getSettings(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(userDataPath, FILENAME), 'utf8'));
    return { ...getDefaults(userDataPath), ...data };
  } catch {
    return getDefaults(userDataPath);
  }
}

export function saveSettings(userDataPath, settings) {
  fs.writeFileSync(path.join(userDataPath, FILENAME), JSON.stringify(settings, null, 2));
}
