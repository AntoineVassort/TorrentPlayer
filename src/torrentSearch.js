const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

const CAT_MAP = { films: '201', series: '205', tout: '0' };
const QUALITY_RE = { '720p': /720p/i, '1080p': /1080p/i, '4k': /2160p|4k|uhd/i };

function buildMagnet(hash, name) {
  const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

async function searchApibay(query, category) {
  const cat = CAT_MAP[category] || '0';
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`apibay ${res.status}`);
  const data = await res.json();
  if (!data?.length || data[0]?.info_hash === '0000000000000000000000000000000000000000') return [];
  return data.map(t => ({
    name: t.name,
    infoHash: t.info_hash.toLowerCase(),
    seeders: parseInt(t.seeders) || 0,
    leechers: parseInt(t.leechers) || 0,
    size: parseInt(t.size) || 0,
    magnet: buildMagnet(t.info_hash, t.name),
    source: 'PB',
  }));
}

async function searchYTS(query) {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`YTS ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok' || !data.data?.movies?.length) return [];

  const results = [];
  for (const movie of data.data.movies) {
    for (const torrent of (movie.torrents || [])) {
      const name = `${movie.title} (${movie.year}) [${torrent.quality}]`;
      results.push({
        name,
        infoHash: torrent.hash.toLowerCase(),
        seeders: torrent.seeds || 0,
        leechers: torrent.peers || 0,
        size: torrent.size_bytes || 0,
        magnet: buildMagnet(torrent.hash, name),
        source: 'YTS',
      });
    }
  }
  return results;
}

export async function searchTorrents(query, { category = 'tout', quality = 'tout' } = {}) {
  const tasks = [searchApibay(query, category).catch(() => [])];
  if (category !== 'series') tasks.push(searchYTS(query).catch(() => []));

  const [apibayResults, ytsResults = []] = await Promise.all(tasks);

  const seen = new Set();
  let results = [...apibayResults, ...ytsResults].filter(r => {
    if (seen.has(r.infoHash)) return false;
    seen.add(r.infoHash);
    return true;
  });

  if (quality !== 'tout' && QUALITY_RE[quality]) {
    results = results.filter(r => QUALITY_RE[quality].test(r.name));
  }

  return results.sort((a, b) => b.seeders - a.seeders);
}
