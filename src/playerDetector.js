'use strict';

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PLAYER_PROFILES = {
  mpv:          { args: ['--cache=yes', '--demuxer-max-bytes=500M', '--force-window=immediate'] },
  vlc:          { args: ['--file-caching=10000', '--network-caching=10000'] },
  'mpc-hc64':   { args: [] },
  'mpc-hc':     { args: [] },
  'mpc-be64':   { args: [] },
  potplayer:    { args: [] },
  potplayer64:  { args: [] },
  iina:         { args: [] },
};

const WINDOWS_REGISTRY_NAMES = {
  'mpv.exe':              'mpv',
  'vlc.exe':              'vlc',
  'mpc-hc64.exe':         'mpc-hc64',
  'mpc-hc.exe':           'mpc-hc',
  'mpc-be64.exe':         'mpc-be64',
  'PotPlayerMini64.exe':  'potplayer64',
  'PotPlayerMini.exe':    'potplayer',
};

const WINDOWS_KNOWN_PATHS = [
  ['mpv',         'C:\\Program Files\\mpv\\mpv.exe'],
  ['mpv',         'C:\\Program Files (x86)\\mpv\\mpv.exe'],
  ['vlc',         'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'],
  ['vlc',         'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'],
  ['mpc-hc64',    'C:\\Program Files\\MPC-HC\\mpc-hc64.exe'],
  ['mpc-hc',      'C:\\Program Files (x86)\\MPC-HC\\mpc-hc.exe'],
  ['mpc-be64',    'C:\\Program Files\\MPC-BE x64\\mpc-be64.exe'],
  ['potplayer64', 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe'],
  ['potplayer',   'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe'],
];

const MACOS_PATHS = [
  ['mpv',  '/Applications/mpv.app/Contents/MacOS/mpv'],
  ['vlc',  '/Applications/VLC.app/Contents/MacOS/VLC'],
  ['iina', '/Applications/IINA.app/Contents/MacOS/IINA'],
];

const LINUX_BINARIES = ['mpv', 'vlc', 'mplayer', 'smplayer', 'celluloid'];

const PRIORITY = ['mpv', 'iina', 'vlc', 'mpc-hc64', 'mpc-be64', 'mpc-hc', 'potplayer64', 'potplayer', 'smplayer', 'celluloid', 'mplayer'];

function getProfile(name) {
  for (const [key, profile] of Object.entries(PLAYER_PROFILES)) {
    if (name.toLowerCase().includes(key)) return profile;
  }
  return { args: [] };
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function detectWindows() {
  const found = [];

  for (const [exeName, name] of Object.entries(WINDOWS_REGISTRY_NAMES)) {
    try {
      const out = execSync(
        `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}" /ve`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const match = out.match(/REG_SZ\s+(.+)/);
      if (match) {
        const p = match[1].trim().replace(/"/g, '');
        if (exists(p)) { found.push({ name, path: p, ...getProfile(name) }); continue; }
      }
    } catch { /* not in registry */ }
  }

  for (const [name, p] of WINDOWS_KNOWN_PATHS) {
    if (found.some(f => f.name === name)) continue;
    if (exists(p)) found.push({ name, path: p, ...getProfile(name) });
  }

  for (const [, name] of Object.entries(WINDOWS_REGISTRY_NAMES)) {
    if (found.some(f => f.name === name)) continue;
    try {
      const out = execSync(`where ${name}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const p = out.trim().split('\n')[0].trim();
      if (p && exists(p)) found.push({ name, path: p, ...getProfile(name) });
    } catch { /* not in PATH */ }
  }

  return found;
}

function detectMacOS() {
  const found = [];
  for (const [name, p] of MACOS_PATHS) {
    if (exists(p)) found.push({ name, path: p, ...getProfile(name) });
  }
  for (const bin of ['mpv', 'vlc']) {
    if (found.some(f => f.name === bin)) continue;
    try {
      const p = execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
      if (p) found.push({ name: bin, path: p, ...getProfile(bin) });
    } catch { /* not found */ }
  }
  return found;
}

function detectLinux() {
  const found = [];
  for (const bin of LINUX_BINARIES) {
    try {
      const p = execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
      if (p) found.push({ name: bin, path: p, ...getProfile(bin) });
    } catch { /* not found */ }
  }
  return found;
}

export function detect() {
  let players = [];
  if (process.platform === 'win32')       players = detectWindows();
  else if (process.platform === 'darwin') players = detectMacOS();
  else                                     players = detectLinux();

  return players.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}
