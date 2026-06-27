'use strict';
// Pure helpers: HTML-escape, formatters, icons, small predicates. Shared globals (classic script).

let toastTimer = null;
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ICONS = {
  grip: `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="opacity:0.5"><circle cx="3" cy="2.5" r="1.5"/><circle cx="7" cy="2.5" r="1.5"/><circle cx="3" cy="7" r="1.5"/><circle cx="7" cy="7" r="1.5"/><circle cx="3" cy="11.5" r="1.5"/><circle cx="7" cy="11.5" r="1.5"/></svg>`,
  files: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  cast: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>`,
  remove: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  eye: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

// --- Init ---

function isInputActive() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

// --- Discover ---

function extractQuality(name) {
  if (/2160p|4k|uhd/i.test(name)) return '4K';
  if (/1080p|1080i/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  if (/480p/i.test(name)) return '480p';
  return null;
}

const CLEAN_RE = /\b(2160p|1080p|1080i|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|x264|x265|h264|h265|hevc|avc|xvid|aac|ac3|dts|yify|rarbg|proper|repack|hdr|sdr|10bit|remux|extended|theatrical)\b.*/gi;
function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(CLEAN_RE, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function seedsClass(n) {
  if (n >= 100) return 'seeds-high';
  if (n >= 20)  return 'seeds-mid';
  return 'seeds-low';
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB/s`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
}

function fmtSize(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtTime(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtETA(ms) {
  if (!ms || ms <= 0 || !isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const locale = getLang() === 'fr' ? 'fr-FR' : 'en-US';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

function speedGraph(history) {
  if (!history || history.length < 2) return '<svg width="60" height="20"></svg>';
  const max = Math.max(...history, 1);
  const w = 60, h = 20;
  const pts = history.map((v, i) =>
    `${(i / (history.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`
  ).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function isSeries(name) {
  return /\b[Ss]\d{1,2}[Ee]\d{1,2}\b/.test(name || '');
}

function watchFraction(item) {
  if (item.resumePos > 0 && item.resumeDuration > 0) {
    return Math.min(item.resumePos / item.resumeDuration, 1);
  }
  return 0;
}

function isResumable(item) {
  const f = watchFraction(item);
  return f > 0.01 && f < 0.95;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// --- Window controls ---
