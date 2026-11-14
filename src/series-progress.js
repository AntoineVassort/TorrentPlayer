import path from 'path';
import fs from 'fs';

// Library marks, keyed by title id (IMDb id, or the Torrentio id for anime).
// Inside a title, an episode is "season:episode" and a movie is "movie".
//   series-progress.json  watched            (historical file name, format unchanged)
//   downloaded.json       downloaded at least once (stays true if the file is deleted)
//   library-titles.json   title / poster / kind + cached TVmaze episode list, for titles the
//                         Library knows only through marks or the periodic series refresh
const MARK_FILES = { watched: 'series-progress.json', downloaded: 'downloaded.json' };
const TITLES_FILE = 'library-titles.json';

function load(userData, file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(userData, file), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function save(userData, file, data) {
  fs.writeFileSync(path.join(userData, file), JSON.stringify(data));
}

export function markKey(season, episode) {
  return episode == null ? 'movie' : `${season}:${episode}`;
}

// Set or clear one mark field for several keys of a title. Returns true if anything changed.
export function setMarks(userData, field, titleId, keys, on) {
  const file = MARK_FILES[field];
  if (!file || !titleId || !keys.length) return false;
  const data = load(userData, file);
  const marks = data[titleId] || {};
  let changed = false;
  for (const k of keys) {
    if (!!marks[k] === !!on) continue;
    if (on) marks[k] = true; else delete marks[k];
    changed = true;
  }
  if (!changed) return false;
  if (Object.keys(marks).length) data[titleId] = marks; else delete data[titleId];
  save(userData, file, data);
  return true;
}

export function getAllMarks(userData) {
  return { watched: load(userData, MARK_FILES.watched), downloaded: load(userData, MARK_FILES.downloaded) };
}

export function loadTitles(userData) {
  return load(userData, TITLES_FILE);
}

// Merge fields into a title record. Posters arrive as base64 data URLs (Discover proxies
// images): kept when they are images of a sane size, so a title the user only checked
// manually still has its artwork in the Library.
export function updateTitle(userData, titleId, fields) {
  if (!titleId) return;
  const titles = loadTitles(userData);
  const cur = titles[titleId] || {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (k === 'poster' && (typeof v !== 'string' || v.length > 400000
      || !(v.startsWith('data:image/') || v.startsWith('https://')))) continue;
    next[k] = v;
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  titles[titleId] = next;
  save(userData, TITLES_FILE, titles);
}
