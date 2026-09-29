import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

import {
  UpdatedAtProvider,
  enrichWithUpdatedAt,
  type UpdatedAtMap,
  type UpdatedAtProviderOptions,
} from '../updated-at.js';

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

function updatedAtResponse(updatedAt: UpdatedAtMap): Response {
  return new Response(JSON.stringify({ updatedAt }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE_URL = 'https://dorkos.test';
const UPDATED_AT_URL = `${BASE_URL}/api/telemetry/updated-at`;

const FLOW_DATE = '2026-07-18T17:41:20Z';

// ---------------------------------------------------------------------------
// enrichWithUpdatedAt
// ---------------------------------------------------------------------------

describe('enrichWithUpdatedAt', () => {
  it('stamps community packages that carry a date, leaving undated ones absent', () => {
    const packages = [pkg({ name: 'flow' }), pkg({ name: 'lifeos-starter' })];
    const result = enrichWithUpdatedAt(packages, { flow: FLOW_DATE });

    expect(result.map((p) => [p.name, p.updatedAt])).toEqual([
      ['flow', FLOW_DATE],
      // lifeos-starter has no registry date (external source), so it stays absent.
      ['lifeos-starter', undefined],
    ]);
  });

  it('returns the packages unchanged (no updatedAt) when dates are empty', () => {
    const packages = [pkg({ name: 'flow' })];
    const result = enrichWithUpdatedAt(packages, {});

    expect(result[0].updatedAt).toBeUndefined();
    expect(result).toEqual(packages);
  });

  it('does not mutate the input packages', () => {
    const packages = [pkg({ name: 'flow' })];
    enrichWithUpdatedAt(packages, { flow: FLOW_DATE });
    expect(packages[0].updatedAt).toBeUndefined();
  });

  it('only stamps community packages — a same-named package in another marketplace stays un-enriched', () => {
    // The date map is scoped to dorkos-community, so a name collision in a
    // second marketplace must NOT borrow community recency.
    const community = pkg({ name: 'flow', marketplace: 'dorkos-community' });
    const otherMarket = pkg({ name: 'flow', marketplace: 'acme-internal' });

    const result = enrichWithUpdatedAt([community, otherMarket], { flow: FLOW_DATE });

    expect(result[0]).toMatchObject({ marketplace: 'dorkos-community', updatedAt: FLOW_DATE });
    expect(result[1]).toMatchObject({ marketplace: 'acme-internal' });
    expect(result[1].updatedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UpdatedAtProvider — cache miss / hit / offline degrade
// ---------------------------------------------------------------------------

describe('UpdatedAtProvider', () => {
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
  function makeProvider(options: UpdatedAtProviderOptions = {}): UpdatedAtProvider {
    return new UpdatedAtProvider({ baseUrl: BASE_URL, now, telemetryEnv: {}, ...options });
  }

  it('returns an empty map on a cold start and kicks off a background refresh (cache miss)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(updatedAtResponse({ flow: FLOW_DATE }));
    const provider = makeProvider({ fetchImpl });

    // First (cold) read: no data yet, but the refresh was triggered.
    expect(provider.getUpdatedAt()).toEqual({});
    expect(fetchImpl).toHaveBeenCalledWith(
      UPDATED_AT_URL,
      expect.objectContaining({ signal: expect.anything() })
    );

    // Let the in-flight refresh settle, then the next read serves the dates.
    await vi.waitFor(() => expect(provider.getUpdatedAt()).toEqual({ flow: FLOW_DATE }));
  });

  it('serves cached dates without re-fetching inside the TTL window (cache hit)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(updatedAtResponse({ flow: FLOW_DATE }));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance less than the TTL — still fresh, so no second network call.
    clock += 30_000;
    expect(provider.getUpdatedAt()).toEqual({ flow: FLOW_DATE });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Cross the TTL — the next read triggers exactly one background refresh.
    clock += 31_000;
    provider.getUpdatedAt();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it('degrades to an empty map and never throws when the endpoint is unreachable (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await expect(provider.refreshNow()).resolves.toBeUndefined();
    expect(provider.getUpdatedAt()).toEqual({});
  });

  it('throttles retries after a failure to at most one per TTL', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Within the TTL, repeated browse reads must not hammer the failing host.
    clock += 30_000;
    provider.getUpdatedAt();
    provider.getUpdatedAt();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the last-known dates when a later refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(updatedAtResponse({ flow: FLOW_DATE }))
      .mockRejectedValueOnce(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await provider.refreshNow();
    expect(provider.getUpdatedAt()).toEqual({ flow: FLOW_DATE });

    clock += 61_000;
    await provider.refreshNow();
    // The failed refresh preserved the previous dates rather than clearing them.
    expect(provider.getUpdatedAt()).toEqual({ flow: FLOW_DATE });
  });

  it('ignores a non-OK response body and leaves dates unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const provider = makeProvider({ fetchImpl });

    await provider.refreshNow();
    expect(provider.getUpdatedAt()).toEqual({});
  });

  it('drops non-string dates so a malformed body cannot poison the comparator', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          updatedAt: { flow: FLOW_DATE, bad: 42, empty: '', nullish: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const provider = makeProvider({ fetchImpl });

    await provider.refreshNow();
    // Only the non-empty string entry survives.
    expect(provider.getUpdatedAt()).toEqual({ flow: FLOW_DATE });
  });

  it('strips trailing slashes from the base URL so the request path never doubles up', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(updatedAtResponse({ flow: FLOW_DATE }));
    const provider = makeProvider({ baseUrl: `${BASE_URL}///`, fetchImpl });

    await provider.refreshNow();
    expect(fetchImpl).toHaveBeenCalledWith(UPDATED_AT_URL, expect.anything());
  });

  it('never fires a request when a telemetry kill switch is set (consent gate)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(updatedAtResponse({ flow: FLOW_DATE }));
    const provider = makeProvider({ fetchImpl, telemetryEnv: { DO_NOT_TRACK: '1' } });

    await provider.refreshNow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getUpdatedAt()).toEqual({});
  });

  it('honors DORKOS_TELEMETRY_DISABLED as well, and stays throttled so it does not spin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(updatedAtResponse({ flow: FLOW_DATE }));
    const provider = makeProvider({
      ttlMs: 60_000,
      fetchImpl,
      telemetryEnv: { DORKOS_TELEMETRY_DISABLED: 'true' },
    });

    // Cold read triggers a background refresh that returns early (no fetch).
    expect(provider.getUpdatedAt()).toEqual({});
    // Let the fire-and-forget refresh settle, then repeated browse reads inside
    // the TTL must not spawn another refresh or any request.
    await provider.refreshNow();
    clock += 30_000;
    provider.getUpdatedAt();
    provider.getUpdatedAt();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getUpdatedAt()).toEqual({});
  });
});
