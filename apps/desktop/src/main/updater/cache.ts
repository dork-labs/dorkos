import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { installedBundleIdentifier } from './app-bundle';
import { isAtLeastVersion, isNewerVersion } from '../updater-intent';

/**
 * Where the update machinery keeps its state on disk, and how a launch clears
 * out what has gone stale.
 *
 * Two directories matter, both hidden in the OS cache root: electron-updater's
 * download cache (`<name>-updater/pending/`), which holds the artifact it means
 * to install next, and Squirrel's own state directory (`<appId>.ShipIt/`),
 * which holds the copy it unpacked from that artifact plus the plist recording
 * what it was told to do.
 *
 * Neither is cleaned up by anything when an install lands another way. A person
 * whose updater had been failing for ten days ended up with 0.63.0 staged in
 * BOTH places while already running 0.63.0 — so the next ordinary quit would
 * hand Squirrel a copy of what she already had, and after a manual overwrite
 * install it would have handed her a downgrade.
 *
 * **The cache root is shared with every other app on the machine**, and both
 * naming conventions here are conventions, not namespaces: `~/Library/Caches`
 * holds a `.ShipIt` directory for every Squirrel app installed and a
 * `-updater` directory for every electron-updater app. So the delete path
 * resolves OUR two directories by identity — the bundle id out of our own
 * `Info.plist`, and `updaterCacheDirName` out of the `app-update.yml`
 * electron-builder shipped in our resources — and refuses to delete anything at
 * all when either answer is missing. {@link findCacheDirs}'s tolerant
 * suffix matching is for the diagnostic report, which only ever LISTS.
 *
 * @module main/updater/cache
 */

/** Suffix Squirrel.Mac gives its per-app state directory in the user cache. */
export const SHIPIT_DIR_SUFFIX = '.ShipIt';

/** Suffix electron-updater gives its download cache in the user cache. */
export const UPDATER_DIR_SUFFIX = '-updater';

/** The file inside a Squirrel state directory that says how the last install went. */
export const SHIPIT_STATE_FILE = 'ShipItState.plist';

/** The updater cache subdirectory holding the artifact staged for the next install. */
const PENDING_DIR = 'pending';

/** What electron-updater writes beside the staged artifact to describe it. */
const UPDATE_INFO_FILE = 'update-info.json';

/** Prefix Squirrel.Mac gives each directory it unpacks an update into. */
const SHIPIT_UPDATE_DIR_PREFIX = 'update.';

/** The config electron-builder ships in the app's resources, naming the updater's cache directory. */
const APP_UPDATE_CONFIG = 'app-update.yml';

/** The key in {@link APP_UPDATE_CONFIG} holding that directory's name. */
const CACHE_DIR_NAME_KEY = 'updaterCacheDirName';

/**
 * A whole `-` or `_` delimited segment that is exactly `MAJOR.MINOR.PATCH`.
 *
 * **Deliberately only the numeric core.** An artifact is named
 * `DorkOS-0.65.0-arm64-mac.zip`, and a pattern that also accepted a semver
 * prerelease suffix could not tell `-rc.1` from `-arm64-mac.zip`: it read the
 * release build `DorkOS-0.66.0-arm64-mac.zip` as "0.66.0 prerelease
 * arm64-mac.zip", which an app running `0.66.0-rc.1` then outranks — so an rc
 * build would delete the finished release it was waiting for, on every launch,
 * for ever.
 *
 * Reading the core alone cannot make that mistake, and its failure direction is
 * the safe one: a staged `X-rc.1` reads as `X`, which is newer than it really
 * is, so at worst a prerelease artifact is KEPT when it could have been
 * dropped. Nothing strictly newer than the running version is ever deleted.
 */
const VERSION_SEGMENT_PATTERN = /^v?(\d+\.\d+\.\d+)$/;

/**
 * The directory the OS keeps per-app caches in — where Squirrel's install state
 * and electron-updater's downloads both live.
 *
 * Derived from the home directory rather than asked of `app.getPath`, which has
 * no name for it: Electron's path names cover `userData`, `temp` and `logs` but
 * not the cache root. These three branches are the ones electron-updater
 * resolves for itself, which is what makes them the right places to look — read
 * off `app.getPath('home')` rather than `$HOME` for the same reason
 * `dork-home.ts` does, so a relocated home still resolves.
 */
export function resolveCacheRoot(): string {
  const home = app.getPath('home');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local');
  return path.join(home, '.cache');
}

/**
 * Directories directly under `cacheRoot` whose name ends in `suffix`.
 *
 * Both the Squirrel state directory and the updater cache are named after
 * identifiers that live in build config rather than in this source — the app id
 * and the package name — so matching the suffix keeps this correct if either is
 * ever renamed. A rename would otherwise turn into a confident "not present",
 * which is a worse answer than no answer.
 *
 * **Listing only — never delete anything this returns.** The suffixes it
 * matches belong to Squirrel and electron-updater, not to DorkOS, so on a real
 * machine this answers with Slack's, Discord's, Notion's and Cursor's
 * directories alongside ours. That is right for a report that says what update
 * state exists and catastrophic for a purge; the purge resolves its two
 * directories by identity instead ({@link purgeStaleStagedUpdates}).
 *
 * @param cacheRoot - The OS cache directory; see {@link resolveCacheRoot}.
 * @param suffix - The name suffix to match.
 * @throws If `cacheRoot` cannot be listed. Callers that must not fail check it
 *   exists first; the diagnostic report reports the failure instead.
 */
