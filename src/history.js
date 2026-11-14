import path from 'path';
import fs from 'fs';

const FILENAME = 'history.json';
const MAX_ENTRIES = 200;

function historyPath(userData) {
  return path.join(userData, FILENAME);
}

export function loadHistory(userData) {
  try { return JSON.parse(fs.readFileSync(historyPath(userData), 'utf8')); }
  catch { return []; }
}

// Upsert + move to the front. Fields absent from `entry` are kept from the previous
// record (poster, identity…), and `completed` never goes back to false.
export function addEntry(userData, entry) {
  const history = loadHistory(userData);
  const prev = history.find(e => e.id === entry.id);
  const filtered = history.filter(e => e.id !== entry.id);
  const merged = prev ? { ...prev, ...entry, completed: !!(prev.completed || entry.completed) } : entry;
  const updated = [merged, ...filtered].slice(0, MAX_ENTRIES);
  fs.writeFileSync(historyPath(userData), JSON.stringify(updated, null, 2));
}

export function updateEntry(userData, id, fields) {
  const history = loadHistory(userData);
  const entry = history.find(e => e.id === id);
  if (!entry) return;
  Object.assign(entry, fields);
  fs.writeFileSync(historyPath(userData), JSON.stringify(history, null, 2));
}

// Merge fields into several entries in one write: `patches` maps entry id → fields.
export function patchEntries(userData, patches) {
  const history = loadHistory(userData);
  let changed = false;
  for (const e of history) {
    const p = patches.get(e.id);
    if (p) { Object.assign(e, p); changed = true; }
  }
  if (changed) fs.writeFileSync(historyPath(userData), JSON.stringify(history, null, 2));
  return changed;
}

export function removeEntry(userData, id) {
  const history = loadHistory(userData);
  fs.writeFileSync(
    historyPath(userData),
    JSON.stringify(history.filter(e => e.id !== id), null, 2)
  );
}
