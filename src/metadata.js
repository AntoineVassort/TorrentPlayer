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

export async function fetchMetaFromCinemeta(name) {
  const clean = name
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|webrip|web-dl|hdrip|dvdrip|x264|x265|hevc|avc|aac|ac3|dts|yify|rarbg|hdr|10bit|remux)\b.*/gi, '')
    .trim();
  const q = encodeURIComponent(clean);
  const opts = { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } };
  for (const type of ['movie', 'series']) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${q}.json`, opts);
      const data = await res.json();
      const m = data.metas?.[0];
      if (!m) continue;
      return {
        title: m.name,
        year: m.year || null,
        rating: m.imdbRating || null,
        poster: await fetchImgBase64(m.poster || null),
      };
    } catch {}
  }
  return null;
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
  ipcMain.handle('discover:fetch', async (_, cat) => {
    const opts = { signal: AbortSignal.timeout(8000) };
    try {
      if (cat === 'movies') {
        const res = await fetch('https://v3-cinemeta.strem.io/catalog/movie/top.json', opts);
        const data = await res.json();
        const movies = (data.metas || []).slice(0, 24);
        return await Promise.all(movies.map(async m => ({
          title: m.name,
          year: m.year || null,
          rating: m.imdbRating || null,
          imdbId: m.id || null,
          type: 'movie',
          posterUrl: await fetchImgBase64(m.poster || null),
        })));
      }
      if (cat === 'series') {
        const today = new Date().toISOString().split('T')[0];
        const res = await fetch(`https://api.tvmaze.com/schedule/web?date=${today}`, opts);
        const episodes = await res.json();
        const seen = new Set();
        const shows = [];
        for (const ep of episodes) {
          const show = ep.show || ep._embedded?.show;
          if (!show || seen.has(show.id) || !show.image?.medium) continue;
          seen.add(show.id);
          shows.push({
            title: show.name,
            year: show.premiered ? show.premiered.slice(0, 4) : null,
            rating: show.rating?.average || null,
            imdbId: show.externals?.imdb || null, type: 'series',
            posterUrl: show.image.medium,
          });
        }
        const top = shows.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 24);
        return await Promise.all(top.map(async s => ({
          ...s, posterUrl: await fetchImgBase64(s.posterUrl),
        })));
      }
      if (cat === 'anime') {
        const res = await fetch('https://api.jikan.moe/v4/top/anime?type=tv&limit=24', opts);
        const data = await res.json();
        return await Promise.all((data?.data || []).map(async a => ({
          title: a.title_english || a.title,
          year: a.year || null,
          rating: a.score || null,
          posterUrl: await fetchImgBase64(
                       a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
                       'https://myanimelist.net'
                     ) || await fetchItunesPoster(a.title_english || a.title, a.year, 'tv'),
        })));
      }
    } catch { /* network blocked or timeout — return empty */ }
    return [];
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
