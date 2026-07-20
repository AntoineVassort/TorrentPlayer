// Metadata & catalog fetching — Cinemeta, Torrentio, TVmaze, Jikan, Kitsu, iTunes.
// All network-only (no torrent client state). Posters are proxied to base64 so the
// renderer never loads remote images directly (CSP-safe).

import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSettings } from './settings.js';

// Posters change rarely — cache the resolved data-URI on disk so Discover/Library
// don't re-fetch every image each session.
let posterCacheDir = null;
function posterCachePath(url) {
  if (!posterCacheDir) {
    posterCacheDir = path.join(app.getPath('userData'), 'poster-cache');
    try { fs.mkdirSync(posterCacheDir, { recursive: true }); } catch {}
  }
  return path.join(posterCacheDir, crypto.createHash('sha1').update(url).digest('hex'));
}

async function fetchItunesPoster(title, year, kind = 'movie') {
  try {
    const entity = kind === 'tv' ? 'tvSeason' : 'movie';
    const q = encodeURIComponent(title);
    const res = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=${entity}&limit=5&country=us`,
      { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const item = data.results?.find(r => year && r.releaseDate?.startsWith(String(year)))
                 || data.results?.[0];
    if (!item?.artworkUrl100) return null;
    return await fetchImgBase64(item.artworkUrl100.replace('100x100bb', '600x600bb'));
  } catch { return null; }
}

// Reject hosts that point at the local machine or a private LAN range, so a
// malicious/compromised metadata provider can't turn a poster URL into a
// request-forgery probe of the victim's internal network.
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

export async function fetchImgBase64(url, referer) {
  if (!url) return null;
  const cacheFile = posterCachePath(url);
  try {
    const cached = fs.readFileSync(cacheFile, 'utf8');
    if (cached) return cached;
  } catch {}
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'image/webp,image/jpeg,image/*,*/*',
  };
  if (referer) { headers['Referer'] = referer; headers['Origin'] = new URL(referer).origin; }
  const candidates = [url];
  if (url.includes('img.yts.mx')) candidates.push(url.replace('img.yts.mx', 'img.accel.li'));
  for (const candidate of candidates) {
    try {
      const u = new URL(candidate);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      if (isBlockedHost(u.hostname)) continue;
      const res = await fetch(candidate, { signal: AbortSignal.timeout(5000), headers });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      const dataUri = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
      try { fs.writeFileSync(cacheFile, dataUri); } catch {}
      return dataUri;
    } catch {}
  }
  return null;
}

// Normalize a title for comparison: lowercase, strip accents & punctuation,
// drop a leading article, collapse whitespace.
function normTitle(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/^(the|a|an|le|la|les|un|une)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Token-based similarity in [0,1]: 1 = identical, prefix/superset scores high,
// otherwise Jaccard over word tokens. Used to reject wrong Cinemeta matches.
function titleScore(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  // Bonus when one title fully contains the other (e.g. "Dune" vs "Dune Part Two").
  const contained = na.startsWith(nb) || nb.startsWith(na) ? 0.15 : 0;
  return Math.min(1, jaccard + contained);
}

// Parse a raw torrent/file name into a query title + hints (year, series marker).
function parseRelease(name) {
  const noExt = name.replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '');
  const spaced = noExt.replace(/[\._]/g, ' ');
  const seriesMarker = /\b(s\d{1,2}\s*e\d{1,3}|s\d{1,2}\b|season\s*\d+|\d{1,2}x\d{2})\b/i.test(spaced);
  // Year (1900–2099) used to disambiguate remakes/same-title works.
  const yearMatch = spaced.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  // Title = everything before the first quality/source/year/season tag.
  const title = spaced
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|webrip|web-dl|web|hdrip|dvdrip|brrip|bdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|ddp?5?1?|yify|yts|rarbg|hdr|hdr10|10bit|remux|proper|repack|extended|imax|s\d{1,2}e\d{1,3}|s\d{1,2}|season|\d{1,2}x\d{2}|19\d{2}|20\d{2})\b.*/i, '')
    .replace(/[\s\-]+$/, '')
    .trim();
  return { title: title || spaced.trim(), year, seriesMarker };
}

// Resolve a raw release name to the correct Cinemeta entry. Instead of blindly
// taking the first movie hit, we search BOTH movie & series, score every
// candidate on title similarity + year match + type hint, and keep the best
// only if it clears a confidence threshold — otherwise no poster beats a wrong one.
export async function fetchMetaFromCinemeta(name) {
  const { title, year, seriesMarker } = parseRelease(name);
  const q = encodeURIComponent(title);
  const opts = { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } };

  const search = async (type) => {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${q}.json`, opts);
      const data = await res.json();
      return (data.metas || []).slice(0, 8).map(m => ({ ...m, _type: type }));
    } catch { return []; }
  };
  const [movies, series] = await Promise.all([search('movie'), search('series')]);
  const candidates = [...movies, ...series];
  if (!candidates.length) return null;

  let best = null, bestScore = 0;
  for (const m of candidates) {
    let score = titleScore(title, m.name);
    const my = Number(m.year) || Number((m.releaseInfo || '').slice(0, 4)) || null;
    if (year && my) score += my === year ? 0.25 : (Math.abs(my - year) <= 1 ? 0.05 : -0.2);
    // Series marker (SxxExx) present → prefer series results and vice-versa.
    if (seriesMarker) score += m._type === 'series' ? 0.15 : -0.15;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  // Require a real title overlap, not just a year/type nudge.
  if (!best || bestScore < 0.5 || titleScore(title, best.name) < 0.34) return null;

  return {
    title: best.name,
    year: best.year || best.releaseInfo || null,
    rating: best.imdbRating || null,
    poster: await fetchImgBase64(best.poster || null),
  };
}

