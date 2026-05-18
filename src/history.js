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

export function addEntry(userData, entry) {
  const history = loadHistory(userData);
  const filtered = history.filter(e => e.id !== entry.id);
  const updated = [entry, ...filtered].slice(0, MAX_ENTRIES);
  fs.writeFileSync(historyPath(userData), JSON.stringify(updated, null, 2));
}

export function updateEntry(userData, id, fields) {
  const history = loadHistory(userData);
  const entry = history.find(e => e.id === id);
  if (!entry) return;
  Object.assign(entry, fields);
  fs.writeFileSync(historyPath(userData), JSON.stringify(history, null, 2));
}

export function removeEntry(userData, id) {
  const history = loadHistory(userData);
  fs.writeFileSync(
    historyPath(userData),
    JSON.stringify(history.filter(e => e.id !== id), null, 2)
  );
}
