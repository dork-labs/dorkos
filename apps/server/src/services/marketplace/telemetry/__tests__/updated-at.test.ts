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

  it('degrades to an empty map and never throws when the endpoint is unreachable (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await expect(provider.refreshNow()).resolves.toBeUndefined();
    expect(provider.getUpdatedAt()).toEqual({});
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
