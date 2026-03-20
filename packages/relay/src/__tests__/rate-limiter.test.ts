import { describe, it, expect } from 'vitest';
import { checkRateLimit, resolveLimit, DEFAULT_RATE_LIMIT_CONFIG } from '../rate-limiter.js';
import type { RateLimitConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return { ...DEFAULT_RATE_LIMIT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe('checkRateLimit', () => {
  it('allows message when count is below limit', () => {
    const config = makeConfig({ maxPerWindow: 100 });
    const result = checkRateLimit('relay.sender.a', 50, config);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects message when count equals limit', () => {
    const config = makeConfig({ maxPerWindow: 100 });
    const result = checkRateLimit('relay.sender.a', 100, config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rate limit exceeded');
    expect(result.reason).toContain('100/100');
  });

  it('rejects message when count exceeds limit', () => {
    const config = makeConfig({ maxPerWindow: 10 });
    const result = checkRateLimit('relay.sender.a', 15, config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rate limit exceeded');
    expect(result.reason).toContain('15/10');
  });

  it('allows message when rate limiting is disabled', () => {
    const config = makeConfig({ enabled: false, maxPerWindow: 5 });
    const result = checkRateLimit('relay.sender.a', 999, config);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    // When disabled, no diagnostics are returned
    expect(result.currentCount).toBeUndefined();
    expect(result.limit).toBeUndefined();
  });

  it('returns current count and limit in result', () => {
    const config = makeConfig({ maxPerWindow: 50 });
    const result = checkRateLimit('relay.sender.a', 30, config);

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(30);
    expect(result.limit).toBe(50);
  });

  it('includes rejection reason with count details', () => {
    const config = makeConfig({ maxPerWindow: 20, windowSecs: 120 });
    const result = checkRateLimit('relay.sender.a', 25, config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rate limit exceeded: 25/20 messages in 120s window');
    expect(result.currentCount).toBe(25);
    expect(result.limit).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// resolveLimit
// ---------------------------------------------------------------------------

describe('resolveLimit', () => {
  it('returns maxPerWindow when no overrides configured', () => {
    const config = makeConfig({ maxPerWindow: 100 });

    const limit = resolveLimit('relay.sender.a', config);

    expect(limit).toBe(100);
  });

  it('returns override limit for exact prefix match', () => {
    const config = makeConfig({
      maxPerWindow: 100,
      perSenderOverrides: {
        'relay.sender.a': 10,
      },
    });

    const limit = resolveLimit('relay.sender.a', config);

    expect(limit).toBe(10);
  });

  it('returns longest matching prefix override', () => {
    const config = makeConfig({
      maxPerWindow: 100,
      perSenderOverrides: {
        relay: 50,
        'relay.sender': 25,
        'relay.sender.a': 10,
      },
    });

    // Should match 'relay.sender.a' (longest prefix), not 'relay' or 'relay.sender'
    const limit = resolveLimit('relay.sender.a.sub', config);

    expect(limit).toBe(10);
  });

  it('returns maxPerWindow when no prefix matches', () => {
    const config = makeConfig({
      maxPerWindow: 100,
      perSenderOverrides: {
        'mesh.agent': 20,
        'external.api': 5,
      },
    });

    const limit = resolveLimit('relay.sender.a', config);

    expect(limit).toBe(100);
  });
});
