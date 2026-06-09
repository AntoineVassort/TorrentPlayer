import { cpSync, existsSync, readdirSync } from 'fs';
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
