import path from 'path';
import fs from 'fs';

const FILENAME = 'follows.json';

function followsPath(userData) {
  return path.join(userData, FILENAME);
}

export function loadFollows(userData) {
  try { return JSON.parse(fs.readFileSync(followsPath(userData), 'utf8')); }
  catch { return []; }
}

function save(userData, follows) {
  fs.writeFileSync(followsPath(userData), JSON.stringify(follows, null, 2));
}

export function isFollowing(userData, imdbId) {
  return loadFollows(userData).some(f => f.imdbId === imdbId);
}

export function addFollow(userData, entry) {
  const follows = loadFollows(userData);
  if (follows.some(f => f.imdbId === entry.imdbId)) return;
  save(userData, [{ addedAt: new Date().toISOString(), ...entry }, ...follows]);
}

export function removeFollow(userData, imdbId) {
  save(userData, loadFollows(userData).filter(f => f.imdbId !== imdbId));
}

export function updateFollow(userData, imdbId, fields) {
  const follows = loadFollows(userData);
  const f = follows.find(x => x.imdbId === imdbId);
  if (!f) return;
  Object.assign(f, fields);
  save(userData, follows);
}
