// In-app self-updater. Reuses the portable ZIP assets published by the CI release
// workflow (.github/workflows/release.yml) — no installer, no code signing, works on
// Windows/macOS/Linux. Flow: download the OS/arch asset with progress → extract to a
// temp dir → spawn a detached helper script that waits for this process to exit, swaps
// the install dir in place (rename → copy → rollback on failure), and relaunches.

import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const REPO = 'AntoineVassort/TorrentPlayer';

// Maps the running platform/arch to the release asset name produced by release.yml.
function assetName() {
  if (process.platform === 'win32') return 'TorrentPlayer-Windows-x64.zip';
  if (process.platform === 'linux') return 'TorrentPlayer-Linux-x64.zip';
  if (process.platform === 'darwin') return `TorrentPlayer-macOS-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  return null;
}

// Directory we replace, derived from the running executable. On macOS we swap the .app
// bundle; on Windows/Linux the portable folder containing the executable.
function installDir() {
  if (process.platform === 'darwin') {
    const i = process.execPath.indexOf('.app');
    return i !== -1 ? process.execPath.slice(0, i + 4) : path.dirname(process.execPath);
  }
  return path.dirname(process.execPath);
}

// Recursively find the new install root inside the extracted tree. The asset layouts
// are inconsistent (Windows is flat, mac/linux nest a parent folder), so we locate the
// executable / .app rather than assume a structure.
function findNewRoot(root) {
  const target = process.platform === 'win32' ? 'TorrentPlayer.exe' : 'TorrentPlayer';
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (process.platform === 'darwin' && e.isDirectory() && e.name.endsWith('.app')) return full;
      if (process.platform !== 'darwin' && e.isFile() && e.name === target) return dir;
      if (e.isDirectory()) stack.push(full);
    }
  }
  return null;
}

async function fetchLatestAsset() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'TorrentPlayer' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  const wanted = assetName();
  const asset = (data.assets || []).find(a => a.name === wanted);
  if (!asset) throw new Error(`No asset ${wanted} in release ${data.tag_name}`);
  return asset.browser_download_url;
}

// Stream the asset to disk, reporting download percentage via onProgress(pct).
async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'TorrentPlayer' } });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out.write(Buffer.from(value));
    if (total) onProgress(Math.round((received / total) * 100));
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function extract(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]);
  } else if (process.platform === 'darwin') {
    await run('ditto', ['-x', '-k', zipPath, destDir]);
  } else {
    await run('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  }
}

// Writes a detached helper that performs the swap once we've exited, then relaunches.
function writeHelper(tmpRoot, oldDir, newDir, exe, pid) {
  if (process.platform === 'win32') {
    const helper = path.join(tmpRoot, 'apply-update.cmd');
    fs.writeFileSync(helper, [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`,
      'if not errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait )',
      `move "${oldDir}" "${oldDir}.old" >nul 2>&1`,
      'if errorlevel 1 goto relaunch',
      `robocopy "${newDir}" "${oldDir}" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul`,
      'if %ERRORLEVEL% GEQ 8 goto rollback',
      `start "" "${exe}"`,
      `rmdir /s /q "${oldDir}.old" >nul 2>&1`,
      'goto done',
      ':rollback',
      `rmdir /s /q "${oldDir}" >nul 2>&1`,
      `move "${oldDir}.old" "${oldDir}" >nul 2>&1`,
      ':relaunch',
      `start "" "${exe}"`,
      ':done',
      `(goto) 2>nul & del "%~f0"`,
    ].join('\r\n'), 'utf8');
    return { cmd: 'cmd', args: ['/c', helper] };
  }
  const helper = path.join(tmpRoot, 'apply-update.sh');
  const relaunch = process.platform === 'darwin' ? `open "${oldDir}"` : `( "${exe}" >/dev/null 2>&1 & )`;
  fs.writeFileSync(helper, [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
    `if mv "${oldDir}" "${oldDir}.old"; then`,
    `  if cp -R "${newDir}" "${oldDir}"; then`,
    `    rm -rf "${oldDir}.old"`,
    '  else',
    `    rm -rf "${oldDir}"; mv "${oldDir}.old" "${oldDir}"`,
    '  fi',
    'fi',
    relaunch,
    'rm -- "$0"',
  ].join('\n'), 'utf8');
  fs.chmodSync(helper, 0o755);
  return { cmd: 'sh', args: [helper] };
}

export function registerUpdaterIpc(getMainWindow) {
  ipcMain.handle('update:download', async () => {
    // In dev (unpackaged) we never swap the source tree — tell the renderer to fall
    // back to opening the GitHub release page.
    if (!app.isPackaged) return { ok: false, dev: true };
    if (!assetName()) return { ok: false, error: 'unsupported-platform' };

    const win = getMainWindow();
    const progress = pct => win && !win.isDestroyed() && win.webContents.send('update:progress', { pct });

    try {
      const tmpRoot = path.join(app.getPath('temp'), 'TorrentPlayer-update');
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.mkdirSync(tmpRoot, { recursive: true });

      const url = await fetchLatestAsset();
      const zipPath = path.join(tmpRoot, assetName());
      await downloadTo(url, zipPath, progress);

      const extractDir = path.join(tmpRoot, 'extracted');
      await extract(zipPath, extractDir);

      const newRoot = findNewRoot(extractDir);
      if (!newRoot) throw new Error('Could not locate app in extracted archive');

      const oldDir = installDir();
      const helper = writeHelper(tmpRoot, oldDir, newRoot, process.execPath, process.pid);

      const child = spawn(helper.cmd, helper.args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();

      setTimeout(() => app.quit(), 300);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });
}
