import { describe, it, expect } from 'vitest';
import { resolveSuggestionPool, suggestionWindow } from '../lib/name-suggestions';

describe('resolveSuggestionPool', () => {
  it('returns the default pool for design-your-own (no context)', () => {
    const pool = resolveSuggestionPool();
    expect(pool).toContain('Atlas'); // default-only member
  });

  it('resolves a keeper theme from board/organize language', () => {
    const pool = resolveSuggestionPool({
      name: 'linear-keeper',
      description: 'Keeps your Linear board tidy',
    });
    expect(pool).toContain('Keeper');
  });

  it('resolves a guardian theme from review language', () => {
    const pool = resolveSuggestionPool({ description: 'Reviews pull requests' });
    expect(pool).toContain('Sentinel');
  });

  it('resolves a scribe theme from docs language', () => {
    const pool = resolveSuggestionPool({ description: 'Writes documentation', tags: ['docs'] });
    expect(pool).toContain('Scribe');
  });

  it('falls back to default when nothing matches', () => {
    const pool = resolveSuggestionPool({ description: 'plays chess' });
    expect(pool).toContain('Atlas');
  });
});

describe('suggestionWindow', () => {
  const pool = ['A', 'B', 'C', 'D', 'E'];

  it('returns the first N at offset 0', () => {
    expect(suggestionWindow(pool, 0, 3)).toEqual(['A', 'B', 'C']);
  });

  it('advances and wraps around on reroll', () => {
    expect(suggestionWindow(pool, 4, 3)).toEqual(['E', 'A', 'B']);
  });

  it('never returns more than the pool holds', () => {
    expect(suggestionWindow(['A', 'B'], 0, 4)).toEqual(['A', 'B']);
  });

  it('returns an empty list for an empty pool', () => {
    expect(suggestionWindow([], 0, 4)).toEqual([]);
  });
});
