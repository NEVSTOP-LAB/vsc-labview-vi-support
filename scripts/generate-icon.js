#!/usr/bin/env node
/**
 * Generates images/icon.png (128×128) for the LabVIEW VI Support extension.
 *
 * Design: dark navy background (#1A2B3C), LabVIEW orange border ring (#FF8C00),
 *         blue connector terminals (#4A90D9) in VI-pane style,
 *         orange pixel-art "VI" lettering.
 *
 * Uses only Node.js built-ins (zlib + fs) — no external dependencies.
 */

'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── CRC-32 ─────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) { crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff]; }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcBuf    = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ─── Pixel canvas ────────────────────────────────────────────────────────────
const W = 128, H = 128;
// PNG raw data: 1 filter byte (0 = None) + W*3 RGB bytes per row
const raw = Buffer.alloc(H * (1 + W * 3), 0);

function setPixel(x, y, r, g, b) {
  if (x < 0 || x >= W || y < 0 || y >= H) { return; }
  const off = y * (1 + W * 3) + 1 + x * 3;
  raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
}

function fillRect(x, y, w, h, r, g, b) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      setPixel(col, row, r, g, b);
    }
  }
}

/** Filled circle using midpoint check */
function fillCircle(cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) { setPixel(cx + dx, cy + dy, r, g, b); }
    }
  }
}

/**
 * Filled rounded rectangle.
 * Drawn as: central vertical strip + central horizontal strip + 4 corner circles.
 */
function fillRoundRect(x, y, w, h, rad, r, g, b) {
  if (rad <= 0) { fillRect(x, y, w, h, r, g, b); return; }
  fillRect(x + rad, y,       w - 2 * rad, h,           r, g, b);
  fillRect(x,       y + rad, w,           h - 2 * rad, r, g, b);
  fillCircle(x + rad,         y + rad,         rad, r, g, b);
  fillCircle(x + w - rad - 1, y + rad,         rad, r, g, b);
  fillCircle(x + rad,         y + h - rad - 1, rad, r, g, b);
  fillCircle(x + w - rad - 1, y + h - rad - 1, rad, r, g, b);
}

// ─── Draw icon ───────────────────────────────────────────────────────────────
// 1. Outer background (#1A2B3C)
fillRoundRect(0, 0, W, H, 14, 0x1A, 0x2B, 0x3C);

// 2. Orange border ring: full orange rect, then overwrite interior with panel colour
fillRoundRect(4, 4, 120, 120, 12, 0xFF, 0x8C, 0x00);
fillRoundRect(7, 7, 114, 114, 10, 0x24, 0x34, 0x47);

// 3. Connector terminal blocks (blue, LabVIEW VI-pane style)
//    [x, y, width, height]
const TERMINALS = [
  // top row
  [10, 10, 22, 13],
  [53, 10, 22, 13],
  [96, 10, 22, 13],
  // left column
  [10, 46, 13, 15],
  [10, 67, 13, 15],
  // right column
  [105, 46, 13, 15],
  [105, 67, 13, 15],
  // bottom row
  [10, 105, 22, 13],
  [53, 105, 22, 13],
  [96, 105, 22, 13],
];
for (const [tx, ty, tw, th] of TERMINALS) {
  fillRoundRect(tx, ty, tw, th, 2, 0x4A, 0x90, 0xD9);
}

// 4. Pixel-art "VI" lettering (orange, scale S pixels per bit)
const S = 7;
const GLYPHS = {
  V: [
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 1, 0, 0],
  ],
  I: [
    [1, 1, 1],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [1, 1, 1],
  ],
};

function drawGlyph(glyph, ox, oy) {
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col]) {
        fillRect(ox + col * S, oy + row * S, S - 1, S - 1, 0xFF, 0x8C, 0x00);
      }
    }
  }
}

const GAP    = 5;
const totalW = GLYPHS.V[0].length * S + GAP + GLYPHS.I[0].length * S;
const totalH = GLYPHS.V.length * S;
const textX  = Math.floor((W - totalW) / 2);
const textY  = Math.floor((H - totalH) / 2);

drawGlyph(GLYPHS.V, textX, textY);
drawGlyph(GLYPHS.I, textX + GLYPHS.V[0].length * S + GAP, textY);

// ─── Encode to PNG ───────────────────────────────────────────────────────────
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: RGB (no alpha)

const pngData = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', zlib.deflateSync(raw)),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outDir  = path.resolve(__dirname, '..', 'images');
const outFile = path.join(outDir, 'icon.png');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, pngData);
console.log('✓ Generated ' + path.relative(process.cwd(), outFile));
