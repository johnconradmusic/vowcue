import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const size = 512;
const root = process.cwd();
const tauriIconPath = path.join(root, "src-tauri", "icons", "icon.png");
const assetIconPath = path.join(root, "assets", "vowcue-icon.png");

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const raw = Buffer.alloc((size * 4 + 1) * size);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  const alpha = a / 255;
  raw[offset] = Math.round(raw[offset] * (1 - alpha) + r * alpha);
  raw[offset + 1] = Math.round(raw[offset + 1] * (1 - alpha) + g * alpha);
  raw[offset + 2] = Math.round(raw[offset + 2] * (1 - alpha) + b * alpha);
  raw[offset + 3] = 255;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  const c2 = vx * vx + vy * vy;
  const t = Math.max(0, Math.min(1, c1 / c2));
  const x = ax + t * vx;
  const y = ay + t * vy;
  return Math.hypot(px - x, py - y);
}

for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < size; x += 1) {
    const dx = x - size / 2;
    const dy = y - size / 2;
    const dist = Math.hypot(dx, dy) / (size / 2);
    const glow = Math.max(0, 1 - dist);
    const offset = row + 1 + x * 4;
    raw[offset] = Math.round(17 + glow * 28);
    raw[offset + 1] = Math.round(16 + glow * 70);
    raw[offset + 2] = Math.round(15 + glow * 62);
    raw[offset + 3] = 255;
  }
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const d1 = Math.abs(Math.hypot(x - 206, y - 190) - 82);
    const d2 = Math.abs(Math.hypot(x - 306, y - 190) - 82);
    if (d1 < 8) setPixel(x, y, 233, 135, 143, 230);
    if (d2 < 8) setPixel(x, y, 54, 214, 178, 230);
  }
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const left = distanceToSegment(x, y, 145, 170, 256, 372);
    const right = distanceToSegment(x, y, 367, 170, 256, 372);
    const d = Math.min(left, right);
    if (d < 25) {
      const edge = Math.max(0, Math.min(1, (25 - d) / 8));
      setPixel(x, y, 255, 248, 238, Math.round(255 * edge));
    }
  }
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const d = distanceToSegment(x, y, 158, 122, 354, 122);
    if (d < 10) setPixel(x, y, 54, 214, 178, 220);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

await mkdir(path.dirname(tauriIconPath), { recursive: true });
await mkdir(path.dirname(assetIconPath), { recursive: true });
await Promise.all([writeFile(tauriIconPath, png), writeFile(assetIconPath, png)]);
console.log(`Wrote ${path.relative(root, tauriIconPath)}`);
console.log(`Wrote ${path.relative(root, assetIconPath)}`);
