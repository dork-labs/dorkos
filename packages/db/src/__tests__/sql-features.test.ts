import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb } from '../index.js';
import { hasPercentileSupport, resetPercentileSupportCache } from '../sql-features.js';

describe('hasPercentileSupport', () => {
  beforeEach(() => {
    resetPercentileSupportCache();
  });

  it('returns true against the repo-pinned better-sqlite3 (DOR-166, 12.10+)', () => {
    const db = createDb(':memory:');
    expect(hasPercentileSupport(db)).toBe(true);
  });

  it('probes only once per process and caches the result', () => {
    const db = createDb(':memory:');
    const prepareSpy = vi.spyOn(db.$client, 'prepare');

    expect(hasPercentileSupport(db)).toBe(true);
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    expect(hasPercentileSupport(db)).toBe(true);
    expect(hasPercentileSupport(db)).toBe(true);
    // Still one probe -- later calls hit the cache, not the database.
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('fails soft to false when the probe query throws (older binary)', () => {
    const db = createDb(':memory:');
    vi.spyOn(db.$client, 'prepare').mockImplementation(() => {
      throw new Error('no such function: percentile_cont');
    });

    expect(() => hasPercentileSupport(db)).not.toThrow();
    expect(hasPercentileSupport(db)).toBe(false);
  });
});
