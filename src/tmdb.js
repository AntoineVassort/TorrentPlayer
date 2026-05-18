import https from 'https';

const QUALITY_TAGS = /\b(2160p|1080p|1080i|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|dvdscr|hdtv|pdtv|x264|x265|h264|h\.264|h265|h\.265|hevc|avc|xvid|divx|aac|ac3|dts|mp3|truehd|atmos|yify|rarbg|fgt|ethd|ganool|ettv|eztv|tigole|qxr|ctrlhd|ntb|mzabi|framestor|sparks|cmrg|dimension|lol|fov|fleet|vxt|proper|repack|internal|extended|theatrical|unrated|hdr|dolby|vision|sdr|10bit|8bit|remux|hybrid)\b.*/gi;
const EPISODE_TAG  = /\b[Ss]\d{1,2}[Ee]\d{1,2}\b.*/;
const YEAR_SUFFIX  = /\s+(19|20)\d{2}\s*$/;

export function cleanName(raw) {
  return raw
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v|ts|flv)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(EPISODE_TAG, '')
    .replace(QUALITY_TAGS, '')
    .replace(YEAR_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBearer(key) {
  return key.startsWith('eyJ');
}

function fetchJSON(url, apiKey) {
  return new Promise((resolve, reject) => {
    const opts = { timeout: 5000 };
    if (isBearer(apiKey)) opts.headers = { Authorization: `Bearer ${apiKey}` };
    const req = https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export async function fetchMeta(name, apiKey) {
  if (!apiKey || !name) return null;
  const cleaned = cleanName(name);
  if (!cleaned) return null;

  try {
    const query = encodeURIComponent(cleaned);
    const keyParam = isBearer(apiKey) ? '' : `&api_key=${apiKey}`;
    const data = await fetchJSON(
      `https://api.themoviedb.org/3/search/multi?query=${query}${keyParam}&language=fr-FR`,
      apiKey
    );

    if (data.status_code) {
      console.error(`[TMDB] Erreur API ${data.status_code}: ${data.status_message}`);
      return null;
    }

    const result = (data.results || []).find(r => r.media_type === 'movie' || r.media_type === 'tv');
    if (!result) {
      console.log(`[TMDB] Aucun résultat pour: "${cleaned}"`);
      return null;
    }

    const title    = result.title || result.name || cleaned;
    const year     = (result.release_date || result.first_air_date || '').slice(0, 4);
    const rating   = result.vote_average ? Math.round(result.vote_average * 10) / 10 : null;
    const overview = result.overview || '';

    let poster = null;
    if (result.poster_path) {
      try {
        const buf = await fetchBuffer(`https://image.tmdb.org/t/p/w92${result.poster_path}`);
        poster = `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch (e) {
        console.error(`[TMDB] Échec téléchargement poster: ${e.message}`);
      }
    }

    console.log(`[TMDB] "${cleaned}" → ${title} (${year}) poster=${!!poster}`);
    return { poster, title, year, rating, overview };
  } catch (e) {
    console.error(`[TMDB] Erreur fetchMeta: ${e.message}`);
    return null;
  }
}
