import os from 'os';
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

export function discoverDevices(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const players = chromecasts();
    const devices = [];

    players.on('update', (player) => {
      if (!devices.find(d => d.host === player.host)) {
        devices.push({ name: player.name || player.friendlyName || player.host, host: player.host });
      }
    });

    players.update();
    setTimeout(() => resolve(devices), timeoutMs);
  });
}

export function castMedia(host, url) {
  return new Promise((resolve, reject) => {
    const players = chromecasts();
    const timer = setTimeout(() => {
      reject(new Error(`Appareil ${host} introuvable`));
    }, 6000);

    players.on('update', (player) => {
      if (player.host !== host) return;
      clearTimeout(timer);
      player.play(url, { type: 'video/mp4' }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    players.update();
  });
}
