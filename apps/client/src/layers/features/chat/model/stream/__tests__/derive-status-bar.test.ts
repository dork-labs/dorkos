import { describe, it, expect } from 'vitest';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { deriveStatusBarValues } from '../derive-status-bar';

const baseStatus: SessionStatus = {
  contextUsage: null,
  cost: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
};

describe('deriveStatusBarValues', () => {
  it('returns all-null for a null status (pre-hydration fallback)', () => {
    // Purpose: before the snapshot hydrates, the caller must fall back to its
    // legacy values rather than rendering zeros.
    expect(deriveStatusBarValues(null)).toEqual({
      contextPercent: null,
      costUsd: null,
      model: null,
      cacheStatus: null,
    });
  });

  it('computes context percentage from token totals on cold mount', () => {
    // Purpose: a snapshot with context usage must yield a non-null percentage so
    // the context item renders immediately on refresh.
    const status: SessionStatus = {
      ...baseStatus,
      contextUsage: {
        totalTokens: 50_000,
        maxTokens: 200_000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
    expect(deriveStatusBarValues(status).contextPercent).toBe(25);
  });

  it('surfaces cost and cache accounting from the snapshot', () => {
    // Purpose: cost and cache items must populate from the snapshot without a
    // live event.
    const status: SessionStatus = {
      ...baseStatus,
      cost: 0.42,
      cacheStats: { cacheReadTokens: 800, cacheCreationTokens: 200 },
      contextUsage: {
        totalTokens: 1200,
        maxTokens: 200_000,
        outputTokens: 50,
        cacheReadTokens: 800,
        cacheCreationTokens: 200,
      },
    };
    const values = deriveStatusBarValues(status);
    expect(values.costUsd).toBe(0.42);
    expect(values.cacheStatus).toEqual({
      cacheReadTokens: 800,
      cacheCreationTokens: 200,
      contextTokens: 1200,
    });
  });

  it('returns null cacheStatus when there is no cache activity', () => {
    // Purpose: a zero-token cache must not render an empty cache item.
    const status: SessionStatus = {
      ...baseStatus,
      cacheStats: { cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
    expect(deriveStatusBarValues(status).cacheStatus).toBeNull();
  });

  it('returns null contextPercent when maxTokens is zero', () => {
    // Purpose: guard against divide-by-zero before the model context window is known.
    const status: SessionStatus = {
      ...baseStatus,
      contextUsage: {
        totalTokens: 100,
        maxTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
    expect(deriveStatusBarValues(status).contextPercent).toBeNull();
  });
});
