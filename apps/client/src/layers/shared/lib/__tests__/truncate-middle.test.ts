import { describe, it, expect } from 'vitest';
import { truncateMiddle } from '../truncate-middle';

describe('truncateMiddle', () => {
  it('returns short paths unchanged', () => {
    expect(truncateMiddle('~/foo/bar.md', 40)).toBe('~/foo/bar.md');
  });

  it('truncates long paths with middle ellipsis keeping the basename', () => {
    const long = '/Users/dorian/Keep/dork-os/core/packages/shared/src/schemas.ts';
    const result = truncateMiddle(long, 40);
    expect(result.endsWith('/schemas.ts')).toBe(true);
    expect(result).toContain('…/');
  });

  it('reserves a minimum head budget of 6 characters even for very long basenames', () => {
    const path = '/very/long/directory/tree/that-is-a-super-long-basename.md';
    const result = truncateMiddle(path, 20);
    expect(result.length).toBeGreaterThanOrEqual(20);
    expect(result.endsWith('/that-is-a-super-long-basename.md')).toBe(true);
  });

  it('handles paths with no slashes gracefully', () => {
    expect(truncateMiddle('verylongbasename-with-no-slashes.md', 20)).toContain('…');
  });
});
