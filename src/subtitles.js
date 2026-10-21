import fs from 'fs';
import { SubtitleParser } from 'matroska-subtitles';

// Matroska stores languages as ISO 639-2 (3 letters) and omits the tag when it is
// the default, "eng". Settings use 2-letter codes.
const LANG3 = {
  en: ['eng'], fr: ['fre', 'fra'], es: ['spa'], de: ['ger', 'deu'], it: ['ita'],
  pt: ['por'], nl: ['dut', 'nld'], ru: ['rus'], ja: ['jpn'], ko: ['kor'], zh: ['chi', 'zho'],
};

function pickTrack(tracks, wantLang) {
  const isSdh = (t) => /sdh|hearing|forced|commentary/i.test(t.name || '');
  const langOf = (t) => t.language || 'eng';
  const codes = LANG3[wantLang] || [];
  const byLang = tracks.filter((t) => codes.includes(langOf(t)));
  const pool = byLang.length ? byLang : tracks;
  return pool.find((t) => !isSdh(t)) || pool[0];
}

const vttTime = (ms) => {
  const p = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

// Extract one embedded text subtitle track (SubRip/ASS) from a fully downloaded
// MKV and return it as WebVTT, or null. The parser throws on the file's trailing
// padding, so on error we keep whatever cues were already read.
export function mkvSubtitleVtt(filePath, wantLang) {
  return new Promise((resolve) => {
    const parser = new SubtitleParser();
    const tracks = [];
    const cues = new Map();
    parser.once('tracks', (list) => {
      for (const t of list) {
        if (t.type !== 'utf8' && t.type !== 'ass') continue; // bitmap tracks (PGS/VobSub) can't be converted
        tracks.push(t);
        cues.set(t.number, []);
      }
    });
    parser.on('subtitle', (s, n) => cues.get(n)?.push(s));

    const input = fs.createReadStream(filePath);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      input.destroy();
      const track = tracks.length ? pickTrack(tracks, wantLang) : null;
      const list = track ? cues.get(track.number) : [];
      if (!list.length) return resolve(null);
      const clean = (s) => {
        let text = s.text.replace(/\r/g, '');
        if (track.type === 'ass') text = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n');
        return text.replace(/\n\s*\n/g, '\n').trim(); // a blank line would end the VTT cue
      };
      const body = list
        .sort((a, b) => a.time - b.time)
        .filter((s) => clean(s))
        .map((s) => `${vttTime(s.time)} --> ${vttTime(s.time + s.duration)}\n${clean(s)}`)
        .join('\n\n');
      resolve(`WEBVTT\n\n${body}\n`);
    };
    parser.on('error', finish);
    parser.on('finish', finish);
    input.on('error', finish);
    input.pipe(parser);
  });
}

// SubRip -> WebVTT for Chromecast text tracks (it only accepts WebVTT).
// Accepts a Buffer; falls back to windows-1252 when the bytes aren't valid UTF-8.
export function srtToVtt(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('windows-1252').decode(buf); }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('WEBVTT')) return text + '\n';
  return 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') + '\n';
}

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
