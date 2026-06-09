import path from 'path';
import fs from 'fs';

const FILENAME = 'series-progress.json';

function progressPath(userData) {
  return path.join(userData, FILENAME);
}

export function loadProgress(userData) {
  try { return JSON.parse(fs.readFileSync(progressPath(userData), 'utf8')); }
  catch { return {}; }
}

function save(userData, data) {
  fs.writeFileSync(progressPath(userData), JSON.stringify(data, null, 2));
}

export function markEpisode(userData, imdbId, season, episode, watched) {
  const data = loadProgress(userData);
  if (!data[imdbId]) data[imdbId] = {};
  const key = `${season}:${episode}`;
  if (watched) data[imdbId][key] = true;
  else delete data[imdbId][key];
  save(userData, data);
}

export function getSeriesProgress(userData, imdbId) {
  const data = loadProgress(userData);
  return data[imdbId] || {};
}
