import { app } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The app as it exists on disk, which is not always the app that is running.
 *
 * macOS installs by swapping a whole `.app` bundle, and DorkOS stays alive with
 * its window closed — so a person can drag a new version into place, or a
 * Squirrel install can land, while the old process keeps serving. Everything
 * here reads the bundle rather than the process, which is the only way to tell
 * the two apart.
 *
 * @module main/updater/app-bundle
 */

/** Where a macOS bundle keeps the property list naming its version. */
const INFO_PLIST_PATH = ['Contents', 'Info.plist'];

/**
 * The marketing version inside an XML `Info.plist`.
 *
 * A deliberate regex rather than a plist parser: the main process ships no
 * plist dependency, this is one well-known key, and the failure mode of not
 * matching is the right one — see {@link readBundlePlist}.
 */
const BUNDLE_VERSION_PATTERN = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;

/** The bundle identifier inside an XML `Info.plist` — what Squirrel names its state directory after. */
const BUNDLE_IDENTIFIER_PATTERN = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/;

/**
 * The last plist read, keyed by the file's identity on disk.
 *
 * {@link installedBundleVersion} is called on every window focus, and a person
 * switching apps produces a lot of those. The plist is re-read only when the
 * file it came from has actually changed — which is exactly what installing a
 * new copy does, so nothing is missed by not re-reading otherwise.
 */
let plistCache: {
  path: string;
  stamp: string;
  version: string | null;
  identifier: string | null;
} | null = null;

/**
 * The macOS `.app` bundle that `exePath` lives inside, or `null` off macOS and
 * for a loose executable.
 *
 * @param exePath - Absolute path of the running executable.
 */
export function findAppBundle(exePath: string): string | null {
  let current = exePath;
  while (current !== dirname(current)) {
    current = dirname(current);
    if (current.endsWith('.app')) return current;
  }
  return null;
}

/**
 * What a bundle's `Info.plist` says about itself, or nulls when it cannot be
 * read.
 *
 * `null` for anything unexpected — a missing file, an unreadable one, a plist
 * saved in the binary format — because the callers are deciding whether to
 * interrupt someone and whether to delete a directory. Saying nothing is always
 * available and always safe; guessing is neither.
 *
 * Cached against the plist's size and modification time, so the common case (a
 * window focused again, nothing installed since) is a `stat` rather than a read
 * and a regex.
 *
 * @param bundlePath - Absolute path of the `.app` bundle.
 */
function readBundlePlist(bundlePath: string): {
  version: string | null;
  identifier: string | null;
} {
  const plistPath = join(bundlePath, ...INFO_PLIST_PATH);
  try {
    const { mtimeMs, size } = statSync(plistPath);
    const stamp = `${mtimeMs}:${size}`;
    if (plistCache?.path === plistPath && plistCache.stamp === stamp) return plistCache;

    const plist = readFileSync(plistPath, 'utf8');
    const parsed = {
      version: BUNDLE_VERSION_PATTERN.exec(plist)?.[1]?.trim() ?? null,
      identifier: BUNDLE_IDENTIFIER_PATTERN.exec(plist)?.[1]?.trim() ?? null,
    };
    plistCache = { path: plistPath, stamp, ...parsed };
    return parsed;
  } catch {
    return { version: null, identifier: null };
  }
}

/**
 * Forget the cached `Info.plist`.
 *
 * @internal Exported for testing only.
 */
export function resetAppBundleCache(): void {
  plistCache = null;
}

/** The bundle this process was launched from, or `null` off macOS and for a loose executable. */
function runningBundle(): string | null {
  if (process.platform !== 'darwin') return null;
  return findAppBundle(app.getPath('exe'));
}

/**
 * The version of the app bundle this process was launched from, as it stands on
 * disk **right now** — which is what a manual overwrite install changes and
 * `app.getVersion()` does not.
 *
 * `null` off macOS, where there is no bundle to read, and `null` whenever the
 * plist cannot be read (see {@link readBundleVersion}).
 */
export function installedBundleVersion(): string | null {
  const bundle = runningBundle();
  return bundle === null ? null : readBundlePlist(bundle).version;
}

/**
 * The bundle identifier of the app this process was launched from — the name
 * Squirrel.Mac builds its cache directory out of.
 *
 * Read from the bundle rather than written down here, so it cannot drift from
 * `electron-builder.yml`'s `appId`, and `null` rather than a default whenever
 * it cannot be read: its one caller uses it to decide what to DELETE from a
 * cache root shared with every other app on the machine.
 */
export function installedBundleIdentifier(): string | null {
  const bundle = runningBundle();
  return bundle === null ? null : readBundlePlist(bundle).identifier;
}
