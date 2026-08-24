import { app, session } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import log from 'electron-log';

/**
 * Drop Chromium's HTTP cache once, whenever the app comes up on a new version.
 *
 * Chromium's disk cache is keyed by URL and knows nothing about which version
 * of DorkOS wrote an entry. The cockpit is served from `localhost` on a stable
 * port, so an update leaves the previous build's responses sitting in the cache
 * under exactly the URLs the new build asks for. The shell (`index.html`) names
 * the content-hashed bundles of the build that produced it; served from cache
 * after an update, it asks for files the new build never shipped and the window
 * comes up blank. This is a known Electron failure class — VS Code shipped the
 * same clear-on-version-change for it.
 *
 * The server now sends `no-store` on the shell, which prevents this at the
 * source for every future update. This is the second lock: it covers the caches
 * already poisoned by builds that shipped before that header existed, and the
 * caches that ignore it (an intercepting proxy, a corrupt cache entry).
 */

/** Where the last launched version is recorded, inside the app's userData dir. */
const VERSION_FILE_NAME = 'last-run-version.json';

/**
 * How long to wait for the cache clear before giving up on it.
 *
 * The first window is not created until this resolves, so an unbounded wait
 * would turn a `clearCache()` that never settles — an unresponsive network
 * service, a locked cache directory, the exact conditions this module exists
 * to survive — into an app that is a dock icon and nothing else. A clear that
 * has not finished in five seconds has gone wrong; opening the window with a
 * stale cache is strictly better than not opening one at all.
 *
 * Exported because it is the worst case this module can add to launch, which
 * makes it part of what a caller is agreeing to by awaiting.
 */
export const CLEAR_CACHE_TIMEOUT_MS = 5_000;

/** Shape of {@link VERSION_FILE_NAME}. */
interface LastRunVersion {
  version: string;
}

/**
 * The version recorded by the previous launch, or `null` when there is none —
 * a first launch, a hand-cleared userData dir, or a truncated write.
 *
 * @param filePath - Absolute path of the version file.
 */
function readLastRunVersion(filePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<LastRunVersion>;
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Clear the default session's cache, or reject once
 * {@link CLEAR_CACHE_TIMEOUT_MS} has passed.
 *
 * `clearCache()` is a promise with no deadline of its own: it can hang rather
 * than reject. Rejecting on the deadline routes a hang into the same handling
 * as a failure — logged, version left unrecorded, boot continues.
 */
async function clearCacheWithinDeadline(): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.defaultSession.clearCache(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`clearCache did not settle within ${CLEAR_CACHE_TIMEOUT_MS}ms`)),
          CLEAR_CACHE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    // The loser of the race is never settled, so its timer has to be released
    // by hand or it holds the event loop for the full timeout.
    clearTimeout(deadline);
  }
}

/**
 * Clear the HTTP cache if this is the first launch on the running version,
 * then record that version.
 *
 * A no-op on every relaunch of the same version, so the cost is one cache
 * clear per update — invisible against the download the update already did,
 * and paid at most once. The cache is cleared *before* the version is
 * recorded: if the clear fails, nothing is written and the next launch tries
 * again rather than assuming a clear that never happened.
 *
 * Every failure here is logged and swallowed, and the clear itself is bounded
 * by {@link CLEAR_CACHE_TIMEOUT_MS}, so this resolves within that deadline no
 * matter how badly the cache is behaving. Cache hygiene is a precaution; it
 * must never be the reason a person cannot open the app — and since the caller
 * holds the first window on this promise, "never" has to include hanging.
 *
 * Call it after the server is up and before the first window loads — a clear
 * racing a window that is already fetching would evict what that window just
 * stored.
 */
export async function clearHttpCacheOnVersionChange(): Promise<void> {
  try {
    const userDataPath = app.getPath('userData');
    const versionFile = join(userDataPath, VERSION_FILE_NAME);
    const currentVersion = app.getVersion();

    if (readLastRunVersion(versionFile) === currentVersion) return;

    await clearCacheWithinDeadline();
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(
      versionFile,
      JSON.stringify({ version: currentVersion } satisfies LastRunVersion)
    );
    log.info(`[cache] Cleared the web cache for version ${currentVersion}.`);
  } catch (err) {
    log.warn('[cache] Could not clear the web cache after a version change.', err);
  }
}
