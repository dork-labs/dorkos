/**
 * What counts as a photo — decided by the bytes, never by what the upload
 * claimed to be. A `Content-Type` header and a `.png` suffix are both written by
 * whoever is uploading, so neither one is evidence.
 */
import { describe, it, expect } from 'vitest';
import { sniffImageContentType } from '../image-sniff.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
/**
 * "RIFF"/"WEBP" with bit 7 set on every letter, followed by an HTML payload.
 *
 * `Buffer.toString('ascii')` masks bit 7, so it decodes these bytes to the
 * literal strings `RIFF` and `WEBP` — which is how this was accepted, stored and
 * served as `image/webp` in review. It is the exact reason the sniff compares
 * bytes rather than decoded text.
 */
const HIGH_BIT_RIFF = Buffer.concat([
  Buffer.from([0xd2, 0xc9, 0xc6, 0xc6]),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from([0xd7, 0xc5, 0xc2, 0xd0]),
  Buffer.from('<html><script>alert(1)</script></html>'),
]);

describe('sniffImageContentType', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['webp', WEBP, 'image/webp'],
  ])('recognises a %s by its magic bytes', (_name, bytes, expected) => {
    expect(sniffImageContentType(bytes)).toBe(expected);
  });

  it('refuses an SVG — a script vector is not a profile photo', () => {
    expect(sniffImageContentType(SVG)).toBeNull();
  });

  it('refuses a GIF, whatever it was uploaded as', () => {
    expect(sniffImageContentType(GIF)).toBeNull();
  });

  it('refuses high-bit bytes that only DECODE to RIFF/WEBP', () => {
    expect(sniffImageContentType(HIGH_BIT_RIFF)).toBeNull();
  });

  it('refuses a RIFF container that is not WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WAVEfmt '),
    ]);
    expect(sniffImageContentType(wav)).toBeNull();
  });

  it('refuses bytes too short to be anything', () => {
    expect(sniffImageContentType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });
});
