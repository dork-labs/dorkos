import { it, expect } from 'vitest';
import { readJpegRaster } from '../raster.js';
import { fakeJPEG } from '../../__tests__/parent-fixture.js';
it('admits only copied bounded baseline header dimensions', () => {
  expect(readJpegRaster(fakeJPEG(3840, 2160))).toEqual({
    width: 3840,
    height: 2160,
    format: 'jpeg',
  });
  expect(() => readJpegRaster(fakeJPEG(4096, 2048))).not.toThrow();
  expect(() => readJpegRaster(fakeJPEG(4096, 2049))).toThrow('JPEG_HEADER_REFUSED');
});
it.each([
  'progressive',
  'multiple',
  'zero',
  'missingEOI',
  'trailing',
  'shortLength',
  'sampling',
  'selector',
  'SOS',
  'restartWithoutDRI',
])('refuses %s structural ambiguity', (kind) => {
  const original = fakeJPEG();
  let b = original;
  if (kind === 'progressive') b[3] = 194;
  if (kind === 'multiple') b = new Uint8Array([...original.slice(0, 15), ...original.slice(2)]);
  if (kind === 'zero') b[9] = b[10] = 0;
  if (kind === 'missingEOI') b = original.slice(0, -2);
  if (kind === 'trailing') b = new Uint8Array([...original, 255, 216]);
  if (kind === 'shortLength') b[5] = 1;
  if (kind === 'sampling') b[13] = 0;
  if (kind === 'selector') b[14] = 4;
  if (kind === 'SOS') b[20] = 2;
  if (kind === 'restartWithoutDRI')
    b = new Uint8Array([...original.slice(0, -2), 255, 208, 255, 217]);
  expect(() => readJpegRaster(b)).toThrow('JPEG_HEADER_REFUSED');
});
it('handles entropy stuffing/fill, positive DRI and rejects zero-interval restart', () => {
  const original = fakeJPEG();
  const stuffed = new Uint8Array([...original.slice(0, -2), 255, 0, 1, 255, 255, 217]);
  expect(readJpegRaster(stuffed).width).toBe(100);
  for (const interval of [0, 1]) {
    const b = new Uint8Array([
      ...original.slice(0, 2),
      255,
      221,
      0,
      4,
      0,
      interval,
      ...original.slice(2, -2),
      255,
      208,
      255,
      217,
    ]);
    if (interval) expect(readJpegRaster(b).width).toBe(100);
    else expect(() => readJpegRaster(b)).toThrow();
  }
});
it('bounds compressed bytes and refuses missing/truncated segment bodies', () => {
  const original = fakeJPEG();
  const exact = new Uint8Array(2 * 1024 * 1024);
  exact.set(original.slice(0, -2));
  exact.set([255, 217], exact.length - 2);
  expect(readJpegRaster(exact).width).toBe(100);
  const over = new Uint8Array(exact.length + 1);
  over.set(exact);
  expect(() => readJpegRaster(over)).toThrow();
  for (const body of [
    [255, 216],
    [255, 216, 255, 219, 0, 67, 1],
    [255, 216, 255, 196, 0, 2],
    [255, 216, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1, 255, 217],
  ])
    expect(() => readJpegRaster(new Uint8Array(body))).toThrow();
});
it('checks three-component sampling totals, duplicate identifiers and scan table selectors', () => {
  const header = [
    255, 216, 255, 192, 0, 17, 8, 0, 80, 0, 100, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 12,
    3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 1, 255, 217,
  ];
  expect(readJpegRaster(new Uint8Array(header)).width).toBe(100);
  for (const [at, value] of [
    [13, 68],
    [15, 1],
    [27, 68],
    [30, 2],
    [14, 4],
  ] as const) {
    const b = new Uint8Array(header);
    b[at] = value;
    expect(() => readJpegRaster(b)).toThrow();
  }
});
