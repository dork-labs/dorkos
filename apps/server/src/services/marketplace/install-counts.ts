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
 * Consent: the refresh is an outbound call to dorkos.ai, so — even though it is
 * public, read-only, and sends no payload — it honors the same environment kill
 * switches as every other outbound channel (`DO_NOT_TRACK` /
 * `DORKOS_TELEMETRY_DISABLED`, via `@dorkos/shared/telemetry-consent`). The
 * telemetry contract is "every outbound channel off", not "every channel that
 * sends data off", so a self-hoster who set the kill switch gets no request at
 * all; counts stay absent and Popular stays grayed via the existing degrade.
 *
 * @module services/marketplace/install-counts
 */

import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { isTelemetryDisabledByEnv, type TelemetryEnv } from '@dorkos/shared/telemetry-consent';

import { env } from '../../env.js';

/** Path of the public read endpoint on the dorkos.ai site. */
const COUNTS_PATH = '/api/telemetry/install-counts';

/** Default cache lifetime — one refresh at most every 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60_000;

/** Bound on the background fetch so an unreachable host can't leak a hung request. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Name of the community marketplace source. Only packages from this source are
 * stamped with a count: the site query (`fetchInstallCounts`) filters to this
 * same marketplace, so a same-named package in a *different* source must not
 * borrow community popularity. Mirrors the default source seeded by
 * `marketplace-source-manager.ts` (`buildDefaultSources`), which is the identity
 * carried on `AggregatedPackage.marketplace`.
 */
const COMMUNITY_MARKETPLACE_NAME = 'dorkos-community';

/** Map of package name to total successful community install count. */
export type InstallCountMap = Record<string, number>;

/** Wire shape of the `GET /api/telemetry/install-counts` response body. */
interface InstallCountsResponse {
  counts: InstallCountMap;
}

/**
 * The kill-switch view the provider consults each refresh. Built from the
 * server's parsed `env` so it agrees with every other outbound channel.
 */
function defaultTelemetryEnv(): TelemetryEnv {
  return {
    DO_NOT_TRACK: env.DO_NOT_TRACK,
    DORKOS_TELEMETRY_DISABLED: env.DORKOS_TELEMETRY_DISABLED,
  };
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
  /** Telemetry kill-switch env (injectable for tests; defaults to the server env). */
  telemetryEnv?: TelemetryEnv;
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
  private readonly telemetryEnv: TelemetryEnv;

  private counts: InstallCountMap = {};
  /** Timestamp of the last refresh *attempt* (success or failure), 0 = never. */
  private attemptedAt = 0;
  private inflight: Promise<void> | null = null;

  /**
   * Build a provider, defaulting to the real site, a 15-minute TTL, global
   * `fetch`, and the server's telemetry kill-switch env.
   *
   * @param options - Base URL, TTL, kill-switch env, and injectable fetch/clock
   *   (see {@link InstallCountsProviderOptions}).
   */
  constructor(options: InstallCountsProviderOptions = {}) {
    // Strip trailing slashes so `baseUrl + COUNTS_PATH` never doubles up
    // (mirrors cloud-link-client.ts).
    this.baseUrl = (options.baseUrl ?? env.DORKOS_CLOUD_URL).replace(/\/+$/, '');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.telemetryEnv = options.telemetryEnv ?? defaultTelemetryEnv();
  }

  /**
   * Return the currently-cached counts, triggering a background refresh when
   * the cache is stale. Never awaits the network — safe to call on the hot
   * browse path. The returned map is empty on a cold start (and stays empty
   * while dorkos.ai is unreachable or a kill switch is set).
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
      // Honor the universal kill switches: with either set, no outbound request
      // to dorkos.ai ever fires and counts stay absent.
      if (isTelemetryDisabledByEnv(this.telemetryEnv)) return;
      const res = await this.fetchImpl(`${this.baseUrl}${COUNTS_PATH}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as InstallCountsResponse;
      if (body && typeof body.counts === 'object' && body.counts !== null) {
        this.counts = sanitizeCounts(body.counts);
      }
    } catch {
      // Offline or endpoint down: keep the last-known counts (or none) so the
      // Popular sort degrades cleanly. Never throw into the browse path.
    } finally {
      // Stamp every attempt so a failure (or a kill-switched skip) is retried no
      // sooner than one TTL later, rather than on every browse request.
      this.attemptedAt = this.now();
    }
  }
}

/**
 * Keep only finite numeric counts from a decoded response body, so a malformed
 * or hostile payload (a string, `null`, `NaN`) can never poison the comparator.
 *
 * @param raw - The `counts` object straight off the decoded JSON body.
 */
function sanitizeCounts(raw: InstallCountMap): InstallCountMap {
  const clean: InstallCountMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value;
  }
  return clean;
}

/** Process-wide provider used by the marketplace browse route. */
export const installCountsProvider = new InstallCountsProvider();

/**
 * Return a copy of `packages` enriched with community install counts.
 *
 * Only packages from the community marketplace ({@link COMMUNITY_MARKETPLACE_NAME})
 * are stamped — the count map is scoped to that source, so a same-named package
 * in another marketplace must not inherit its popularity. A community package
 * gets an `installCount` (`0` when it has no recorded installs) so the client
 * can offer the Popular sort. When counts are absent — a cold cache or an
 * unreachable dorkos.ai, signalled by an empty map — the packages are returned
 * unchanged so Popular stays hidden.
 *
 * @param packages - Aggregated packages from every enabled marketplace.
 * @param counts - The count map from {@link InstallCountsProvider.getCounts}.
 */
export function enrichWithInstallCounts(
  packages: AggregatedPackage[],
  counts: InstallCountMap
): AggregatedPackage[] {
  if (Object.keys(counts).length === 0) return packages;
  return packages.map((pkg) =>
    pkg.marketplace === COMMUNITY_MARKETPLACE_NAME
      ? { ...pkg, installCount: counts[pkg.name] ?? 0 }
      : pkg
  );
}
