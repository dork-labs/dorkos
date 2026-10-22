/**
 * Server-side npm registry check with in-memory cache.
 *
 * Key differences from CLI update check:
 * - In-memory cache only (no file I/O — server is long-running)
 * - 1-hour TTL (server stays running, should reflect updates sooner)
 * - 5-second timeout (server has more tolerance than CLI startup)
 *
 * **Nobody waits on npm** (DOR-3226). `GET /api/config` and `check_update`
 * both read this, and opening the app used to wait up to five seconds on the
 * registry: on the first load after start, after each hour, and on EVERY load
 * while the network was slow or down, because a failed check was not recorded.
 * Now a read answers from the cache at once and refreshes it in the
 * background (stale-while-revalidate), one refresh at a time, and a failed
 * refresh waits {@link FAILURE_BACKOFF} before the next try.
 *
 * @module services/update-checker
 */

import { env } from '../../env.js';
import { IS_DEV_BUILD } from '../../lib/version.js';
import { currentServerRole } from '../../lib/server-role.js';

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
/** How long a failed or timed-out check waits before the next one. */
const FAILURE_BACKOFF = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT = 5000; // 5 seconds
/**
 * A version the registry may answer: `MAJOR.MINOR.PATCH`, with an optional
 * pre-release and build, and nothing else. The answer is shown to a person and
 * compared against the running version, so anything else is not believed.
 */
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** The longest version string believed. */
const MAX_VERSION_LENGTH = 64;

let cachedLatest: string | null = null;
/** When the next refresh is due, epoch ms. `0` means now. */
let nextCheckAt = 0;
/** The refresh in flight, so a second read never starts another. */
let refreshing: Promise<void> | null = null;

/**
 * Whether this server may ask the registry at all.
 *
 * A dev build never phones home. A hub never updates itself: DorkOS Cloud
 * upgrades hubs in waves, so an "update available" there would ask a person
 * to do something they cannot. `DORKOS_UPDATE_CHECK_DISABLED` is how a test
 * server (the contract harness) stays off the network.
 */
function checksRegistry(): boolean {
  if (IS_DEV_BUILD) return false;
  if (currentServerRole() === 'hub') return false;
  return !isSwitchOn(env.DORKOS_UPDATE_CHECK_DISABLED);
}

/**
 * Whether an env switch is set: `1` or `true`.
 *
 * @param value - The raw variable.
 */
function isSwitchOn(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** Ask the registry once, and record the answer or the failure. */
async function refresh(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch('https://registry.npmjs.org/dorkos/latest', {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const { version } = (await res.json()) as { version?: unknown };
    // An answer that is not a version is a failed check, with the same back-off.
    if (
      typeof version !== 'string' ||
      version.length > MAX_VERSION_LENGTH ||
      !VERSION_PATTERN.test(version)
    )
      throw new Error('registry answered no version');
    cachedLatest = version;
    nextCheckAt = Date.now() + CACHE_TTL;
  } catch {
    // Keep the last answer, and do not ask again on every read while the
    // network is down.
    nextCheckAt = Date.now() + FAILURE_BACKOFF;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get the latest published version of dorkos from the npm registry.
 *
 * Answers from the in-memory cache at once, and starts a background refresh
 * when the cache is due. So the first read after start answers `null`, and the
 * reads after the refresh lands answer the version.
 *
 * @returns The latest version string, or null if unknown
 */
export async function getLatestVersion(): Promise<string | null> {
  if (!checksRegistry()) return null;
  if (refreshing === null && Date.now() >= nextCheckAt) {
    refreshing = refresh().finally(() => {
      refreshing = null;
    });
  }
  return cachedLatest;
}

/**
 * Wait for the refresh in flight, if any. Useful for testing.
 *
 * @internal Exported for testing only.
 */
export async function settleRefresh(): Promise<void> {
  await refreshing;
}

/**
 * Reset the in-memory cache. Useful for testing.
 *
 * @internal Exported for testing only.
 */
export function resetCache(): void {
  cachedLatest = null;
  nextCheckAt = 0;
  refreshing = null;
}
