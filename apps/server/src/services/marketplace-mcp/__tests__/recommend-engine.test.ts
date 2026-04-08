import { describe, it, expect } from 'vitest';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { recommend, tokenize } from '../recommend-engine.js';

/**
 * Build a minimal `MarketplaceJsonEntry` with sensible defaults. Only the
 * fields the recommend engine reads (`name`, `description`, `tags`,
 * `featured`) need to be specified by callers.
 */
function entry(overrides: Partial<MarketplaceJsonEntry> & { name: string }): MarketplaceJsonEntry {
  return {
    source: `https://example.com/${overrides.name}`,
    ...overrides,
  } as MarketplaceJsonEntry;
}

/** Wrap an entry in the `{ entry, marketplace }` shape `recommend()` consumes. */
function withMarketplace(
  entries: MarketplaceJsonEntry[],
  marketplace = 'community'
): { entry: MarketplaceJsonEntry; marketplace: string }[] {
  return entries.map((e) => ({ entry: e, marketplace }));
}

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('Track Errors Now')).toEqual(['track', 'errors', 'now']);
  });

  it('strips punctuation', () => {
    expect(tokenize('errors, exceptions! and bugs?')).toEqual(['errors', 'exceptions', 'bugs']);
  });

  it('filters stopwords', () => {
    expect(tokenize('a the in on of for and to my')).toEqual([]);
  });

  it('drops tokens shorter than three characters', () => {
    expect(tokenize('go to my app js ts')).toEqual(['app']);
  });

  it('keeps numeric and hyphenated tokens', () => {
    expect(tokenize('next-js v16 sentry')).toEqual(['next-js', 'v16', 'sentry']);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(tokenize('   \n\t  ')).toEqual([]);
  });
});

describe('recommend', () => {
  it('returns an empty array when context tokenizes to nothing', () => {
    const entries = withMarketplace([entry({ name: 'sentry-monitor' })]);
    expect(recommend(entries, 'a the in on', 5)).toEqual([]);
  });

  it('returns an empty array when no entries score above zero', () => {
    const entries = withMarketplace([
      entry({ name: 'unrelated', description: 'nothing relevant here' }),
    ]);
    expect(recommend(entries, 'sentry monitoring', 5)).toEqual([]);
  });

  it('scores a single name match at +10', () => {
    const entries = withMarketplace([entry({ name: 'sentry' })]);
    const result = recommend(entries, 'sentry', 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(10);
    expect(result[0]!.entry.name).toBe('sentry');
    expect(result[0]!.marketplace).toBe('community');
  });

  it('scores description matches at +3', () => {
    const entries = withMarketplace([
      entry({ name: 'unrelated', description: 'tracks errors and exceptions' }),
    ]);
    const result = recommend(entries, 'errors', 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(3);
  });

  it('scores exact tag matches at +5', () => {
    const entries = withMarketplace([entry({ name: 'unrelated', tags: ['monitoring', 'errors'] })]);
    const result = recommend(entries, 'monitoring', 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(5);
  });

  it('does not match tags as substrings — only exact equality', () => {
    const entries = withMarketplace([entry({ name: 'unrelated', tags: ['monitoring'] })]);
    const result = recommend(entries, 'monitor', 5);
    expect(result).toEqual([]);
  });

  it('combines name, description, and tag matches additively', () => {
    const entries = withMarketplace([
      entry({
        name: 'sentry-monitor',
        description: 'Track errors and exceptions',
        tags: ['errors', 'monitoring'],
      }),
    ]);
    // tokens: ['sentry', 'errors']
    // name 'sentry-monitor' contains 'sentry' (+10)
    // desc 'track errors and exceptions' contains 'errors' (+3)
    // tag 'errors' exactly matches token 'errors' (+5)
    // total = 18
    const result = recommend(entries, 'sentry errors', 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(18);
  });

  it('applies +2 featured boost', () => {
    const entries = withMarketplace([
      entry({ name: 'sentry-a', featured: true }),
      entry({ name: 'sentry-b', featured: false }),
    ]);
    const result = recommend(entries, 'sentry', 5);
    expect(result).toHaveLength(2);
    expect(result[0]!.entry.name).toBe('sentry-a');
    expect(result[0]!.score).toBe(12);
    expect(result[1]!.entry.name).toBe('sentry-b');
    expect(result[1]!.score).toBe(10);
  });

  it('sorts by score descending', () => {
    const entries = withMarketplace([
      entry({ name: 'low-relevance', description: 'mentions sentry once' }),
      entry({ name: 'sentry-monitor', tags: ['sentry'] }),
      entry({ name: 'unrelated' }),
    ]);
    const result = recommend(entries, 'sentry', 5);
    expect(result.map((r) => r.entry.name)).toEqual(['sentry-monitor', 'low-relevance']);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it('truncates the result to the limit', () => {
    const entries = withMarketplace(
      Array.from({ length: 10 }, (_, i) => entry({ name: `sentry-${i}` }))
    );
    const result = recommend(entries, 'sentry', 3);
    expect(result).toHaveLength(3);
  });

  it('exact tag match outranks partial description match', () => {
    const entries = withMarketplace([
      entry({ name: 'a', description: 'sentry is mentioned in the description text' }),
      entry({ name: 'b', tags: ['sentry'] }),
    ]);
    const result = recommend(entries, 'sentry', 5);
    expect(result[0]!.entry.name).toBe('b');
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it('preserves the source marketplace name on each result', () => {
    const a = withMarketplace([entry({ name: 'sentry-a' })], 'community');
    const b = withMarketplace([entry({ name: 'sentry-b' })], 'personal');
    const result = recommend([...a, ...b], 'sentry', 5);
    const byName = Object.fromEntries(result.map((r) => [r.entry.name, r.marketplace]));
    expect(byName['sentry-a']).toBe('community');
    expect(byName['sentry-b']).toBe('personal');
  });

  it('produces a non-empty reason string when scoring above zero', () => {
    const entries = withMarketplace([
      entry({ name: 'sentry', description: 'errors', tags: ['monitoring'] }),
    ]);
    const result = recommend(entries, 'sentry errors monitoring', 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.reason.length).toBeGreaterThan(0);
  });

  it('handles realistic scenario: sentry-monitor matches "track errors in Next.js app"', () => {
    const entries = withMarketplace([
      entry({
        name: 'sentry-monitor',
        description: 'Track errors and exceptions',
        tags: ['errors', 'monitoring'],
      }),
      entry({ name: 'unrelated-tool', description: 'does something else entirely' }),
    ]);
    const result = recommend(entries, 'I need to track errors in my Next.js app', 5);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.entry.name).toBe('sentry-monitor');
    expect(result[0]!.score).toBeGreaterThan(0);
  });
});