export function findCacheDirs(cacheRoot: string, suffix: string): string[] {
  return fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => path.join(cacheRoot, entry.name));
}

/**
 * The version an artifact's file name claims, or `null` if it names none.
 *
 * Split on the delimiters electron-builder uses and take a segment that is
 * *entirely* a version, rather than searching the name for something
 * version-shaped — see {@link VERSION_SEGMENT_PATTERN} for what that
 * distinction is worth.
 *
 * @param name - A file name such as `DorkOS-0.63.0-arm64-mac.zip`.
 */
function versionFromArtifactName(name: string): string | null {
  for (const segment of name.split(/[-_]/)) {
    const match = VERSION_SEGMENT_PATTERN.exec(segment);
    if (match) return match[1];
  }
  return null;
}

/**
 * The newest version staged in `pendingDir`, or `null` when nothing there names
 * one.
 *
 * The version comes out of the artifact's **file name**, because that is the
 * only place it exists: `update-info.json` records `{ fileName, sha512,
 * isAdminRightsRequired }` and no version at all (electron-updater's
 * `DownloadedUpdateHelper`). So the manifest is read for the name it points at,
 * and the directory listing is read as well — a manifest that is missing or
 * corrupt must not hide a staged artifact sitting right beside it.
 *
 * The **newest** of what it finds, not the first: this answer is used to decide
 * whether the whole directory is stale, and half-deleting a genuinely newer
 * update because an older sibling was listed first would cost a person their
 * update.
 *
 * @param pendingDir - Absolute path of the updater cache's `pending` directory.
 */
function stagedVersion(pendingDir: string): string | null {
  const names = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(pendingDir, UPDATE_INFO_FILE), 'utf8')
    );
    const fileName = (parsed as { fileName?: unknown }).fileName;
    if (typeof fileName === 'string') names.add(fileName);
  } catch {
    // Missing or unreadable manifest; the listing below is the real evidence.
  }
  try {
    for (const entry of fs.readdirSync(pendingDir)) names.add(entry);
  } catch {
    // No pending directory, or one that cannot be listed. Not an early return:
    // a readable manifest may already have named the artifact.
  }

  let newest: string | null = null;
  for (const name of names) {
    const version = versionFromArtifactName(name);
    if (version !== null && (newest === null || isNewerVersion(version, newest))) newest = version;
  }
  return newest;
}

/**
 * A directory name safe to delete under the shared cache root: one path
 * segment, not a traversal, and ending in the suffix its owner's convention
 * requires.
 *
 * Every answer this module deletes from goes through here, because the inputs
 * are read off disk — a bundle's `Info.plist`, a generated `app-update.yml` —
 * and "delete the directory this file names" is only safe if the name cannot
 * point somewhere else.
 *
 * @param name - The candidate directory name.
 * @param suffix - The suffix the name must end with.
 */
function isSafeCacheDirName(name: string, suffix: string): boolean {
  if (!name.endsWith(suffix) || name.length === suffix.length) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return name !== '.' && name !== '..';
}

/**
 * OUR updater download cache, or `null` when we cannot prove which one it is.
 *
 * Resolved exactly the way electron-updater resolves it for itself
 * (`AppUpdater.getOrCreateDownloadHelper`): the `updaterCacheDirName` recorded
 * in the `app-update.yml` electron-builder writes into the app's resources,
 * joined to the OS cache root. One deliberate difference — electron-updater
 * falls back to the app name when the key is absent, and this refuses instead.
 * A guess is fine when the cost is re-downloading an update, and unacceptable
 * when the cost is deleting a directory that belongs to somebody else.
 *
 * The value is read with a line scan rather than a YAML parser: the file is
 * flat generated key/value, the main process ships no YAML dependency, and the
 * name is validated as a plain directory segment before it is used.
 *
 * @param cacheRoot - The OS cache directory; see {@link resolveCacheRoot}.
 */
