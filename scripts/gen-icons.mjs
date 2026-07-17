/**
 * gen-icons.mjs — rasterise the home-screen icons from the game's own mark.
 *
 *   node scripts/gen-icons.mjs
 *
 * The shapes below ARE public/favicon.svg, in the same 64-unit space and the
 * same palette (src/styles/main.css: --bg0 / --left / --right). Nothing here
 * invents a second look for the game; edit the favicon and re-run this.
 *
 * No sharp, no canvas, no dependency at all: the mark is six rounded rects and
 * circles, which is far less code to draw honestly than a rasteriser is to
 * install. Coverage is sampled SS×SS per pixel for antialiasing, and the PNG is
 * encoded straight out of node's zlib.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');

// ── the mark, straight from favicon.svg (viewBox 0 0 64 64) ─────────────────
const BG = '#0e0b1e';
/** Everything except the background plate — what a maskable icon must inset. */
const CONTENT = [
  { type: 'rrect', x: 16, y: 10, w: 10, h: 26, r: 5, fill: '#22d3ee' },
  { type: 'rrect', x: 38, y: 22, w: 10, h: 14, r: 5, fill: '#f59e0b' },
  { type: 'rrect', x: 10, y: 44, w: 44, h: 5, r: 2.5, fill: '#f8fafc' },
  { type: 'circle', cx: 21, cy: 46.5, r: 4.5, fill: '#22d3ee' },
  { type: 'circle', cx: 43, cy: 46.5, r: 4.5, fill: '#f59e0b' },
];
const PLATE = { type: 'rrect', x: 0, y: 0, w: 64, h: 64, r: 14, fill: BG };

const SS = 4; // subsamples per axis

function rgba(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function inside(shape, x, y) {
  if (shape.type === 'circle') {
    return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
  }
  // Rounded rect as a distance test: clamp to the inner (un-rounded) core, then
  // everything within r of that core is inside.
  const r = shape.r;
  const cx = Math.min(Math.max(x, shape.x + r), shape.x + shape.w - r);
  const cy = Math.min(Math.max(y, shape.y + r), shape.y + shape.h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2 + 1e-9;
}

/**
 * @param {number} size    output px
 * @param {object} opts
 *   opts.plate  'rounded' (favicon's rounded square, transparent corners)
 *             | 'square'  (full-bleed opaque — iOS composites transparency on BLACK)
 *   opts.scale  content scale about the centre (maskable safe zone)
 */
function render(size, opts) {
  const shapes = [];
  if (opts.plate === 'rounded') shapes.push(PLATE);
  const s = opts.scale ?? 1;
  for (const c of CONTENT) {
    // Scale about the 64-space centre so the mark keeps its proportions.
    const t = (v) => 32 + (v - 32) * s;
    shapes.push(
      c.type === 'circle'
        ? { ...c, cx: t(c.cx), cy: t(c.cy), r: c.r * s }
        : { ...c, x: t(c.x), y: t(c.y), w: c.w * s, h: c.h * s, r: c.r * s },
    );
  }
  const colours = shapes.map((sh) => rgba(sh.fill));
  const base = opts.plate === 'square' ? rgba(BG) : null;

  const px = Buffer.alloc(size * size * 4);
  const unit = 64 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [ar, ag, ab, aa] = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * unit;
          const uy = (y + (sy + 0.5) / SS) * unit;
          let hit = base;
          // Later shapes paint over earlier ones, as in the SVG.
          for (let i = 0; i < shapes.length; i++) {
            if (inside(shapes[i], ux, uy)) hit = colours[i];
          }
          if (hit) {
            ar += hit[0];
            ag += hit[1];
            ab += hit[2];
            aa += 255;
          }
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      // Premultiplied average → straight alpha, so the edge pixels of the
      // rounded plate blend to its own colour rather than to black.
      px[o] = aa ? Math.round(ar / (aa / 255)) : 0;
      px[o + 1] = aa ? Math.round(ag / (aa / 255)) : 0;
      px[o + 2] = aa ? Math.round(ab / (aa / 255)) : 0;
      px[o + 3] = Math.round(aa / n);
    }
  }
  return png(px, size);
}

// ── minimal PNG encoder (8-bit RGBA, no interlace) ──────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = deflate / adaptive filtering / no interlace, all zero.

  // Filter byte 0 (None) in front of every scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── outputs ─────────────────────────────────────────────────────────────────
const targets = [
  { file: 'icon-192.png', size: 192, plate: 'rounded' },
  { file: 'icon-512.png', size: 512, plate: 'rounded' },
  // Android crops a non-maskable icon to its adaptive shape and clips the mark.
  // A maskable icon must be full-bleed with everything that matters inside the
  // centre 80% safe zone — hence the plate edge-to-edge and the mark at 0.7.
  { file: 'icon-512-maskable.png', size: 512, plate: 'square', scale: 0.7 },
  // iOS ignores the manifest icons entirely, applies its own rounding, and
  // composites any transparency onto BLACK — so this one is opaque and square.
  { file: 'apple-touch-icon.png', size: 180, plate: 'square' },
];

mkdirSync(OUT, { recursive: true });
for (const t of targets) {
  const buf = render(t.size, t);
  writeFileSync(join(OUT, t.file), buf);
  console.log(`${t.file.padEnd(24)} ${t.size}x${t.size}  ${buf.length} bytes`);
}
