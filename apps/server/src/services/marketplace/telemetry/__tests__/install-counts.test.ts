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

  it('degrades to an empty map and never throws when the endpoint is unreachable (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider({ ttlMs: 60_000, fetchImpl });

    await expect(provider.refreshNow()).resolves.toBeUndefined();
    expect(provider.getCounts()).toEqual({});
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
