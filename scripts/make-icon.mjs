// Draws the app icon (a white briefcase on a blue rounded square) without any image tools,
// and writes build/icon.png, which electron-builder also turns into the Windows .ico.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SAMPLES = 4;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

function roundedRect(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, x - (right - radius), 0);
  const dy = Math.max(top + radius - y, y - (bottom - radius), 0);
  return dx * dx + dy * dy <= radius * radius && x >= left && x <= right && y >= top && y <= bottom;
}

const BLUE = [59, 91, 219];
const WHITE = [255, 255, 255];

function colorAt(x, y) {
  if (!roundedRect(x, y, 16, 16, 496, 496, 104)) return null;
  // Handle: an outline above the case.
  const handle = roundedRect(x, y, 186, 112, 326, 210, 26) && !roundedRect(x, y, 214, 140, 298, 210, 10);
  // Case body, with a band across the middle where the lid meets it.
  const body = roundedRect(x, y, 96, 176, 416, 400, 36);
  const band = y > 272 && y < 298;
  const clasp = roundedRect(x, y, 228, 258, 284, 312, 10);
  if (clasp) return WHITE;
  if (body && !band) return WHITE;
  if (handle) return WHITE;
  return BLUE;
}

const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let py = 0; py < SIZE; py += 1) {
  const rowStart = py * (SIZE * 4 + 1);
  rows[rowStart] = 0;
  for (let px = 0; px < SIZE; px += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const color = colorAt(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES);
        if (!color) continue;
        r += color[0];
        g += color[1];
        b += color[2];
        a += 1;
      }
    }
    const offset = rowStart + 1 + px * 4;
    if (a > 0) {
      rows[offset] = Math.round(r / a);
      rows[offset + 1] = Math.round(g / a);
      rows[offset + 2] = Math.round(b / a);
      rows[offset + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
);
console.log(`Wrote ${out}`);
