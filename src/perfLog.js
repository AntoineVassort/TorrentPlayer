// Lightweight freeze diagnostics. Appends to userData/perf.log whenever the main
// process event loop stalls (WebTorrent hashing / disk writes share it with the
// UI) or the renderer reports a long task. Nothing is written when all is smooth.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { monitorEventLoopDelay } from 'perf_hooks';
import { client } from './runtime.js';

const STALL_MS = 200;
let logFile = null;

function write(line) {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch {}
}

export function startPerfLog(mainWindow) {
  logFile = path.join(app.getPath('userData'), 'perf.log');

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  setInterval(() => {
    const max = h.max / 1e6, p99 = h.percentile(99) / 1e6;
    h.reset();
    if (max < STALL_MS) return;
    const mem = process.memoryUsage();
    write(`[main] event-loop stall max=${max.toFixed(0)}ms p99=${p99.toFixed(0)}ms ` +
      `torrents=${client.torrents.length} dl=${(client.downloadSpeed / 1048576).toFixed(1)}MB/s ` +
      `peers=${client.torrents.reduce((n, t) => n + t.numPeers, 0)} rss=${(mem.rss / 1048576).toFixed(0)}MB`);
  }, 5000).unref();

  // Renderer long tasks arrive as console.warn('[perf] ...').
  mainWindow.webContents.on('console-message', (event, level, message) => {
    const msg = typeof event?.message === 'string' ? event.message : message;
    if (typeof msg === 'string' && msg.startsWith('[perf]')) write(`[renderer] ${msg.slice(7)}`);
  });
}