const DEFAULT_TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://9.rarbg.to:2720/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
];

function buildMagnet(s) {
  const fromSources = (s.sources || [])
    .filter(src => src.startsWith('tracker:'))
    .map(src => src.slice(8));
  const trackers = [...new Set([...fromSources, ...DEFAULT_TRACKERS])];
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${s.infoHash}${tr}`;
}

// Register the catalog/stream IPC handlers. Called once from main.js.
export function registerMetadataIpc() {
  // Paginated catalog. `page` is 1-based. Movies & series come from Cinemeta
  // "top" (skip-paginated, imdb ids → detail/episodes work); anime from Jikan.
  ipcMain.handle('discover:fetch', async (_, cat, page = 1) => {
    const opts = { signal: AbortSignal.timeout(8000) };
    const PAGE = 50;
    const p = Math.max(1, Number(page) || 1);
    try {
      if (cat === 'movies' || cat === 'series') {
        const kind = cat === 'movies' ? 'movie' : 'series';
        const skip = (p - 1) * PAGE;
        const url = skip
          ? `https://v3-cinemeta.strem.io/catalog/${kind}/top/skip=${skip}.json`
          : `https://v3-cinemeta.strem.io/catalog/${kind}/top.json`;
        const res = await fetch(url, opts);
        const data = await res.json();
        const metas = (data.metas || []).slice(0, PAGE);
        return await Promise.all(metas.map(async m => ({
          title: m.name,
          year: m.year || m.releaseInfo || null,
          rating: m.imdbRating || null,
          imdbId: m.id || null,
          type: kind,
          genres: m.genres || m.genre || [],
          posterUrl: await fetchImgBase64(m.poster || null),
        })));
      }
      if (cat === 'anime') {
        const res = await fetch(`https://api.jikan.moe/v4/top/anime?type=tv&page=${p}`, opts);
        const data = await res.json();
        return await Promise.all((data?.data || []).map(async a => ({
          title: a.title_english || a.title,
          year: a.year || null,
          rating: a.score || null,
          type: 'anime',
          genres: (a.genres || []).map(g => g.name),
          posterUrl: await fetchImgBase64(
                       a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
                       'https://myanimelist.net'
                     ) || await fetchItunesPoster(a.title_english || a.title, a.year, 'tv'),
        })));
      }
    } catch { /* network blocked or timeout — return empty */ }
    return [];
  });

  // Rich metadata for the detail hero (synopsis, runtime, status, genres, rating).
  // Cinemeta only — imdb ids. Returns null for non-imdb (anime/kitsu) or on failure.
  ipcMain.handle('meta:detail', async (_, imdbId, type) => {
    if (!imdbId || !/^tt/.test(imdbId)) return null;
    const kind = type === 'movie' ? 'movie' : 'series';
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`,
        { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const m = data?.meta;
      if (!m) return null;
      return {
        description: m.description || '',
        runtime: m.runtime || '',
        status: m.status || '',
        genres: m.genres || m.genre || [],
        imdbRating: m.imdbRating || null,
        year: m.releaseInfo || m.year || '',
        cast: (m.cast || []).slice(0, 4),
      };
    } catch { return null; }
  });

  ipcMain.handle('torrentio:search', async (_, query, type) => {
    try {
      if (type === 'anime') {
        const res = await fetch(
          `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=12`,
          { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/vnd.api+json' } }
        );
        const data = await res.json();
        return await Promise.all((data.data || []).slice(0, 12).map(async a => ({
          id: `kitsu:${a.id}`,
          title: a.attributes.canonicalTitle,
          year: a.attributes.startDate ? a.attributes.startDate.slice(0, 4) : null,
          poster: await fetchImgBase64(
            a.attributes.posterImage?.small || a.attributes.posterImage?.original || null,
            'https://kitsu.io'
          ),
          type: 'anime',
          episodeCount: a.attributes.episodeCount || null,
        })));
      }
      if (type === 'all') {
        const opts = { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } };
        const q = encodeURIComponent(query);
        const [movRes, serRes] = await Promise.allSettled([
          fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${q}.json`, opts).then(r => r.json()),
          fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${q}.json`, opts).then(r => r.json()),
        ]);
        const movies  = (movRes.status  === 'fulfilled' ? movRes.value.metas  || [] : []).map(m => ({ ...m, _type: 'movie' }));
        const series  = (serRes.status  === 'fulfilled' ? serRes.value.metas  || [] : []).map(m => ({ ...m, _type: 'series' }));
        const seen = new Set();
        const merged = [...movies, ...series].filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; }).slice(0, 12);
        return await Promise.all(merged.map(async m => ({
          id: m.id, title: m.name, year: m.year || null,
          poster: await fetchImgBase64(m.poster || null),
          type: m._type, rating: m.imdbRating || null,
        })));
      }
      const cinType = type === 'movie' ? 'movie' : 'series';
      const res = await fetch(
        `https://v3-cinemeta.strem.io/catalog/${cinType}/top/search=${encodeURIComponent(query)}.json`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await res.json();
      return await Promise.all((data.metas || []).slice(0, 12).map(async m => ({
        id: m.id,
        title: m.name,
        year: m.year || null,
        poster: await fetchImgBase64(m.poster || null),
        type: cinType,
        rating: m.imdbRating || null,
      })));
    } catch { return []; }
  });

  ipcMain.handle('torrentio:streams', (_, id, type, season, episode) => {
    const settings = getSettings(app.getPath('userData'));
    return fetchTorrentioStreams(id, type, season, episode, settings.torrentioUrl);
  });
}