function ourUpdaterCacheDir(cacheRoot: string): string | null {
  let config: string;
  try {
    config = fs.readFileSync(path.join(process.resourcesPath, APP_UPDATE_CONFIG), 'utf8');
  } catch {
    // Absent in development, and absent from any build that is not ours.
    return null;
  }
  const declared = config
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith(`${CACHE_DIR_NAME_KEY}:`))
    ?.split(':')
    .slice(1)
    .join(':')
    .trim()
    .replace(/^['"]|['"]$/g, '');

  if (!declared || !isSafeCacheDirName(declared, UPDATER_DIR_SUFFIX)) {
    log.warn(
      `[updater] Not purging any download cache: ${APP_UPDATE_CONFIG} named ` +
        `${declared === undefined ? 'no cache directory' : `"${declared}"`}.`
    );
    return null;
  }
  return path.join(cacheRoot, declared);
}

/**
 * OUR Squirrel state directory, or `null` when we cannot prove which one it is.
 *
 * Squirrel.Mac names it `<bundle identifier>.ShipIt`, and the bundle identifier
 * is read from the `Info.plist` of the bundle this process is running from —
 * the app's own answer about its own identity, rather than a constant here that
 * could drift from `electron-builder.yml`.
 *
 * @param cacheRoot - The OS cache directory; see {@link resolveCacheRoot}.
 */
function ourShipItDir(cacheRoot: string): string | null {
  const bundleId = installedBundleIdentifier();
  if (bundleId === null) return null;
  const name = `${bundleId}${SHIPIT_DIR_SUFFIX}`;
  if (!isSafeCacheDirName(name, SHIPIT_DIR_SUFFIX)) return null;
  return path.join(cacheRoot, name);
}

/**
 * Delete a file or directory, reporting whether there was anything to delete.
 *
 * @param target - Absolute path to remove.
 * @returns Whether `target` existed and is now gone.
 */
function remove(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn(`[updater] Could not delete ${target}.`, err);
    return false;
  }
}

/**
 * Delete Squirrel's record of the install it was going to do, and the copy it
 * unpacked to do it with.
 *
 * Only ever called once OUR staged artifact has been judged stale, and that is
 * what makes it sound: Squirrel's `update.*` directory is unpacked FROM that
 * artifact, so a stale artifact means a stale unpacked copy and a plist
 * pointing at it. Confined to our own state directory — the cache root holds
 * one of these for every Squirrel app on the machine, several of them mid
 * install.
 *
 * @param shipItDir - Our Squirrel state directory; see {@link ourShipItDir}.
 * @returns Absolute paths removed.
 */
function purgeShipItState(shipItDir: string): string[] {
  const removed: string[] = [];
  const state = path.join(shipItDir, SHIPIT_STATE_FILE);
  if (remove(state)) removed.push(state);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(shipItDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SHIPIT_UPDATE_DIR_PREFIX)) continue;
    const staged = path.join(shipItDir, entry.name);
    if (remove(staged)) removed.push(staged);
  }
  return removed;
}

/**
 * Throw away a staged update that has already been caught up with.
 *
 * Run once per launch, before the first update check. The condition is
 * `installedVersion >=` whatever is staged, which covers both ways a staged
 * update goes stale: it installed (so re-installing it is pointless work on
 * every quit for ever), or the person installed a newer copy by hand (so
 * handing it to Squirrel on the next quit would silently DOWNGRADE them — the
 * support remedy for a broken updater, undone by the broken updater).
 *
 * **Only ever our own two directories.** They sit in a cache root shared with
 * every other app on the machine, and this used to find them by suffix — which
 * on a real desktop matches Slack's, Discord's, Notion's and Cursor's state
 * too, including a download in progress. Identity comes from
 * {@link ourUpdaterCacheDir} and {@link ourShipItDir}, and an identity that
 * cannot be established deletes nothing at all.
 *
 * Nothing here may stop the app from starting. Every failure is logged and
 * swallowed, and a directory whose staged version cannot be read is left
 * completely alone: deleting what we could not judge is how you throw away
 * someone's legitimately newer update.
 *
 * @param installedVersion - The version to judge staleness against. Defaults to
 *   the version running now, which is the right question at launch. The
 *   manual-overwrite restart passes the version **on disk** instead: the app
 *   about to start is the one that was just installed, and the staged copy it
 *   has overtaken must not be applied on the way out.
 * @returns Absolute paths removed, for the caller's log and for tests.
 */
export function purgeStaleStagedUpdates(installedVersion?: string): string[] {
  const removed: string[] = [];
  try {
    const running = installedVersion ?? app.getVersion();
    const cacheRoot = resolveCacheRoot();
    if (!fs.existsSync(cacheRoot)) return removed;

    const cacheDir = ourUpdaterCacheDir(cacheRoot);
    if (cacheDir === null) return removed;

    const pendingDir = path.join(cacheDir, PENDING_DIR);
    const staged = stagedVersion(pendingDir);
    if (staged === null) return removed;
    if (!isAtLeastVersion(running, staged)) {
      log.info(`[updater] Keeping the staged ${staged} update: it is newer than ${running}.`);
      return removed;
    }

    if (remove(pendingDir)) removed.push(pendingDir);
    const shipItDir = ourShipItDir(cacheRoot);
    if (shipItDir !== null) removed.push(...purgeShipItState(shipItDir));

    if (removed.length > 0) {
      log.info(
        `[updater] Purged a staged update that ${running} has already caught up with: ` +
          removed.join(', ')
      );
    }
  } catch (err) {
    log.warn('[updater] Could not check for a stale staged update.', err);
  }
  return removed;
}
