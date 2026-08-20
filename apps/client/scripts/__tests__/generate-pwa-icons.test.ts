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
    { file: 'icon-192.png', minBytes: 500 },
    { file: 'icon-512.png', minBytes: 500 },
    { file: 'maskable-icon-512.png', minBytes: 500 },
    { file: 'apple-touch-icon.png', minBytes: 300 },
  ])('$file is not an empty or truncated render', ({ file, minBytes }) => {
    const { size } = statSync(resolve(PUBLIC_DIR, file));
    // A blank or failed render collapses to a near-empty file (a solid-color
    // PNG this size compresses to a few hundred bytes); a real render with
    // the glyph in it runs well past that floor.
    expect(size).toBeGreaterThan(minBytes);
  });
});
