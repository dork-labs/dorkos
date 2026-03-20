// packages/cli/src/update-check.ts

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT = 3000; // 3 seconds

/** Lazily resolve cache path so process.env.DORK_HOME (set by cli.ts) is available. */
function getCachePath(): string {
  // eslint-disable-next-line no-restricted-syntax -- DORK_HOME is set imperatively by cli.ts after module load; env.ts is parsed too early
  const home = process.env.DORK_HOME || join(homedir(), '.dork');
  return join(home, 'cache', 'update-check.json');
}

/**
 * Check the npm registry for a newer version of dorkos.
 *
 * @param currentVersion - The currently running version string (e.g., "0.1.0")
 * @returns The latest version string if newer than current, or null
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  // 1. Check cache
  try {
    const raw = await readFile(getCachePath(), 'utf-8');
    const cache: UpdateCache = JSON.parse(raw);
    if (Date.now() - cache.checkedAt < CACHE_TTL) {
      return isNewer(cache.latestVersion, currentVersion) ? cache.latestVersion : null;
    }
  } catch {
    // Cache miss or corrupt — proceed to fetch
  }

  // 2. Fetch from npm registry (with timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch('https://registry.npmjs.org/dorkos/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };

    // 3. Write cache
    const cachePath = getCachePath();
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        latestVersion: data.version,
        checkedAt: Date.now(),
      })
    );

    return isNewer(data.version, currentVersion) ? data.version : null;
  } catch {
    return null; // Network error, timeout, etc. — silently fail
  }
}

/**
 * Returns true if version `a` is newer than version `b` (simple semver comparison).
 *
 * @internal Exported for testing only.
 */
export function isNewer(a: string, b: string): boolean {
  // Strip pre-release suffixes (e.g. "1.0.0-beta.1" -> "1.0.0")
  const [aMaj, aMin, aPat] = a.split('-')[0].split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('-')[0].split('.').map(Number);
  if ([aMaj, aMin, aPat, bMaj, bMin, bPat].some(isNaN)) return false;
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
