import { expect, it } from 'vitest';
import { inspectBrowserFrameRaster } from '../lib/frame-raster';

// Header protocol fixtures intentionally do not stand in for original browser raster decoding.
function chunk(kind: string, body: number[]) {
  const bytes = [...kind].map((letter) => letter.charCodeAt(0)).concat(body);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return [...word(body.length), ...bytes, ...word(crc)];
}
function word(value: number) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
function png(width = 100, height = 80, extra: number[] = []) {
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...word(width), ...word(height), 8, 6, 0, 0, 0]),
    ...extra,
    ...chunk('IDAT', [0]),
    ...chunk('IEND', []),
  ]);
}
it('reads exact bounded PNG dimensions from verified header and chunk envelope without decoding', () => {
  const result = inspectBrowserFrameRaster(png(), 'png');
  expect(result).toEqual({ width: 100, height: 80, format: 'png' });
  expect(Object.isFrozen(result)).toBe(true);
});
it.each([
  'signature',
  'crc',
  'truncated',
  'trailing',
  'compressed-metadata',
  'animation',
  'duplicate-header',
  'empty-data',
] as const)('refuses PNG %s before a decoder can be entered', (mode) => {
  let bytes = png();
  if (mode === 'signature') bytes[0] = 0;
  if (mode === 'crc') bytes[29] ^= 1;
  if (mode === 'truncated') bytes = bytes.slice(0, -1);
  if (mode === 'trailing') bytes = new Uint8Array([...bytes, 0]);
  if (mode === 'compressed-metadata') bytes = png(100, 80, chunk('iCCP', [0]));
  if (mode === 'animation') bytes = png(100, 80, chunk('acTL', [...word(1), ...word(0)]));
  if (mode === 'duplicate-header')
    bytes = png(100, 80, chunk('IHDR', [...word(100), ...word(80), 8, 6, 0, 0, 0]));
  if (mode === 'empty-data')
    bytes = new Uint8Array([...png().slice(0, 33), ...chunk('IDAT', []), ...chunk('IEND', [])]);
  expect(() => inspectBrowserFrameRaster(bytes, 'png')).toThrow(
    expect.objectContaining({ reason: 'header' })
  );
});
it.each([
  [16384, 16384],
  [16385, 1],
  [0, 80],
])('refuses PNG declared raster %s by %s within a tiny compressed envelope', (width, height) => {
  expect(() => inspectBrowserFrameRaster(png(width, height), 'png')).toThrow(
    expect.objectContaining({ reason: 'budget' })
  );
});
it('refuses compressed byte budget before scanning headers', () => {
  expect(() => inspectBrowserFrameRaster(new Uint8Array(2 * 1024 * 1024 + 1), 'jpeg')).toThrow(
    expect.objectContaining({ reason: 'budget' })
  );
});
