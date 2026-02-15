import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../fuzzy-match';

describe('fuzzyMatch', () => {
  it('matches empty query against anything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ match: true, score: 0, indices: [] });
    expect(fuzzyMatch('', '')).toEqual({ match: true, score: 0, indices: [] });
  });

  it('matches exact string', () => {
    const result = fuzzyMatch('debug', 'debug');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('matches subsequence characters in order', () => {
    const result = fuzzyMatch('drt', 'debug:rubber-duck-test');
    expect(result.match).toBe(true);
  });

  it('does not match when characters are out of order', () => {
    const result = fuzzyMatch('trd', 'debug:rubber-duck-test');
    expect(result.match).toBe(false);
  });

  it('does not match when characters are missing', () => {
    const result = fuzzyMatch('xyz', 'debug:test');
    expect(result.match).toBe(false);
  });

  it('is case-insensitive', () => {
    const result = fuzzyMatch('DEBUG', 'debug:test');
    expect(result.match).toBe(true);
  });

  it('scores consecutive matches higher than scattered', () => {
    const consecutive = fuzzyMatch('deb', 'debug:test');
    const scattered = fuzzyMatch('det', 'debug:test');
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it('matches colon-separated command names', () => {
    expect(fuzzyMatch('debug:t', '/debug:test').match).toBe(true);
    expect(fuzzyMatch('git:c', '/git:commit').match).toBe(true);
  });

  it('matches partial namespace and command', () => {
    expect(fuzzyMatch('dbr', '/debug:rubber-duck').match).toBe(true);
  });

  // === indices tests ===

  it('returns empty indices for empty query', () => {
    expect(fuzzyMatch('', 'anything').indices).toEqual([]);
  });

  it('returns sequential indices for exact match', () => {
    expect(fuzzyMatch('abc', 'abc').indices).toEqual([0, 1, 2]);
  });

  it('returns sequential indices for exact prefix match', () => {
    expect(fuzzyMatch('src', 'src/index.ts').indices).toEqual([0, 1, 2]);
  });

  it('returns non-sequential indices for subsequence match', () => {
    const result = fuzzyMatch('sit', 'src/index.ts');
    expect(result.match).toBe(true);
    expect(result.indices).toEqual([0, 4, 10]);
  });

  it('indices length equals query length when match is true', () => {
    const result = fuzzyMatch('drt', 'debug:rubber-duck-test');
    expect(result.match).toBe(true);
    expect(result.indices).toHaveLength(3);
  });

  it('returns correct indices for case-insensitive match', () => {
    expect(fuzzyMatch('ABC', 'abcdef').indices).toEqual([0, 1, 2]);
  });

  it('returns correct indices for file path matching', () => {
    const result = fuzzyMatch('cp', 'src/components/chat/ChatPanel.tsx');
    expect(result.match).toBe(true);
    expect(result.indices).toHaveLength(2);
  });
});
