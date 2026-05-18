const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

function buildMagnet(hash, name) {
  const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

export async function searchTorrents(query) {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.length || data[0]?.info_hash === '0000000000000000000000000000000000000000') return [];
  return data.map(t => ({
    name: t.name,
    infoHash: t.info_hash,
    seeders: parseInt(t.seeders) || 0,
    leechers: parseInt(t.leechers) || 0,
    size: parseInt(t.size) || 0,
    magnet: buildMagnet(t.info_hash, t.name),
  }));
}
