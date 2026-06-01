// OpenSubtitles REST API v1 — https://opensubtitles.stoplight.io/
// Requires a free Api-Key (configured by the user in settings).

const API = 'https://api.opensubtitles.com/api/v1';

const CLEAN_RE = /\b(2160p|1080p|1080i|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|x264|x265|h264|h265|hevc|avc|xvid|aac|ac3|dts|yify|rarbg|proper|repack|hdr|sdr|10bit|remux|extended|theatrical)\b.*/i;

export function cleanReleaseName(name) {
  return String(name || '')
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v|ts|flv)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(CLEAN_RE, '')
    .replace(/\s+/g, ' ')
    .trim() || String(name || '');
}

export function parseSeasonEpisode(name) {
  const m = String(name || '').match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,2})/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  return { season: null, episode: null };
}

// Returns { text, language } or null. Never throws.
export async function fetchSubtitle(apiKey, { query, language, season, episode, userAgent }) {
  if (!apiKey || !language || !query) return null;
  const headers = {
    'Api-Key': apiKey,
    'User-Agent': userAgent || 'TorrentPlayer',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  let fileId;
  try {
    const params = new URLSearchParams({ query, languages: language });
    if (season != null) params.set('season_number', String(season));
    if (episode != null) params.set('episode_number', String(episode));
    const res = await fetch(`${API}/subtitles?${params}`, { headers, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = await res.json();
    const list = (data.data || []).filter(s => s.attributes?.files?.length);
    if (!list.length) return null;
    list.sort((a, b) => (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0));
    fileId = list[0].attributes.files[0].file_id;
  } catch { return null; }

  if (!fileId) return null;

  try {
    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const { link } = await res.json();
    if (!link) return null;
    const sub = await fetch(link, { signal: AbortSignal.timeout(8000) });
    if (!sub.ok) return null;
    const text = await sub.text();
    if (!text || text.length < 10) return null;
    return { text, language };
  } catch { return null; }
}
