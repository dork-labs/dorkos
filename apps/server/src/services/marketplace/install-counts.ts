/**
 * Community install-count provider — enriches aggregated marketplace packages
 * with real install counts read from the public dorkos.ai endpoint
 * (`GET /api/telemetry/install-counts`).
 *
 * The browse path must never block on this network call, so the provider keeps
 * a short-lived in-memory cache and refreshes it in the background
 * (stale-while-revalidate): {@link InstallCountsProvider.getCounts} returns
 * synchronously with whatever is cached (empty on a cold start) and kicks off
 * an async refresh only when the cache is stale. When dorkos.ai is unreachable
 * the cache stays empty and the counts simply stay absent — the marketplace
 * works fully offline, and the client hides the Popular sort.
 *
 * @module services/marketplace/install-counts
 */

import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

import { env } from '../../env.js';

/** Path of the public read endpoint on the dorkos.ai site. */
const COUNTS_PATH = '/api/telemetry/install-counts';

/** Default cache lifetime — one refresh at most every 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60_000;

/** Bound on the background fetch so an unreachable host can't leak a hung request. */
const FETCH_TIMEOUT_MS = 5_000;

/** Map of package name to total successful community install count. */
export type InstallCountMap = Record<string, number>;

/** Wire shape of the `GET /api/telemetry/install-counts` response body. */
interface InstallCountsResponse {
  counts: InstallCountMap;
}

/** Construction options — all optional; the defaults target the real site. */
export interface InstallCountsProviderOptions {
  /** Base URL of the site (defaults to `env.DORKOS_CLOUD_URL`). */
  baseUrl?: string;
  /** Cache lifetime in milliseconds (defaults to 15 minutes). */
  ttlMs?: number;
  /** Fetch implementation (injectable for tests; defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Clock (injectable for tests; defaults to `Date.now`). */
  now?: () => number;
}

/**
 * Caches community install counts with stale-while-revalidate semantics.
 *
 * Refreshes never throw and never block a caller: a failed refresh keeps the
 * last-known counts (or none) and is retried no sooner than one TTL later.
 */
export class InstallCountsProvider {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private counts: InstallCountMap = {};
  /** Timestamp of the last refresh *attempt* (success or failure), 0 = never. */
  private attemptedAt = 0;
  private inflight: Promise<void> | null = null;

  /**
   * @param options - Base URL, TTL, and injectable fetch/clock (see
   *   {@link InstallCountsProviderOptions}).
   */
  constructor(options: InstallCountsProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? env.DORKOS_CLOUD_URL;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Return the currently-cached counts, triggering a background refresh when
   * the cache is stale. Never awaits the network — safe to call on the hot
   * browse path. The returned map is empty on a cold start (and stays empty
   * while dorkos.ai is unreachable).
   */
  getCounts(): InstallCountMap {
    if (this.isStale() && !this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.counts;
  }

  /**
   * Await a refresh immediately, bypassing the staleness gate. Test/warm-up
   * helper — the browse path uses {@link getCounts} instead.
   */
  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private isStale(): boolean {
    return this.now() - this.attemptedAt >= this.ttlMs;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${COUNTS_PATH}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as InstallCountsResponse;
      if (body && typeof body.counts === 'object' && body.counts !== null) {
        this.counts = body.counts;
      }
    } catch {
      // Offline or endpoint down: keep the last-known counts (or none) so the
      // Popular sort degrades cleanly. Never throw into the browse path.
    } finally {
      // Stamp every attempt so a failure is retried no sooner than one TTL
      // later, rather than on every browse request.
      this.attemptedAt = this.now();
    }
  }
}

/** Process-wide provider used by the marketplace browse route. */
export const installCountsProvider = new InstallCountsProvider();

/**
 * Return a copy of `packages` enriched with community install counts.
 *
 * When counts are available every package gets an `installCount` (`0` when it
 * has no recorded installs) so the client can offer the Popular sort. When
 * counts are absent — a cold cache or an unreachable dorkos.ai, signalled by an
 * empty map — the packages are returned unchanged so Popular stays hidden.
 *
 * @param packages - Aggregated packages from every enabled marketplace.
 * @param counts - The count map from {@link InstallCountsProvider.getCounts}.
 */
export function enrichWithInstallCounts(
  packages: AggregatedPackage[],
  counts: InstallCountMap
): AggregatedPackage[] {
  if (Object.keys(counts).length === 0) return packages;
  return packages.map((pkg) => ({ ...pkg, installCount: counts[pkg.name] ?? 0 }));
}
