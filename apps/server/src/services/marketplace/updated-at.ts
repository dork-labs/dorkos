/**
 * Community registry-recency provider — enriches aggregated marketplace
 * packages with the last time each package's files changed in the
 * `dork-labs/marketplace` registry, read from the public dorkos.ai endpoint
 * (`GET /api/telemetry/updated-at`).
 *
 * The browse path must never block on this network call, so the provider keeps
 * a short-lived in-memory cache and refreshes it in the background
 * (stale-while-revalidate): {@link UpdatedAtProvider.getUpdatedAt} returns
 * synchronously with whatever is cached (empty on a cold start) and kicks off
 * an async refresh only when the cache is stale. When dorkos.ai is unreachable
 * the cache stays empty and the dates simply stay absent — the marketplace
 * works fully offline, and the client hides the Recent sort.
 *
 * Consent: the refresh is an outbound call to dorkos.ai, so — even though it is
 * public, read-only, and sends no payload — it honors the same environment kill
 * switches as every other outbound channel (`DO_NOT_TRACK` /
 * `DORKOS_TELEMETRY_DISABLED`, via `@dorkos/shared/telemetry-consent`). The
 * telemetry contract is "every outbound channel off", not "every channel that
 * sends data off", so a self-hoster who set the kill switch gets no request at
 * all; dates stay absent and Recent stays grayed via the existing degrade.
 *
 * Mirrors {@link InstallCountsProvider} one channel over — the same cache,
 * consent gate, and community scoping.
 *
 * @module services/marketplace/updated-at
 */

import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { isTelemetryDisabledByEnv, type TelemetryEnv } from '@dorkos/shared/telemetry-consent';

import { env } from '../../env.js';

/** Path of the public read endpoint on the dorkos.ai site. */
const UPDATED_AT_PATH = '/api/telemetry/updated-at';

/** Default cache lifetime — one refresh at most every 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60_000;

/** Bound on the background fetch so an unreachable host can't leak a hung request. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Name of the community marketplace source. Only packages from this source are
 * stamped with a date: the site endpoint scopes to this same marketplace, so a
 * same-named package in a *different* source must not borrow community recency.
 * Mirrors the default source seeded by `marketplace-source-manager.ts`
 * (`buildDefaultSources`), which is the identity carried on
 * `AggregatedPackage.marketplace`.
 */
const COMMUNITY_MARKETPLACE_NAME = 'dorkos-community';

/** Map of package name to the ISO 8601 date of its last registry commit. */
export type UpdatedAtMap = Record<string, string>;

/** Wire shape of the `GET /api/telemetry/updated-at` response body. */
interface UpdatedAtResponse {
  updatedAt: UpdatedAtMap;
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
export interface UpdatedAtProviderOptions {
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
 * Caches community registry-recency dates with stale-while-revalidate semantics.
 *
 * Refreshes never throw and never block a caller: a failed refresh keeps the
 * last-known dates (or none) and is retried no sooner than one TTL later.
 */
export class UpdatedAtProvider {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly telemetryEnv: TelemetryEnv;

  private updatedAt: UpdatedAtMap = {};
  /** Timestamp of the last refresh *attempt* (success or failure), 0 = never. */
  private attemptedAt = 0;
  private inflight: Promise<void> | null = null;

  /**
   * Build a provider, defaulting to the real site, a 15-minute TTL, global
   * `fetch`, and the server's telemetry kill-switch env.
   *
   * @param options - Base URL, TTL, kill-switch env, and injectable fetch/clock
   *   (see {@link UpdatedAtProviderOptions}).
   */
  constructor(options: UpdatedAtProviderOptions = {}) {
    // Strip trailing slashes so `baseUrl + UPDATED_AT_PATH` never doubles up
    // (mirrors cloud-link-client.ts).
    this.baseUrl = (options.baseUrl ?? env.DORKOS_CLOUD_URL).replace(/\/+$/, '');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.telemetryEnv = options.telemetryEnv ?? defaultTelemetryEnv();
  }

  /**
   * Return the currently-cached dates, triggering a background refresh when the
   * cache is stale. Never awaits the network — safe to call on the hot browse
   * path. The returned map is empty on a cold start (and stays empty while
   * dorkos.ai is unreachable or a kill switch is set).
   */
  getUpdatedAt(): UpdatedAtMap {
    if (this.isStale() && !this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.updatedAt;
  }

  /**
   * Await a refresh immediately, bypassing the staleness gate. Test/warm-up
   * helper — the browse path uses {@link getUpdatedAt} instead.
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
      // to dorkos.ai ever fires and dates stay absent.
      if (isTelemetryDisabledByEnv(this.telemetryEnv)) return;
      const res = await this.fetchImpl(`${this.baseUrl}${UPDATED_AT_PATH}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as UpdatedAtResponse;
      if (body && typeof body.updatedAt === 'object' && body.updatedAt !== null) {
        this.updatedAt = sanitizeUpdatedAt(body.updatedAt);
      }
    } catch {
      // Offline or endpoint down: keep the last-known dates (or none) so the
      // Recent sort degrades cleanly. Never throw into the browse path.
    } finally {
      // Stamp every attempt so a failure (or a kill-switched skip) is retried no
      // sooner than one TTL later, rather than on every browse request.
      this.attemptedAt = this.now();
    }
  }
}

/**
 * Keep only non-empty string dates from a decoded response body, so a malformed
 * or hostile payload (a number, `null`, an empty string) can never poison the
 * comparator.
 *
 * @param raw - The `updatedAt` object straight off the decoded JSON body.
 */
function sanitizeUpdatedAt(raw: UpdatedAtMap): UpdatedAtMap {
  const clean: UpdatedAtMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) clean[name] = value;
  }
  return clean;
}

/** Process-wide provider used by the marketplace browse route. */
export const updatedAtProvider = new UpdatedAtProvider();

/**
 * Return a copy of `packages` enriched with community registry-recency dates.
 *
 * Only packages from the community marketplace ({@link COMMUNITY_MARKETPLACE_NAME})
 * that carry a date in the map are stamped — the map is scoped to that source
 * and only ever contains packages the registry actually records, so a same-named
 * package in another marketplace and a package sourced from outside the registry
 * repo both stay un-enriched (and sort last under Recent). When dates are absent
 * — a cold cache or an unreachable dorkos.ai, signalled by an empty map — the
 * packages are returned unchanged so Recent stays hidden.
 *
 * @param packages - Aggregated packages from every enabled marketplace.
 * @param updatedAt - The date map from {@link UpdatedAtProvider.getUpdatedAt}.
 */
export function enrichWithUpdatedAt(
  packages: AggregatedPackage[],
  updatedAt: UpdatedAtMap
): AggregatedPackage[] {
  if (Object.keys(updatedAt).length === 0) return packages;
  return packages.map((pkg) => {
    if (pkg.marketplace !== COMMUNITY_MARKETPLACE_NAME) return pkg;
    const date = updatedAt[pkg.name];
    return date === undefined ? pkg : { ...pkg, updatedAt: date };
  });
}
