import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';

const srcModules = 'node_modules';
const targetPlatform = process.argv[2] || platform();

const platformDirs = targetPlatform === 'win32'
  ? ['win32-x64']
  : targetPlatform === 'darwin'
    ? ['darwin-x64', 'darwin-arm64']
    : ['linux-x64'];

for (const platformDir of platformDirs) {
  const destModules = `dist/TorrentPlayer-${platformDir}/resources/app/node_modules`;
  if (!existsSync(destModules)) continue;
  for (const pkg of readdirSync(srcModules)) {
    const srcDist  = join(srcModules, pkg, 'dist');
    const destDist = join(destModules, pkg, 'dist');
    if (existsSync(srcDist) && existsSync(join(destModules, pkg)) && !existsSync(destDist)) {
      cpSync(srcDist, destDist, { recursive: true });
      console.log(`Restored dist/ for ${pkg} (${platformDir})`);
    }
  }
}

// Chromium ships ~55 locale packs (~47 MB). The app has its own EN/FR i18n, and Chromium falls back
// to en-US for anything else, so keep only en-US (required fallback) and fr. Windows/Linux only:
// macOS keeps its locales in .lproj folders inside the bundle.
const KEEP_LOCALES = new Set(['en-US.pak', 'fr.pak']);
for (const platformDir of platformDirs.filter(d => d.startsWith('win32') || d.startsWith('linux'))) {
  const dir = `dist/TorrentPlayer-${platformDir}/locales`;
  if (!existsSync(dir)) continue;
  let freed = 0, removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.pak') || KEEP_LOCALES.has(name)) continue;
    freed += statSync(join(dir, name)).size; rmSync(join(dir, name)); removed++;
  }
  console.log(`Pruned ${removed} Chromium locales (${(freed / 1048576).toFixed(1)} MB) from ${platformDir}`);
}
