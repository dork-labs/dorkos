/**
 * Server-side npm registry check with in-memory cache.
 *
 * Key differences from CLI update check:
 * - In-memory cache only (no file I/O — server is long-running)
 * - 1-hour TTL (server stays running, should reflect updates sooner)
 * - 5-second timeout (server has more tolerance than CLI startup)
 *
 * @module services/update-checker
 */

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT = 5000; // 5 seconds

let cachedLatest: string | null = null;
let lastChecked = 0;

/**
 * Get the latest published version of dorkos from the npm registry.
 *
 * Returns from in-memory cache if within TTL. On fetch failure,
 * returns the stale cached value (or null if never fetched).
 *
 * @returns The latest version string, or null if unknown
 */
export async function getLatestVersion(): Promise<string | null> {
  if (Date.now() - lastChecked < CACHE_TTL) return cachedLatest;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch('https://registry.npmjs.org/dorkos/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return cachedLatest;
    const data = (await res.json()) as { version: string };
    cachedLatest = data.version;
    lastChecked = Date.now();
    return cachedLatest;
  } catch {
    return cachedLatest; // Return stale cache on error
  }
}

/**
 * Reset the in-memory cache. Useful for testing.
 *
 * @internal Exported for testing only.
 */
export function resetCache(): void {
  cachedLatest = null;
  lastChecked = 0;
}
