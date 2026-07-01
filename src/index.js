import WebTorrent from 'webtorrent';
import { spawn } from 'child_process';
import { extname } from 'path';
import http from 'http';
import { detect } from './playerDetector.js';

const magnet = process.argv[2];

if (!magnet) {
  console.error('Usage: node src/index.js <magnet-link>');
  process.exit(1);
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv'];

function isVideo(filename) {
  return VIDEO_EXTENSIONS.includes(extname(filename).toLowerCase());
}

function pickFile(files) {
  const videos = files.filter(f => isVideo(f.name));
  if (videos.length === 0) return null;
  return videos.reduce((a, b) => (a.length > b.length ? a : b));
}

function launchPlayer(playerInfo, url) {
  console.log(`\nLaunching ${playerInfo.name}: ${playerInfo.path}`);
  console.log(`URL: ${url}\n`);
  const child = spawn(playerInfo.path, [...playerInfo.args, url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const players = detect();
if (players.length === 0) {
  console.error('No compatible video player found (mpv, VLC, MPC-HC...).');
  process.exit(1);
}

const player = players[0];
console.log(`Detected players: ${players.map(p => p.name).join(', ')}`);
console.log(`Using: ${player.name}\n`);

const client = new WebTorrent();
console.log('Adding torrent...');

client.add(magnet, (torrent) => {
  console.log(`Torrent: ${torrent.name}`);
  console.log(`Files:   ${torrent.files.map(f => f.name).join(', ')}\n`);

  const file = pickFile(torrent.files);
  if (!file) {
    console.error('No video file found in this torrent.');
    client.destroy();
    process.exit(1);
  }

  console.log(`Selected: ${file.name} (${(file.length / 1024 / 1024).toFixed(0)} MB)`);

  const server = http.createServer((req, res) => {
    const total = file.length;
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      const stream1 = file.createReadStream({ start, end });
      stream1.on('error', () => {});
      stream1.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });
      const stream2 = file.createReadStream();
      stream2.on('error', () => {});
      stream2.pipe(res);
    }
  });

  function startServer(port) {
    server.listen(port, '127.0.0.1', () => {
      launchPlayer(player, `http://localhost:${port}/`);
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') startServer(port + 1);
      else { console.error('Server error:', err.message); process.exit(1); }
    });
  }

  startServer(8888);

  const interval = setInterval(() => {
    const pct = (torrent.progress * 100).toFixed(1);
    const dl  = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
    const ul  = (torrent.uploadSpeed  / 1024 / 1024).toFixed(2);
    process.stdout.write(`\rProgress: ${pct}%  DL: ${dl} MB/s  UL: ${ul} MB/s  Peers: ${torrent.numPeers}    `);
  }, 1000);

  torrent.on('done', () => {
    clearInterval(interval);
    console.log('\n\nDownload complete.');
  });
});

client.on('error', (err) => {
  console.error('WebTorrent error:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nStopping...');
  client.destroy(() => process.exit(0));
});
