/**
 * manifest.test.ts — the game must actually install to a phone home screen.
 *
 * Every icon here is checked by READING ITS PNG HEADER, not by trusting the file
 * name: a manifest that promises 512x512 and ships a 192 gets silently rejected
 * or rendered blurry, and "the file exists" is no evidence of what is in it.
 *
 * The two platform traps this pins:
 *  - Android crops a non-maskable icon to its adaptive shape, so a "maskable"
 *    entry has to be there or the mark gets its corners cut off.
 *  - iOS ignores the manifest icons entirely and composites transparency onto
 *    BLACK, so apple-touch-icon must be fully opaque.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(__dirname, '..', 'public');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

/** Parse a PNG's IHDR — the bytes, not the filename. */
function ihdr(file: string): { width: number; height: number; depth: number; colour: number } {
  const b = readFileSync(join(PUBLIC, file));
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), depth: b[24], colour: b[25] };
}

/** True if any pixel is less than fully opaque. */
function hasTransparency(file: string): boolean {
  const b = readFileSync(join(PUBLIC, file));
  const { width, height, colour } = ihdr(file);
  expect(colour).toBe(6); // RGBA — this reader handles no other

  // Walk the chunks and concatenate every IDAT before inflating: a large PNG is
  // free to split its stream, and reading only the first would decode garbage.
  const idat: Buffer[] = [];
  let p = 8;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.subarray(p + 4, p + 8).toString('ascii');
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter 0 (None); anything else needs undoing
    for (let x = 0; x < width; x++) {
      if (raw[y * stride + 1 + x * 4 + 3] !== 255) return true;
    }
  }
  return false;
}

describe('manifest.webmanifest', () => {
  it('has the fields a browser needs to offer an install', () => {
    expect(manifest.name).toBe('Rhythm Relay');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // or the launcher truncates it
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBeTruthy();
  });

  it('keeps start_url and scope RELATIVE so both the dev subpath and the custom domain work', () => {
    // An absolute "/" would point at the host root, which in dev is not the game.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('paints the splash and chrome in the game palette, not white', () => {
    // --bg0 in src/styles/main.css. A mismatch flashes white on launch.
    expect(manifest.background_color).toBe('#0e0b1e');
    expect(manifest.theme_color).toBe('#0e0b1e');
    expect(html).toContain('<meta name="theme-color" content="#0e0b1e" />');
  });

  it('ships every icon it declares, at the size it declares', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const file = icon.src.replace('./', '');
      const [w, h] = icon.sizes.split('x').map(Number);
      const head = ihdr(file);
      expect({ file, w: head.width, h: head.height }).toEqual({ file, w, h });
      expect(icon.type).toBe('image/png');
    }
  });

  it('offers both 192 and 512, plus a maskable 512 for Android', () => {
    const any = manifest.icons.filter((i: { purpose: string }) => i.purpose === 'any');
    expect(any.map((i: { sizes: string }) => i.sizes).sort()).toEqual(['192x192', '512x512']);

    const maskable = manifest.icons.find((i: { purpose: string }) => i.purpose === 'maskable');
    expect(maskable).toBeTruthy();
    expect(maskable.sizes).toBe('512x512');
    // Adaptive icons are cropped to the centre ~80%, so a maskable one must be
    // full-bleed — any transparent corner would crop to a bare gap.
    expect(hasTransparency(maskable.src.replace('./', ''))).toBe(false);
  });
});

describe('iOS home-screen install (the manifest does NOT cover this)', () => {
  it('links an apple-touch-icon at 180x180', () => {
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png" />');
    const head = ihdr('apple-touch-icon.png');
    expect([head.width, head.height]).toEqual([180, 180]);
  });

  it('gives iOS an OPAQUE icon — it composites transparency onto black', () => {
    expect(hasTransparency('apple-touch-icon.png')).toBe(false);
  });

  it('declares the standalone web-app meta iOS actually reads', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Rhythm Relay" />');
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
  });
});
