import { describe, it, expect } from 'vitest';
import { countChangedChunks } from '../lib/hunks';

describe('countChangedChunks', () => {
  it('is zero when baseline equals current', () => {
    expect(countChangedChunks('a\nb\nc\n', 'a\nb\nc\n')).toBe(0);
  });

  it('counts a single changed region as one hunk', () => {
    expect(countChangedChunks('a\nb\nc\n', 'a\nB\nc\n')).toBe(1);
  });

  it('counts two separated changes as two hunks', () => {
    const baseline = 'a\nb\nc\nd\ne\nf\ng\n';
    const current = 'A\nb\nc\nd\ne\nf\nG\n';
    expect(countChangedChunks(baseline, current)).toBe(2);
  });

  it('counts a whole new file (empty baseline) as one hunk', () => {
    expect(countChangedChunks('', 'line1\nline2\n')).toBe(1);
  });
});
