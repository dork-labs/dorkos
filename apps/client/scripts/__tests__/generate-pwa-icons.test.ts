import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const PUBLIC_DIR = resolve(__dirname, '../../public');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Reads a PNG file's pixel dimensions straight out of its `IHDR` chunk
 * (bytes 16-23, big-endian width then height) — no image library needed for
 * a sanity check this small.
 *
 * @param path - Absolute path to the PNG file.
 */
function readPngDimensions(path: string): { width: number; height: number } {
  const buffer = readFileSync(path);
  expect([...buffer.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('generated PWA icons', () => {
  it.each([
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'maskable-icon-512.png', size: 512 },
    { file: 'apple-touch-icon.png', size: 180 },
  ])('$file is a $size x $size PNG', ({ file, size }) => {
    const path = resolve(PUBLIC_DIR, file);
    expect(readPngDimensions(path)).toEqual({ width: size, height: size });
  });

  it.each([
    // Floors sit above a MEASURED blank render at each size (a solid-color
    // PNG this size, glyph missing entirely): 2055 / 6406 / 1897 / 513 bytes
    // respectively. A glyph-less render is exactly the failure this test
    // exists to catch — rsvg-convert silently drawing only the background —
    // so the floor has to clear that number, not just "not literally empty".
    { file: 'icon-192.png', minBytes: 2500 },
    { file: 'icon-512.png', minBytes: 7000 },
    { file: 'maskable-icon-512.png', minBytes: 3000 },
    { file: 'apple-touch-icon.png', minBytes: 1000 },
  ])('$file is not an empty, truncated, or glyph-less render', ({ file, minBytes }) => {
    const { size } = statSync(resolve(PUBLIC_DIR, file));
    expect(size).toBeGreaterThan(minBytes);
  });
});
