import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../routes/exports.js';

describe('parseByteRange', () => {
  // Purpose: the download serves exactly the bytes RFC 9110 names. Fails if a suffix, an open
  // end, a clamped end, a range past the end, or an unsupported form is read differently.
  it.each([
    [undefined, 100, null],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=90-500', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=99-99', 100, { start: 99, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=100-200', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=9-0', 100, null],
    ['bytes=-', 100, null],
    ['bytes=0-1,5-6', 100, null],
    ['items=0-1', 100, null],
    ['bytes=abc', 100, null],
  ] as const)('reads %s of %i bytes', (header, size, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });
});
