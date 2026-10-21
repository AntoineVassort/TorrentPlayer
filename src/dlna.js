import dlnacasts from 'dlnacasts';

// Shared instance: each dlnacasts() opens its own SSDP socket, and sockets sharing
// the multicast port steal each other's replies on Windows (see chromecast.js).
let shared = null;
const getPlayers = () => (shared ??= dlnacasts());

function findPlayer(host, timeoutMs) {
  const players = getPlayers();
  return new Promise((resolve) => {
    const known = players.players.find((p) => p.host === host);
    if (known) return resolve(known);
    const done = (p) => { clearTimeout(timer); players.off('update', onUpdate); resolve(p); };
    const onUpdate = (p) => { if (p.host === host) done(p); };
    const timer = setTimeout(() => done(null), timeoutMs);
    players.on('update', onUpdate);
    players.update();
  });
}

export function discoverDlnaDevices(timeoutMs = 4000) {
  const players = getPlayers();
  return new Promise((resolve) => {
    players.update();
    setTimeout(() => resolve(players.players.map((p) => (
      { name: p.name || p.host, host: p.host, type: 'dlna' }
    ))), timeoutMs);
  });
}

export async function castDlna(host, url, type = 'video/mp4') {
  const player = await findPlayer(host, 6000);
  if (!player) throw new Error(`Appareil DLNA ${host} introuvable`);
  await new Promise((resolve, reject) => {
    player.play(url, { type, title: 'TorrentPlayer' }, (err) => (err ? reject(err) : resolve()));
  });
}

export async function stopDlna(host) {
  const player = await findPlayer(host, 4000);
  if (!player) return;
  await new Promise((resolve) => player.stop(() => resolve()));
}
