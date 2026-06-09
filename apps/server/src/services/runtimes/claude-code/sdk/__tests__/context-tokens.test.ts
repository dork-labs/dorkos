import { describe, it, expect } from 'vitest';
import { sumContextTokens } from '../context-tokens.js';

describe('sumContextTokens', () => {
  it('sums fresh input, cache reads, and cache writes', () => {
    expect(
      sumContextTokens({ inputTokens: 11838, cacheReadTokens: 17451, cacheCreationTokens: 5670 })
    ).toBe(11838 + 17451 + 5670);
  });

  it('treats missing components as zero (not the whole sum)', () => {
    // Regression guard: counting input_tokens alone understated cached
    // conversations and caused the context-usage status-bar bug.
    expect(sumContextTokens({ inputTokens: 1000 })).toBe(1000);
    expect(sumContextTokens({ cacheReadTokens: 500 })).toBe(500);
  });

  it('returns 0 when every component is absent or null', () => {
    expect(sumContextTokens({})).toBe(0);
    expect(
      sumContextTokens({ inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null })
    ).toBe(0);
  });
});
