import { describe, it, expect } from 'vitest';
import { mainModelContextWindow, sumContextTokens } from '../context-tokens.js';

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

describe('mainModelContextWindow', () => {
  // The shape SDK 0.3.280 returned for a live one-turn `claude-opus-5-5[1m]`
  // query: the CLI's Haiku helper comes FIRST, the main model second.
  const opus1m = {
    'claude-haiku-4-5-20251001': { contextWindow: 200_000, canonicalModel: 'claude-haiku-4-5' },
    'claude-opus-5-5[1m]': { contextWindow: 1_000_000, canonicalModel: 'claude-opus-5-5' },
  };

  it('reads the main model, not the first entry (a 1M chat is not 200k)', () => {
    expect(mainModelContextWindow(opus1m, 'claude-opus-5-5[1m]')).toBe(1_000_000);
  });

  it('matches the API model id the assistant message names, without the [1m] suffix', () => {
    expect(mainModelContextWindow(opus1m, 'claude-opus-5-5')).toBe(1_000_000);
  });

  it('reads a 200k main model as 200k even when a bigger model is also listed', () => {
    expect(mainModelContextWindow(opus1m, 'claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('falls back to the largest window when the main model is unknown or unmatched', () => {
    expect(mainModelContextWindow(opus1m, undefined)).toBe(1_000_000);
    expect(mainModelContextWindow(opus1m, 'claude-sonnet-5')).toBe(1_000_000);
  });

  it('returns undefined when no entry reports a window', () => {
    expect(mainModelContextWindow(undefined, 'x')).toBeUndefined();
    expect(mainModelContextWindow({}, 'x')).toBeUndefined();
    expect(mainModelContextWindow({ a: { contextWindow: 0 } }, 'a')).toBeUndefined();
  });
});
