import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import log from 'electron-log';

/**
 * What the app was told it was about to install, remembered across the restart
 * that installs it.
 *
 * Squirrel's install failures are undetectable in-process (electron/electron#8912):
 * `quitAndInstall()` returns, the app quits, and whether anything was installed
 * is only knowable by looking at what came back up. A person hit exactly that
 * for ten days — five updates staged, none installed, no error anywhere — so
 * the only place the question can honestly be answered is the NEXT launch, and
 * the only way to ask it is to have written down what was promised.
 *
 * Deliberately a plain JSON file in `userData` rather than `conf`-backed config:
 * it is machine state about one attempt, not a preference, it must survive an
 * app that is quitting mid-sequence, and it is written from a quit path where a
 * schema migration would be the last thing anybody wants running.
 *
 * @module main/updater-intent
 */

/** The file name under `userData`. */
const INTENT_FILE_NAME = 'updater-intent.json';

/** What was promised, when, and how many times running. */
export interface UpdateIntent {
  /** The version the updater said it had downloaded and was about to install. */
  offeredVersion: string;
  /** When the install was attempted, ISO 8601 — readable in a diagnostic report. */
  attemptedAt: string;
  /**
   * How many times this same version has been attempted without landing.
   *
   * Reset to 1 whenever a different version is offered: a new version is a new
   * attempt, and carrying the old count forward would push a fresh update
   * straight past the "stop re-offering the restart" threshold.
   */
  attempts: number;
}

/** Resolved per call, never at module load: `app.getPath` is not answerable before `ready`. */
function intentFilePath(): string {
  return join(app.getPath('userData'), INTENT_FILE_NAME);
}

/**
 * Whether a parsed JSON blob is actually a usable {@link UpdateIntent} — a
 * hand-edited or truncated file is not.
 *
 * **`offeredVersion` has to PARSE, not merely be a string.** Every comparison
 * against an unreadable version answers `false`, which reads as "the update did
 * not land" — so a file holding `""` or `"latest"` would show a failure card
 * that no amount of successful updating could ever clear. Rejected here and
 * deleted by {@link readUpdateIntent}, which is the only way out of that.
 */
function isUpdateIntent(value: unknown): value is UpdateIntent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UpdateIntent>;
  return (
    typeof candidate.offeredVersion === 'string' &&
    parseVersion(candidate.offeredVersion) !== null &&
    typeof candidate.attemptedAt === 'string' &&
    typeof candidate.attempts === 'number' &&
    Number.isFinite(candidate.attempts) &&
    candidate.attempts >= 1
  );
}

/**
 * Read the recorded install intent, or `null` when there is none.
 *
 * A missing file is the ordinary case — no install has been attempted since the
 * last one succeeded. A corrupt one is treated the same way: the verdict this
 * feeds accuses the updater of failing, and that accusation must never rest on
 * a file we could not read.
 *
 * **An unusable file is deleted rather than merely ignored.** Nothing else ever
 * removes it — the success path deletes only a record it could read — so a file
 * that fails {@link isUpdateIntent} would otherwise be re-read and re-rejected
 * on every launch for the life of the install.
 */
export function readUpdateIntent(): UpdateIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(intentFilePath(), 'utf-8'));
  } catch {
    // Missing (the ordinary case) or unreadable; either way there is no record.
    return null;
  }
  if (isUpdateIntent(parsed)) return parsed;
  log.warn('[updater] Discarding an unreadable install-attempt record.');
  clearUpdateIntent();
  return null;
}

/**
 * Record that an install of `offeredVersion` is being attempted now.
 *
 * Called on the way out, so it is synchronous and swallows its own failures:
 * losing the record costs one un-detected failed install, while throwing from
 * here would strand a quit that is already under way.
 *
 * @param offeredVersion - The version the updater downloaded and is about to install.
 * @returns The intent as written, or `null` if it could not be persisted.
 */
export function writeUpdateIntent(offeredVersion: string): UpdateIntent | null {
  const previous = readUpdateIntent();
  const attempts = previous?.offeredVersion === offeredVersion ? previous.attempts + 1 : 1;
  const intent: UpdateIntent = {
    offeredVersion,
    attemptedAt: new Date().toISOString(),
    attempts,
  };
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(intentFilePath(), JSON.stringify(intent));
    return intent;
  } catch (err) {
    log.warn('[updater] Could not record the install attempt.', err);
    return null;
  }
}

/** Forget the recorded attempt — the update it named is running now. */
export function clearUpdateIntent(): void {
  try {
    rmSync(intentFilePath(), { force: true });
  } catch (err) {
    // A file that will not delete means the next launch re-judges an attempt
    // that actually succeeded — annoying, never fatal, and not worth a throw
    // from the launch path.
    log.warn('[updater] Could not clear the recorded install attempt.', err);
  }
}

/** A version split into its numeric core and its prerelease identifiers. */
interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

/** `MAJOR.MINOR.PATCH` with an optional prerelease; build metadata is matched and ignored, as semver orders it. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string, or `null` if it is not one. */
function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Compare prerelease identifier lists per semver §11: numeric before alphanumeric, shorter before longer. */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftIsNumeric = /^\d+$/.test(left);
    const rightIsNumeric = /^\d+$/.test(right);
    if (leftIsNumeric && rightIsNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right);
      continue;
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Order two parsed versions: negative if `a` is older, positive if newer, zero if equal. */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  // A release outranks any prerelease of itself: 1.0.0 > 1.0.0-rc.1.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Is `version` at least `baseline` in semver order?
 *
 * **This is the whole of the next-launch verdict**, so its failure mode is
 * chosen rather than incidental: an unparsable version on either side answers
 * `false`, which reads as "the update did not land" and shows the person a
 * failure. The alternative — assuming success when we cannot tell — is the
 * silence this feature exists to end.
 *
 * A local comparator rather than `semver`: the desktop main process declares
 * neither `semver` nor its types, and the versions being compared are both
 * produced by our own release train, where the only variable worth handling
 * beyond the numeric core is a prerelease suffix.
 *
 * @param version - The version to test.
 * @param baseline - The version it must reach.
 */
export function isAtLeastVersion(version: string, baseline: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(baseline);
  if (!a || !b) return false;
  return compareParsed(a, b) >= 0;
}

/**
 * Is `version` strictly newer than `baseline`?
 *
 * The question that decides whether a fresh download may clear a recorded
 * failure: re-downloading the SAME version that just failed to install is what
 * the updater does on its next check, and treating that as good news is exactly
 * the lie the card used to tell.
 *
 * @param version - The version to test.
 * @param baseline - The version it must beat.
 */
export function isNewerVersion(version: string, baseline: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(baseline);
  if (!a || !b) return false;
  return compareParsed(a, b) > 0;
}
