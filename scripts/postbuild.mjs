import { cpSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const srcModules  = 'node_modules';
const destModules = 'dist/TorrentPlayer-win32-x64/resources/app/node_modules';

for (const pkg of readdirSync(srcModules)) {
  const srcDist  = join(srcModules, pkg, 'dist');
  const destDist = join(destModules, pkg, 'dist');
  if (existsSync(srcDist) && existsSync(join(destModules, pkg)) && !existsSync(destDist)) {
    cpSync(srcDist, destDist, { recursive: true });
    console.log(`Restored dist/ for ${pkg}`);
  }
}
