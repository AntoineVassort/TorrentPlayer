import os from 'os';
import chromecasts from 'chromecasts';

export function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
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
