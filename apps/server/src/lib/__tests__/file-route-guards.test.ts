import { describe, it, expect } from 'vitest';
import { parseByteRange } from '../file-route-guards.js';

const SIZE = 100;

describe('parseByteRange', () => {
  it('serves the full body when no Range header is present', () => {
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  it('parses a bounded range (inclusive end)', () => {
    expect(parseByteRange('bytes=0-9', SIZE)).toEqual({ kind: 'range', start: 0, end: 9 });
  });

  it('treats an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=50-', SIZE)).toEqual({ kind: 'range', start: 50, end: 99 });
  });

  it('clamps an end that runs past the resource to the last byte', () => {
    expect(parseByteRange('bytes=90-999', SIZE)).toEqual({ kind: 'range', start: 90, end: 99 });
  });

  it('resolves a suffix range to the final N bytes', () => {
    expect(parseByteRange('bytes=-10', SIZE)).toEqual({ kind: 'range', start: 90, end: 99 });
  });

  it('clamps a suffix larger than the resource to the whole body', () => {
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('rejects a zero-length suffix as unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects a start at or past the end as unsatisfiable', () => {
    expect(parseByteRange('bytes=100-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=150-160', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects an inverted range (start after end) as unsatisfiable', () => {
    expect(parseByteRange('bytes=20-10', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a non-bytes unit and serves the full body', () => {
    expect(parseByteRange('rows=0-9', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignores a multi-range list (only single ranges are supported)', () => {
    expect(parseByteRange('bytes=0-9,20-29', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignores a fully-empty range', () => {
    expect(parseByteRange('bytes=-', SIZE)).toEqual({ kind: 'full' });
  });
});
