import dlnacasts from 'dlnacasts';

export function discoverDlnaDevices(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const players = dlnacasts();
    const devices = [];
    players.on('update', (player) => {
      if (!devices.find(d => d.host === player.host)) {
        devices.push({ name: player.name || player.host, host: player.host, type: 'dlna' });
      }
    });
    players.update();
    setTimeout(() => resolve(devices), timeoutMs);
  });
}

export function castDlna(host, url) {
  return new Promise((resolve, reject) => {
    const players = dlnacasts();
    const timer = setTimeout(() => reject(new Error(`Appareil DLNA ${host} introuvable`)), 6000);
    players.on('update', (player) => {
      if (player.host !== host) return;
      clearTimeout(timer);
      player.play(url, { type: 'video/mp4', title: 'TorrentPlayer' }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    players.update();
  });
}
