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