// Reusable Torrentio stream fetch — used by the IPC handler AND by the auto-next-episode
// logic in main.js. Returns parsed stream objects (never throws).
export async function fetchTorrentioStreams(id, type, season, episode, torrentioUrl) {
  const baseUrl = (torrentioUrl || 'https://torrentio.strem.fun').replace(/\/$/, '');
  let streamId = id;
  if (type === 'series' && season != null) streamId = `${id}:${season}:${episode}`;
  else if (type === 'anime' && episode != null) streamId = `${id}:${episode}`;
  try {
    const res = await fetch(`${baseUrl}/stream/${type}/${streamId}.json`, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await res.json();
    return (data.streams || []).map(s => {
      const nameParts = (s.name || '').split('\n');
      const quality = nameParts[1]?.trim() || '';
      const titleLines = (s.title || '').split('\n');
      const fileName = titleLines[0] || '';
      const metaLine = titleLines.slice(1).join(' ');
      const seedersMatch = metaLine.match(/👤\s*(\d+)/);
      const sizeMatch = metaLine.match(/💾\s*([\d.,]+ ?(?:GB|MB|TB))/);
      return {
        quality,
        fileName,
        seeders: seedersMatch ? parseInt(seedersMatch[1]) : null,
        size: sizeMatch ? sizeMatch[1] : null,
        magnet: s.infoHash ? buildMagnet(s) : null,
        debrid: !s.infoHash,
      };
    });
  } catch { return []; }
}

// Pick the best playable stream: most seeders, non-debrid. Optionally bias to 1080p.
export function pickBestTorrentioStream(streams) {
  const playable = (streams || []).filter(s => s.magnet && !s.debrid);
  if (!playable.length) return null;
  const hd = playable.filter(s => /1080/.test(s.quality));
  const pool = hd.length ? hd : playable;
  return pool.reduce((best, s) => (s.seeders ?? 0) > (best.seeders ?? 0) ? s : best);
}

// --- TVmaze (series episode list & air dates) — used by "follow a series" and the
// full episode view. TVmaze is keyed by its own id; resolve from imdb first. ---

function stripHtml(s) {
  return s ? String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

export async function fetchTvmazeShowByImdb(imdbId) {
  if (!imdbId) return null;
  try {
    const res = await fetch(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const show = await res.json();
    return show?.id ? show : null;
  } catch { return null; }
}

// Returns the full episode list for a series (by imdb id), normalized to
// { season, number, name, airstamp }. Empty array on any failure.
export async function fetchSeriesEpisodes(imdbId, tvmazeId = null) {
  try {
    let id = tvmazeId;
    if (!id) {
      const show = await fetchTvmazeShowByImdb(imdbId);
      id = show?.id || null;
    }
    if (!id) return { tvmazeId: null, episodes: [] };
    const res = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { tvmazeId: id, episodes: [] };
    const data = await res.json();
    const episodes = (Array.isArray(data) ? data : [])
      .filter(e => e.season != null && e.number != null)
      .map(e => ({
        season: e.season, number: e.number, name: e.name || '',
        airstamp: e.airstamp || null,
        summary: stripHtml(e.summary),
        runtime: e.runtime || null,
      }));
    return { tvmazeId: id, episodes };
  } catch { return { tvmazeId: tvmazeId || null, episodes: [] }; }
}
