import { describe, it, expect } from 'vitest';
import { rankMatch } from '../rank-match';

describe('rankMatch — tiers', () => {
  it('matches empty query against anything with a neutral result', () => {
    expect(rankMatch('', 'anything')).toEqual({ match: true, tier: null, score: 0, indices: [] });
    expect(rankMatch('', '')).toEqual({ match: true, tier: null, score: 0, indices: [] });
  });

  it('classifies an exact match', () => {
    const result = rankMatch('debug', 'debug');
    expect(result.match).toBe(true);
    expect(result.tier).toBe('exact');
  });

  it('classifies a prefix match', () => {
    const result = rankMatch('deb', 'debug:test');
    expect(result.match).toBe(true);
    expect(result.tier).toBe('prefix');
  });

  it('classifies a word-boundary match (after a separator)', () => {
    expect(rankMatch('usage', '/usage').tier).toBe('word-boundary');
    expect(rankMatch('test', '/debug:test').tier).toBe('word-boundary');
  });

  it('classifies a camelCase word-boundary match', () => {
    expect(rankMatch('panel', 'src/ChatPanel.tsx').tier).toBe('word-boundary');
  });

  it('classifies a mid-token substring match', () => {
    expect(rankMatch('bug', '/debug:test').tier).toBe('substring');
  });

  it('classifies a scattered subsequence match', () => {
    const result = rankMatch('drt', 'debug:rubber-duck-test');
    expect(result.match).toBe(true);
    expect(result.tier).toBe('subsequence');
  });

  it('does not match when characters are out of order', () => {
    expect(rankMatch('trd', 'debug:rubber-duck-test').match).toBe(false);
  });

  it('does not match when characters are missing', () => {
    const result = rankMatch('xyz', 'debug:test');
    expect(result.match).toBe(false);
    expect(result.tier).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(rankMatch('DEBUG', 'debug:test').match).toBe(true);
    expect(rankMatch('DEBUG', 'debug:test').tier).toBe('prefix');
  });
});

describe('rankMatch — score ordering', () => {
  it('ranks stronger tiers above weaker ones', () => {
    const exact = rankMatch('debug', 'debug').score; // exact
    const prefix = rankMatch('deb', 'debug').score; // prefix
    const wordBoundary = rankMatch('usage', '/usage').score; // word-boundary
    const substring = rankMatch('bug', 'debug').score; // substring
    const subsequence = rankMatch('dbg', 'debug').score; // subsequence

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordBoundary);
    expect(wordBoundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });

  it('ranks clustered subsequence matches above scattered ones', () => {
    // Both are subsequence matches of 'a_bc_d'; 'abc' is more clustered than 'acd'.
    const clustered = rankMatch('abc', 'a_bc_d').score;
    const scattered = rankMatch('acd', 'a_bc_d').score;
    expect(rankMatch('abc', 'a_bc_d').tier).toBe('subsequence');
    expect(clustered).toBeGreaterThan(scattered);
  });
});

describe('rankMatch — indices', () => {
  it('returns empty indices for empty query', () => {
    expect(rankMatch('', 'anything').indices).toEqual([]);
  });

  it('returns sequential indices for an exact match', () => {
    expect(rankMatch('abc', 'abc').indices).toEqual([0, 1, 2]);
  });

  it('returns sequential indices for a prefix match', () => {
    expect(rankMatch('src', 'src/index.ts').indices).toEqual([0, 1, 2]);
  });

  it('returns the matched range for a word-boundary match', () => {
    expect(rankMatch('usage', '/usage').indices).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns the matched range for a substring match', () => {
    expect(rankMatch('bug', '/debug:test').indices).toEqual([3, 4, 5]);
  });

  it('returns non-sequential indices for a subsequence match', () => {
    const result = rankMatch('sit', 'src/index.ts');
    expect(result.match).toBe(true);
    expect(result.tier).toBe('subsequence');
    expect(result.indices).toEqual([0, 4, 10]);
  });

  it('returns correct indices for a case-insensitive match', () => {
    expect(rankMatch('ABC', 'abcdef').indices).toEqual([0, 1, 2]);
  });

  it('returns one index per query char for a file-path subsequence match', () => {
    const result = rankMatch('cp', 'src/components/chat/ChatPanel.tsx');
    expect(result.match).toBe(true);
    expect(result.indices).toHaveLength(2);
  });
});
