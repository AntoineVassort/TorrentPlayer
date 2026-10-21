import os from 'os';
import dns from 'dns';
import chromecasts from 'chromecasts';

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

// Pick the local IPv4 the cast device can actually reach: the one on the same
// subnet as `targetHost`. Falling back to the first non-internal address picks
// virtual adapters (WSL/Hyper-V, link-local 169.254.x) that a TV can't route to.
export function getLocalIP(targetHost) {
  const candidates = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) candidates.push(addr);
    }
  }
  if (targetHost && /^\d+\.\d+\.\d+\.\d+$/.test(targetHost)) {
    const target = ipToInt(targetHost);
    const same = candidates.find((a) => {
      const mask = ipToInt(a.netmask);
      return (ipToInt(a.address) & mask) === (target & mask);
    });
    if (same) return same.address;
  }
  return candidates[0]?.address || '127.0.0.1';
}

// Chromecast discovery reports the mDNS SRV target (e.g. xxxx.local), not an IP.
// Resolve it so getLocalIP can match subnets; fall back to the raw value.
export function resolveHostIPv4(host) {
  if (/^d+.d+.d+.d+$/.test(host)) return Promise.resolve(host);
  return new Promise((resolve) => {
    dns.lookup(host, { family: 4 }, (err, addr) => resolve(err ? host : addr));
  });
}

// One shared discovery instance for the whole app. Every chromecasts() call opens
// its own mDNS (UDP 5353) + SSDP sockets and destroy() doesn't close SSDP, so
// creating one per discover/cast leaked sockets. On Windows, sockets sharing a
// multicast port only deliver replies to one of them, so after the first scan
// later scans (and casts) found no device at all.
let shared = null;
const getPlayers = () => (shared ??= chromecasts());

// Known players resolve immediately; otherwise query and wait for `host` to answer.
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

export function discoverDevices(timeoutMs = 4000) {
  const players = getPlayers();
  return new Promise((resolve) => {
    players.update();
    setTimeout(() => resolve(players.players.map((p) => (
      { name: p.name || p.friendlyName || p.host, host: p.host }
    ))), timeoutMs);
  });
}

export async function castMedia(host, url, type = 'video/mp4', subtitleUrl = null) {
  const player = await findPlayer(host, 6000);
  if (!player) throw new Error(`Appareil ${host} introuvable`);
  await new Promise((resolve, reject) => {
        const opts = { type, ...(subtitleUrl && { subtitles: [subtitleUrl] }) };
    player.play(url, opts, (err) => (err ? reject(err) : resolve()));
  });
}

// The receiver has no on-screen menu: the sender (this app) switches the text track.
export function setSubtitles(host, on) {
  return new Promise((resolve) => {
    const player = getPlayers().players.find((p) => p.host === host);
    if (!player) return resolve();
    const timer = setTimeout(resolve, 4000);
    player.subtitles(on ? 1 : false, () => { clearTimeout(timer); resolve(); });
  });
}

// Stopping needs the player that started playback: it holds the Chromecast
// media session. A fresh player has none, and castv2 then throws (uncaught) on
// `mediaSessionId` of null — the shared instance keeps the same player alive.
export function stopCast(host) {
  return new Promise((resolve) => {
    const player = getPlayers().players.find((p) => p.host === host);
    if (!player) return resolve();
    const timer = setTimeout(resolve, 4000);
    const done = () => { clearTimeout(timer); resolve(); };
    try { player.stop(done); } catch { done(); }
  });
}
