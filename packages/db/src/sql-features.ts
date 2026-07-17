import type { Db } from './index.js';

/**
 * Cached result of the percentile-support probe. `undefined` means "not
 * probed yet". This is a property of the linked better-sqlite3 binary (the
 * compiled SQLite amalgamation), not of any one database connection or
 * `:memory:` instance, so a single process-wide cache is correct — every
 * `Db` in this process shares the same native binary.
 */
let percentileSupportCache: boolean | undefined;

/**
 * Whether the linked better-sqlite3 binary was built with SQLite's
 * percentile extension (`percentile()`, `percentile_cont()`,
 * `percentile_disc()`, `median()`). Bundled starting in better-sqlite3
 * 12.10; absent in older binaries (DOR-166).
 *
 * Probes once per process with a throwaway query and caches the result, so
 * callers can feature-detect cheaply on every `getMetrics()`-style call
 * without crashing on a build that predates the extension — they should
 * branch on this and fall back to `NULL` percentile columns instead of
 * calling `percentile_cont()` directly.
 *
 * @param db - Any live `Db` instance (only used for the one-time probe).
 * @returns `true` if `percentile_cont()` is callable on this binary.
 */
export function hasPercentileSupport(db: Db): boolean {
  if (percentileSupportCache !== undefined) return percentileSupportCache;
  try {
    db.$client.prepare('SELECT percentile_cont(1, 0.5)').get();
    percentileSupportCache = true;
  } catch {
    percentileSupportCache = false;
  }
  return percentileSupportCache;
}

/**
 * Reset the in-memory percentile-support cache.
 *
 * @internal Exported for testing only.
 */
export function resetPercentileSupportCache(): void {
  percentileSupportCache = undefined;
}
