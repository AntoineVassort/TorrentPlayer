import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(__dirname, '../src/assets');

// ── App icon (256×256)
// Concept: hexagonal mesh (torrent network) + red play triangle
// Colors match the app: deep dark bg, indigo hex outline, streaming red play
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="70%">
      <stop offset="0%" stop-color="#181828"/>
      <stop offset="100%" stop-color="#080810"/>
    </radialGradient>
    <radialGradient id="rglow" cx="46%" cy="50%" r="52%">
      <stop offset="0%" stop-color="#e50914" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#e50914" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="iglow" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="256" height="256" rx="52" fill="url(#bg)"/>
  <rect width="256" height="256" rx="52" fill="url(#iglow)"/>
  <rect width="256" height="256" rx="52" fill="url(#rglow)"/>

  <!-- Outer hexagon (large, faint) -->
  <polygon points="214,80 128,32 42,80 42,176 128,224 214,176"
    fill="none" stroke="#6366f1" stroke-width="3" stroke-opacity="0.22"/>

  <!-- Inner hexagon (tight around play) -->
  <polygon points="186,96 128,64 70,96 70,160 128,192 186,160"
    fill="rgba(10,10,28,0.5)" stroke="#6366f1" stroke-width="4" stroke-opacity="0.55"/>

  <!-- Play triangle — centered inside inner hex -->
  <polygon points="92,82 92,174 182,128" fill="#e50914"/>
</svg>`;

// ── Tray icon (32×32) — readable at 16px in Windows system tray
const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#0c0c1a"/>
  <!-- Hexagon outline -->
  <polygon points="26,10 16,4 6,10 6,22 16,28 26,22"
    fill="none" stroke="#6366f1" stroke-width="1.5" stroke-opacity="0.6"/>
  <!-- Play triangle -->
  <polygon points="12,9 12,23 23,16" fill="#e50914"/>
</svg>`;

// Generate tray.png (32×32)
await sharp(Buffer.from(traySvg)).png().toFile(path.join(assets, 'tray.png'));
console.log('✓ tray.png (32×32)');

// Generate app icon at multiple sizes for ICO
const sizes = [256, 48, 32, 16];
const pngBuffers = await Promise.all(
  sizes.map(s => sharp(Buffer.from(appSvg)).resize(s, s).png().toBuffer())
);

// Build multi-size ICO (PNG-in-ICO, Windows Vista+)
function makePngIco(buffers, sizeList) {
  const count = buffers.length;
  const headerSize = 6 + count * 16;

  // Calculate offsets
  const offsets = [];
  let offset = headerSize;
  for (const buf of buffers) {
    offsets.push(offset);
    offset += buf.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = buffers.map((buf, i) => {
    const e = Buffer.alloc(16);
    const s = sizeList[i];
    e.writeUInt8(s === 256 ? 0 : s, 0);
    e.writeUInt8(s === 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offsets[i], 12);
    return e;
  });

  return Buffer.concat([header, ...entries, ...buffers]);
}

fs.writeFileSync(path.join(assets, 'app.ico'), makePngIco(pngBuffers, sizes));
console.log('✓ app.ico (256 + 48 + 32 + 16)');
console.log('Done.');
