import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

import {
  InstallCountsProvider,
  enrichWithInstallCounts,
  type InstallCountMap,
  type InstallCountsProviderOptions,
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

  it('only stamps community packages — a same-named package in another marketplace stays un-enriched', () => {
    // The count map is scoped to dorkos-community, so a name collision in a
    // second marketplace must NOT borrow community popularity.
    const community = pkg({ name: 'code-reviewer', marketplace: 'dorkos-community' });
    const otherMarket = pkg({ name: 'code-reviewer', marketplace: 'acme-internal' });

    const result = enrichWithInstallCounts([community, otherMarket], { 'code-reviewer': 42 });

    expect(result[0]).toMatchObject({ marketplace: 'dorkos-community', installCount: 42 });
    expect(result[1]).toMatchObject({ marketplace: 'acme-internal' });
    expect(result[1].installCount).toBeUndefined();
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

  /**
   * Build a provider on the fixed test clock with the telemetry kill switch OFF
   * by default, so a fetch-expecting test never depends on the ambient
   * DO_NOT_TRACK / DORKOS_TELEMETRY_DISABLED of the machine running it. Consent
   * tests override `telemetryEnv`.
   */
  function makeProvider(options: InstallCountsProviderOptions = {}): InstallCountsProvider {
    return new InstallCountsProvider({ baseUrl: BASE_URL, now, telemetryEnv: {}, ...options });
  }

  it('returns an empty map on a cold start and kicks off a background refresh (cache miss)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = makeProvider({ fetchImpl });

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
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

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
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await expect(provider.refreshNow()).resolves.toBeUndefined();
    expect(provider.getCounts()).toEqual({});
  });

  it('throttles retries after a failure to at most one per TTL', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

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
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await provider.refreshNow();
    expect(provider.getCounts()).toEqual({ flow: 3 });

    clock += 61_000;
    await provider.refreshNow();
    // The failed refresh preserved the previous counts rather than clearing them.
    expect(provider.getCounts()).toEqual({ flow: 3 });
  });

  it('ignores a non-OK response body and leaves counts unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const provider = makeProvider({ fetchImpl });

    await provider.refreshNow();
    expect(provider.getCounts()).toEqual({});
  });

  it('drops non-finite count values so a malformed body cannot NaN the comparator', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          counts: { flow: 7, bad: 'lots', nan: Number.NaN, nullish: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const provider = makeProvider({ fetchImpl });

    await provider.refreshNow();
    // Only the finite numeric entry survives.
    expect(provider.getCounts()).toEqual({ flow: 7 });
  });

  it('strips trailing slashes from the base URL so the request path never doubles up', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = makeProvider({ baseUrl: `${BASE_URL}///`, fetchImpl });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledWith(COUNTS_URL, expect.anything());
  });

  it('never fires a request when a telemetry kill switch is set (consent gate)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = makeProvider({ fetchImpl, telemetryEnv: { DO_NOT_TRACK: '1' } });

    await provider.refreshNow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getCounts()).toEqual({});
  });

  it('honors DORKOS_TELEMETRY_DISABLED as well, and stays throttled so it does not spin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(countsResponse({ flow: 3 }));
    const provider = makeProvider({
      ttlMs: 60_000,
      fetchImpl,
      telemetryEnv: { DORKOS_TELEMETRY_DISABLED: 'true' },
    });

    // Cold read triggers a background refresh that returns early (no fetch).
    expect(provider.getCounts()).toEqual({});
    // Let the fire-and-forget refresh settle, then repeated browse reads inside
    // the TTL must not spawn another refresh or any request.
    await provider.refreshNow();
    clock += 30_000;
    provider.getCounts();
    provider.getCounts();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getCounts()).toEqual({});
  });
});
