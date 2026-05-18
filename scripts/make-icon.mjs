import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// --- CRC32 / PNG helpers (unchanged) ---

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePNG(w, h, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function solidPNG(w, h, r, g, b) {
  return makePNG(w, h, () => [r, g, b]);
}

// --- Icon design: indigo bg + white play triangle ---

function triSign(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = triSign(px, py, ax, ay, bx, by);
  const d2 = triSign(px, py, bx, by, cx, cy);
  const d3 = triSign(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function iconPNG(size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.28;
  // Play triangle: right-pointing, slightly left of center
  const ax = cx + r * 1.1,  ay = cy;           // right apex
  const bx = cx - r * 0.55, by = cy - r * 1.0; // top-left
  const ccx = cx - r * 0.55, ccy = cy + r * 1.0; // bottom-left

  return makePNG(size, size, (x, y) => {
    if (size >= 32 && inTriangle(x + 0.5, y + 0.5, ax, ay, bx, by, ccx, ccy)) {
      return [255, 255, 255]; // white triangle
    }
    return [99, 102, 241]; // indigo bg
  });
}

// --- ICO builder ---

function buildIco(images) {
  // images: [{size, png}]
  const count = images.length;
  const dirBytes = 6 + count * 16;

  let offset = dirBytes;
  const entries = images.map(({ size, png }) => {
    const e = { size, png, offset };
    offset += png.length;
    return e;
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const dir = entries.map(({ size, png, offset }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256 in ICO spec
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // color count (0 = >256 colors)
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    return e;
  });

  return Buffer.concat([header, ...dir, ...entries.map(e => e.png)]);
}

// --- Generate ---

mkdirSync('src/assets', { recursive: true });

// Tray: solid indigo 16×16 (unchanged behavior)
writeFileSync('src/assets/tray.png', solidPNG(16, 16, 99, 102, 241));
console.log('Created src/assets/tray.png');

// App icon: generated only if not already present (use your own src/assets/app.ico)
if (!existsSync('src/assets/app.ico')) {
  const sizes = [16, 32, 48, 256];
  const images = sizes.map(size => ({ size, png: iconPNG(size) }));
  writeFileSync('src/assets/app.ico', buildIco(images));
  console.log('Created src/assets/app.ico');
} else {
  console.log('Skipped src/assets/app.ico (custom icon present)');
}
