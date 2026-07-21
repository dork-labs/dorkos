import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

import {
  InstallCountsProvider,
  enrichWithInstallCounts,
  type InstallCountMap,
} from '../install-counts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pkg(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: 'https://github.com/example/pkg',
    marketplace: 'dorkos-community',
    ...overrides,
  };
}

function countsResponse(counts: InstallCountMap): Response {
  return new Response(JSON.stringify({ counts }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE_URL = 'https://dorkos.test';
const COUNTS_URL = `${BASE_URL}/api/telemetry/install-counts`;

// ---------------------------------------------------------------------------
// enrichWithInstallCounts
// ---------------------------------------------------------------------------

describe('enrichWithInstallCounts', () => {
  it('stamps every package with a count (0 for packages absent from the map)', () => {
    const packages = [pkg({ name: 'code-reviewer' }), pkg({ name: 'flow' })];
    const result = enrichWithInstallCounts(packages, { 'code-reviewer': 42 });

    expect(result.map((p) => [p.name, p.installCount])).toEqual([
      ['code-reviewer', 42],
      ['flow', 0],
    ]);
  });

  it('returns the packages unchanged (no installCount) when counts are empty', () => {
    const packages = [pkg({ name: 'code-reviewer' })];
    const result = enrichWithInstallCounts(packages, {});

    expect(result[0].installCount).toBeUndefined();
    expect(result).toEqual(packages);
  });

  it('does not mutate the input packages', () => {
    const packages = [pkg({ name: 'code-reviewer' })];
    enrichWithInstallCounts(packages, { 'code-reviewer': 5 });
    expect(packages[0].installCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// InstallCountsProvider — cache miss / hit / offline degrade
// ---------------------------------------------------------------------------

describe('InstallCountsProvider', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it('returns an empty map on a cold start and kicks off a background refresh (cache miss)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = new InstallCountsProvider({ baseUrl: BASE_URL, fetchImpl, now });

    // First (cold) read: no data yet, but the refresh was triggered.
    expect(provider.getCounts()).toEqual({});
    expect(fetchImpl).toHaveBeenCalledWith(
      COUNTS_URL,
      expect.objectContaining({ signal: expect.anything() })
    );

    // Let the in-flight refresh settle, then the next read serves the counts.
    await vi.waitFor(() => expect(provider.getCounts()).toEqual({ flow: 3 }));
  });

  it('serves cached counts without re-fetching inside the TTL window (cache hit)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = new InstallCountsProvider({
      baseUrl: BASE_URL,
      ttlMs: 60_000,
      fetchImpl,
      now,
    });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance less than the TTL — still fresh, so no second network call.
    clock += 30_000;
    expect(provider.getCounts()).toEqual({ flow: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Cross the TTL — the next read triggers exactly one background refresh.
    clock += 31_000;
    provider.getCounts();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it('degrades to an empty map and never throws when the endpoint is unreachable (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = new InstallCountsProvider({
      baseUrl: BASE_URL,
      ttlMs: 60_000,
      fetchImpl,
      now,
    });

    await expect(provider.refreshNow()).resolves.toBeUndefined();
    expect(provider.getCounts()).toEqual({});
  });

  it('throttles retries after a failure to at most one per TTL', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = new InstallCountsProvider({
      baseUrl: BASE_URL,
      ttlMs: 60_000,
      fetchImpl,
      now,
    });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Within the TTL, repeated browse reads must not hammer the failing host.
    clock += 30_000;
    provider.getCounts();
    provider.getCounts();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the last-known counts when a later refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(countsResponse({ flow: 3 }))
      .mockRejectedValueOnce(new Error('ENOTFOUND'));
    const provider = new InstallCountsProvider({
      baseUrl: BASE_URL,
      ttlMs: 60_000,
      fetchImpl,
      now,
    });

    await provider.refreshNow();
    expect(provider.getCounts()).toEqual({ flow: 3 });

    clock += 61_000;
    await provider.refreshNow();
    // The failed refresh preserved the previous counts rather than clearing them.
    expect(provider.getCounts()).toEqual({ flow: 3 });
  });

  it('ignores a non-OK response body and leaves counts unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const provider = new InstallCountsProvider({ baseUrl: BASE_URL, fetchImpl, now });

    await provider.refreshNow();
    expect(provider.getCounts()).toEqual({});
  });
});
