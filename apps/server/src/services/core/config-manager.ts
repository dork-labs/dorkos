/**
 * Persistent user configuration — canonical entry point.
 *
 * Owns `~/.dork/config.json` via the `conf` library (v15.1.0). Zod is the
 * authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's
 * Ajv validation so we never hand-maintain JSON Schema. Handles first-run
 * detection, corrupt-config backup + recreate, and sensitive-field warnings.
 *
 * ## Nothing is replaced that could not be read
 *
 * Recovery replaces the config file, so what counts as "corrupt" is a data-loss
 * decision, not a logging one. Two rules, and the second is the one that holds
 * absolutely:
 *
 * 1. A failure the OS raised — any errno error, including one `conf` stripped
 *    the code off — never replaces anything, however long it lasts
 *    ({@link classifyConfigLoadFailure}).
 * 2. Whatever rule 1 misses, nothing is replaced unless
 *    {@link readStoredConfigForSalvage} first read the file. A successful read
 *    is both the evidence that the file really is the problem and the only way
 *    a protection can be carried across, and it is a stronger guarantee than
 *    any judgement about an error's shape.
 *
 * ## Migration semantics (conf's `projectVersion` model)
 *
 * `conf` tracks migration state **inside the config file itself**, in an
 * internal key at `__internal__.migrations.version`. On every instantiation:
 *
 *   1. Conf reads the stored `__internal__.migrations.version`.
 *   2. Compares against `projectVersion` passed to the constructor.
 *   3. Runs every migration whose semver key is greater than the stored
 *      version and less than or equal to `projectVersion`, in **object-insertion
 *      order** (conf does not sort the keys) — so keep the entries in ascending
 *      version order to match intent.
 *   4. After all migrations run, writes `projectVersion` back.
 *
 * `projectVersion` is the **app version**, not a schema version. Migration
 * keys are the app versions at or after which each migration should fire.
 * Each migration runs at most once per user.
 *
 * ## Append-only rule
 *
 * Never edit a shipped migration body. Once a migration has run on real
 * users, its body is frozen — editing it leaves users in divergent states.
 * To fix a bad migration, append a new one at the next version.
 *
 * ## Adding or changing fields
 *
 * See `contributing/configuration.md` → **Schema Migrations** for the full
 * process, and `.claude/skills/adding-config-fields/SKILL.md` for the
 * guided flow. The `/system:release` command's Phase 2 Check 6 detects
 * schema drift and offers to scaffold missing migrations inline before the
 * release tag is cut.
 *
 * ## Implementation notes
 *
 * - `projectVersion` is sourced from `SERVER_VERSION` in `lib/version.ts`,
 *   which honors `DORKOS_VERSION_OVERRIDE`, the esbuild-injected
 *   `__CLI_VERSION__`, and the package.json dev fallback in that order. Do
 *   not hardcode a version string here.
 * - Both the primary and corrupt-recovery Conf constructors use a single
 *   `confOptions` object inside the constructor below so the migration
 *   chain and `projectVersion` apply equally on recovery. If you add new
 *   options, add them to `confOptions` — do not duplicate the literal.
 * - Migrations live in the module-level `CONFIG_MIGRATIONS` constant so
 *   they are append-only by construction and trivially testable in
 *   isolation.
 *
 * @module services/core/config-manager
 */
import Conf from 'conf';
import { type Schema } from 'conf';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
  ONBOARDING_STEPS,
  SidebarItemRefSchema,
  SidebarGroupSchema,
  ComposerPrefsSchema,
  SidebarPrefsSchema,
  toSidebarItemRef,
  normalizeSidebarPrefs,
} from '@dorkos/shared/config-schema';
import type { UserConfig, SidebarItemRef } from '@dorkos/shared/config-schema';
import { logger, logError } from '../../lib/logger.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { latestInstant, restoreProtectedState } from './safe-defaults/protected-state.js';

/**
 * The result of reading a config file that `conf` refused, before replacing it.
 *
 * The two cases are kept apart because only one of them permits a replacement.
 * `read: true` means the bytes are in hand, which is both what salvage needs
 * and the only proof that the file, rather than the machine, is the problem.
 * `read: false` means the file was never read at all, and nothing may be
 * concluded from that except that DorkOS must keep its hands off it.
 */
type SalvageRead = { read: true; value: unknown } | { read: false; error: unknown };

/**
 * Read a config file that `conf` just refused, so its protections can be
 * salvaged before the file is replaced.
 *
 * Retried on the same staircase as the load itself, and for the same reason.
 * This read happens during whatever is going wrong on the machine, so a single
 * unretried attempt is at its least likely to succeed exactly when it matters
 * most: a storm that condemns the file is still blowing when salvage runs, and
 * a salvage that comes back empty silently costs the person a protection
 * (DOR-584) rather than a preference.
 *
 * Never throws. A read that worked but whose contents will not parse is still
 * `read: true` with an `undefined` value — a truncated file is genuinely
 * unsalvageable, and that is a different fact from never having seen it.
 *
 * @param configPath - Absolute path to the config file being replaced.
 * @param retryDelaysMs - Backoff between attempts; its length is the retry count.
 * @returns The parsed contents, or the failure that stopped the read.
 */
function readStoredConfigForSalvage(
  configPath: string,
  retryDelaysMs: readonly number[]
): SalvageRead {
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) return { read: false, error };
      sleepSync(delay);
      continue;
    }
    try {
      return { read: true, value: JSON.parse(raw) };
    } catch {
      // Read fine, will not parse. Nothing to salvage, but the file is
      // genuinely damaged and may be replaced.
      return { read: true, value: undefined };
    }
  }
}

/**
 * What a failed `conf` load says about the file on disk.
 *
 * The three kinds differ in exactly one way that matters: whether the file may
 * be replaced, and after how long.
 *
 * - `corrupt` — the stored bytes are unusable and only replacing the file gets
 *   past it: the JSON does not parse, the contents fail the schema, or they
 *   cannot be decrypted. Condemned immediately, because re-reading the same
 *   bytes cannot change the answer.
 * - `io` — the READ failed and the contents were never in question. An `EMFILE`
 *   while the machine is out of file descriptors, an `EACCES` after an
 *   ownership change, an `EBUSY` while another program holds the file, an `EIO`
 *   off a flaky disk. **Never condemns the file, however long it lasts.**
 * - `unknown` — neither. Retried, and condemned only if it survives the whole
 *   backoff staircase, at which point it is deterministic and the file is the
 *   only thing it can be about.
 */
export type ConfigLoadFailureKind = 'corrupt' | 'io' | 'unknown';

/**
 * Decide what a `conf` load failure says about the stored file.
 *
 * ## The defect this exists for
 *
 * `conf` reports every failure the same way — it rethrows — and the recovery
 * below used to treat *any* throw as proof of corruption, back the file up and
 * delete it. So a config that was perfectly valid, read during a burst of
 * file-descriptor pressure, was destroyed by the code meant to protect it.
 * (Observed: a valid `config.json` replaced with defaults while the machine was
 * in an `EMFILE` storm. The `.bak` it left behind parsed and validated
 * cleanly.)
 *
 * ## Why `io` is a class of its own, and not just "did not clear yet"
 *
 * An errno failure is never evidence about what a file contains, and that stays
 * true no matter how many times it repeats. The storm that motivated this ran
 * for far longer than any sensible boot-time backoff, so "it failed four times,
 * therefore the file is bad" would hand the original defect straight back on a
 * timer. An errno error is therefore fatal-but-harmless: DorkOS stops, says so,
 * and the file is exactly where the person left it.
 *
 * ## Why `unknown` is condemned rather than retried forever
 *
 * `conf` runs the migration chain inside its constructor, and `_migrate` feeds
 * the file's own `__internal__.migrations.version` into `semver` (`conf@15`,
 * `_shouldPerformMigration`). One flipped byte in that string — still valid
 * JSON, still schema-valid, and outside the Ajv schema entirely — throws
 * `TypeError: Invalid Version` from inside the constructor. That is as
 * file-caused as a syntax error, and treating it as unreadable would brick boot
 * permanently while telling the person to try again. So the residual class is
 * condemned once the staircase has proved it deterministic. A migration body
 * that throws (wrapped by `conf` as `Something went wrong during the
 * migration!`) lands in the same class, for the same reason.
 *
 * That is the general rule rather than a list of conf's internals: the caller
 * retries, and time does the classifying. It costs a broken file one 750ms
 * staircase before it is recovered.
 *
 * ## The three `corrupt` shapes
 *
 * Taken from where `conf` itself decides what `clearInvalidConfig` would have
 * cleared (`conf@15`, `get store()`). DorkOS sets `clearInvalidConfig: false`,
 * so `conf` rethrows all three rather than handling them, which is what puts
 * the decision here. They are named only to skip a pointless staircase — the
 * `unknown` path would reach the same verdict 750ms later.
 *
 * A partly-written file is not a case this has to cover: `conf` writes through
 * `atomically`, so a reader sees either the old file or the new one.
 *
 * @param error - Whatever the `Conf` constructor threw.
 * @returns What the failure says about the file.
 */
export function classifyConfigLoadFailure(error: unknown): ConfigLoadFailureKind {
  if (!(error instanceof Error)) return 'unknown';
  // `JSON.parse` inside conf's `_deserialize`.
  if (error.name === 'SyntaxError') return 'corrupt';
  // conf's Ajv wrapper: `Config schema violation: server.port must be integer`.
  if (error.message.startsWith('Config schema violation:')) return 'corrupt';
  // conf's decrypt failure, raised with exactly this message. Unreachable while
  // DorkOS passes no `encryptionKey`, and kept so it stays right if one is ever
  // added.
  if (error.message === 'Failed to decrypt config data.') return 'corrupt';
  return isIoFailure(error) ? 'io' : 'unknown';
}

/**
 * The first sentence `conf` puts on anything thrown from inside a migration.
 *
 * `conf@15`'s `_migrate` catches every failure in its per-migration `try` and
 * rethrows it as a plain `Error`, appending the original message and keeping
 * neither `code` nor `cause`.
 */
const CONF_MIGRATION_WRAPPER = 'Something went wrong during the migration!';

/** A bare errno code as Node writes it: `EMFILE`, `EACCES`, `EIO`. */
const ERRNO_CODE = /^E[A-Z0-9]+$/;

/**
 * The same code as it appears at the head of an `fs` error's message, e.g.
 * `EMFILE: too many open files, open '/…'`.
 */
const ERRNO_IN_MESSAGE = /(?:^|\s)E[A-Z0-9]{2,}: /;

/**
 * Whether an error is the operating system refusing a file operation.
 *
 * Node stamps every failed syscall with a bare errno code (`EMFILE`, `EACCES`,
 * `EBUSY`, `EIO`, …). Node's own `ERR_*` codes carry underscores and are
 * excluded deliberately: those report a bad call, not a disk or descriptor
 * problem, so they belong in the deterministic class.
 *
 * ## The laundered case
 *
 * A bare code is not always there to read. `conf` runs the migration chain
 * inside its constructor, and the per-migration `try` in `_migrate` wraps
 * anything thrown into a plain `Error` — no `code`, no `cause`. That block
 * contains READS (every migration body calls `store.get`/`store.has`, and each
 * one reads the file), so an `EMFILE` on any read after the first arrives here
 * with nothing left to identify it. Left unrecognised it looked deterministic,
 * failed identically four times, and cost a valid config its life on the one
 * boot after an upgrade — which is exactly when a migration body runs.
 *
 * So a wrapped error is unwrapped by looking for the errno at the head of the
 * message `conf` appended. The match is gated on `conf`'s own wrapper sentence
 * rather than applied to every message, because a false `io` verdict is not
 * free: it makes a deterministic failure un-condemnable, and the boot it blocks
 * would never clear. Anything this misses is still caught by the rule that
 * nothing gets replaced unless {@link readStoredConfigForSalvage} could read
 * it — a message format is a weaker guarantee than a successful read.
 *
 * @param error - The error to inspect.
 */
function isIoFailure(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && ERRNO_CODE.test(code)) return true;
  return error.message.startsWith(CONF_MIGRATION_WRAPPER) && ERRNO_IN_MESSAGE.test(error.message);
}

/**
 * Raised when the operating system would not let DorkOS read the config file,
 * after retrying.
 *
 * Carries the underlying failure as `cause` and the path as
 * {@link ConfigUnreadableError.configPath} so a caller can report both. The
 * message is written for the person reading a terminal, because that is where
 * it lands: the server prints it and stops.
 *
 * @see {@link unreadableMessage} for why there are two of them.
 */
export class ConfigUnreadableError extends Error {
  /** Absolute path of the config file that could not be read. */
  readonly configPath: string;

  /**
   * What the person can actually do about it, as a paragraph of its own.
   *
   * Split out so `dorkos doctor` can show the same next step on its checklist
   * without restating it. Two copies of this advice drifted apart once already.
   */
  readonly advice: string;

  /**
   * Build the message a person sees when their settings could not be read.
   *
   * @param configPath - Absolute path of the config file.
   * @param cause - The last failure from the `Conf` constructor.
   * @param backupPath - Where the old settings were copied, when this happened
   *   on the second leg of corrupt-recovery and the original is already gone.
   */
  constructor(configPath: string, cause: unknown, backupPath?: string) {
    const advice = adviceFor(cause, configPath, backupPath);
    super(unreadableMessage(configPath, cause, advice, backupPath), { cause });
    this.name = 'ConfigUnreadableError';
    this.configPath = configPath;
    this.advice = advice;
  }
}

/**
 * Errno codes that pass on their own, given a moment.
 *
 * The distinction is the whole point of {@link adviceFor}: "try again" is good
 * advice for a machine that ran out of descriptors and terrible advice for a
 * file the person is not allowed to open, where it means "loop forever".
 */
const SELF_CLEARING_ERRNOS = new Set([
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EAGAIN',
  'EINTR',
  'EIO',
  'ETIMEDOUT',
  'ENOMEM',
]);

/** Errno codes that mean the person, not the machine, has to do something. */
const PERMISSION_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Errno codes that mean there is nowhere to put the bytes.
 *
 * Separate from the permission set because the fix is different and the rename
 * hatch is useless: renaming the file does not let DorkOS write a new one when
 * the disk is full. Reachable through the backup copy on the recovery path.
 */
const NO_SPACE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EFBIG']);

/**
 * The errno behind a failure, whether it is on the error or only in its text.
 *
 * @param cause - The failure to read a code out of.
 * @returns The code, or `undefined` when there is none to find.
 */
function errnoOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const code = (cause as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && ERRNO_CODE.test(code)) return code;
  return ERRNO_IN_MESSAGE.exec(cause.message)?.[0].trim().replace(':', '');
}

/**
 * The next step to offer, chosen by what the operating system actually said.
 *
 * Every branch names something a person can do. "Check that you can open that
 * file" was the old text, and it names no action at all.
 *
 * Two things this must not do. It must not point at a line by position: the
 * same string is shown under three different layouts (with a backup, without
 * one, and as a `dorkos doctor` row), and "the line above" is a different line
 * in each. And when `backupPath` is set it must not offer the rename hatch,
 * because on that path the person's settings are in the BACKUP and the file
 * they would be renaming is the failed replacement, which keeps nothing.
 *
 * @param cause - The failure being reported.
 * @param configPath - Absolute path of the config file.
 * @param backupPath - Where the old settings already went, if they did.
 */
function adviceFor(cause: unknown, configPath: string, backupPath?: string): string {
  const code = errnoOf(cause);
  if (code !== undefined && SELF_CLEARING_ERRNOS.has(code)) {
    return (
      `This usually means the file was busy, or your computer had too many\n` +
      `files open at once. Both pass on their own, so start DorkOS again.`
    );
  }
  if (code !== undefined && NO_SPACE_ERRNOS.has(code)) {
    return (
      `There is no room left to write the file. Free up some disk space, then\n` +
      `start DorkOS again.`
    );
  }
  if (code !== undefined && PERMISSION_ERRNOS.has(code)) {
    const fix =
      `DorkOS is not allowed to open that file, and waiting will not change\n` +
      `that. Give yourself permission to read and write it (on a Mac or Linux:\n` +
      `chmod u+rw "${configPath}"; on Windows, right-click the file, then\n` +
      `Properties and Security).`;
    if (backupPath !== undefined) return `${fix} Then start DorkOS again.`;
    return (
      `${fix} If you would rather start fresh, rename the file. DorkOS will\n` +
      `make a new one, and your old settings stay in the file you renamed.`
    );
  }
  if (backupPath !== undefined) {
    // Named and actionable, like the permission branch above it: the failure
    // here is a file that could not be CREATED, so the folder is the subject.
    return (
      `DorkOS could not create a file in this folder:\n\n` +
      `  ${path.dirname(configPath)}\n\n` +
      `Give yourself permission to write there (on a Mac or Linux:\n` +
      `chmod u+w "${path.dirname(configPath)}"; on Windows, right-click the\n` +
      `folder, then Properties and Security). Then start DorkOS again.`
    );
  }
  return (
    `That is unlikely to fix itself. If you cannot clear the problem named\n` +
    `above, rename the file and DorkOS will make a new one, keeping your old\n` +
    `settings in the file you renamed.`
  );
}

/**
 * The text of a {@link ConfigUnreadableError}, in the two situations it covers.
 *
 * They have to be different, because the reassuring one would otherwise be a
 * lie. Corrupt-recovery copies the old file to `.bak` and deletes the original
 * before creating a replacement; if THAT creation is what the OS refuses, the
 * settings are neither untouched nor where the person left them. Sending them
 * to `config.json` at that point would point at the wrong file, when theirs is
 * sitting next to it under another name.
 *
 * ## What the plain branch may and may not claim
 *
 * It says DorkOS did not REPLACE OR DELETE anything, which is the guarantee
 * this module actually delivers, and it holds absolutely. It does not say the
 * bytes are untouched, because `conf` writes before DorkOS gets a verdict:
 * `#runMigrations` calls `_write(storeWithDefaults)` BEFORE `_migrate` runs, so
 * on any boot where the stored file is not already default-shaped — every
 * upgrade boot — the file has been rewritten with the defaults merged in
 * before this error is even constructed. Nothing is lost by that (the merge is
 * shallow and the stored value wins per top-level key), but a 131-byte config
 * can be 2429 bytes by the time a person reads this, so "nothing was changed"
 * was false wherever it mattered most.
 *
 * @param configPath - Absolute path of the config file.
 * @param cause - The failure being reported.
 * @param advice - The next step, from {@link adviceFor}.
 * @param backupPath - Where the old settings were copied, if they were.
 */
function unreadableMessage(
  configPath: string,
  cause: unknown,
  advice: string,
  backupPath?: string
): string {
  const what = `  file: ${configPath}\n  why:  ${describeLoadError(cause)}`;
  if (backupPath !== undefined) {
    return [
      `DorkOS could not finish repairing your settings.`,
      ``,
      what,
      ``,
      `Your old settings could not be used, so DorkOS copied them to the file`,
      `below and tried to start a new one. That did not work either.`,
      ``,
      `  ${backupPath}`,
      ``,
      `Your old settings are still in that file.`,
      advice,
    ].join('\n');
  }
  return [
    `DorkOS could not read your settings, so it stopped rather than replacing them.`,
    ``,
    what,
    ``,
    `DorkOS did not replace or delete your settings.`,
    advice,
  ].join('\n');
}

/**
 * One line describing a load failure, for a log or an error message.
 *
 * Node's `fs` errors already begin with their errno code
 * (`EMFILE: too many open files, open '…'`), so the message alone is the whole
 * story for the case this exists to report.
 *
 * @param error - Whatever was thrown.
 */
function describeLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Backoff before each retry of a config read that failed for a reason other
 * than corruption, in milliseconds. Its length is the retry count: four
 * attempts in total, 750ms of waiting in the worst case.
 *
 * Sized for the failure it exists for. File-descriptor exhaustion is a burst:
 * the fds come back within milliseconds once whatever grabbed them settles, so
 * a short staircase converts most of those boots into a normal one. Waiting
 * longer buys little at boot, and any failure that outlives the staircase is
 * reported rather than guessed at.
 */
export const CONFIG_LOAD_RETRY_DELAYS_MS = [50, 200, 500] as const;

/**
 * Block this thread for `ms`.
 *
 * Deliberately blocking: {@link ConfigManager} is constructed synchronously
 * during boot and everything after it needs the config, so there is nothing
 * useful to yield to. Only ever reached on the retry path, and bounded by
 * {@link CONFIG_LOAD_RETRY_DELAYS_MS}.
 *
 * @param ms - How long to block for.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The exact options object both `Conf` constructions below are built from. */
type ConfConstructorOptions = ConstructorParameters<typeof Conf<UserConfig>>[0];

/**
 * Open the `conf` store, riding out a failure that is not the file's fault.
 *
 * Three outcomes, and they are deliberately not the same shape:
 *
 * 1. It opened — the store comes back.
 * 2. The file is condemned — the error comes back so the caller can back it up,
 *    salvage what protects the person, and start a fresh one. Either the
 *    failure was `corrupt` outright, or it was `unknown` and survived the whole
 *    staircase, which makes it deterministic and therefore about the file.
 * 3. The OS refused the file (`io`) — retried on a short backoff, then thrown.
 *    **The file is never touched on this path, however long the failure
 *    lasts.** Losing the ability to read a file is not evidence that the file
 *    is bad, and the person's settings are sitting in it, intact.
 *
 * @param options - Constructor options, shared with the recovery construction.
 * @param configPath - Absolute path of the config file, for logs.
 * @param retryDelaysMs - Backoff between attempts; its length is the retry count.
 * @param backupPath - Where the old settings already went, when this call is
 *   the second leg of corrupt-recovery. Only changes what an error says.
 * @returns The opened store, or the error that condemned the file.
 * @throws {ConfigUnreadableError} When every attempt was refused by the OS.
 */
function loadConfigStore(
  options: ConfConstructorOptions,
  configPath: string,
  retryDelaysMs: readonly number[],
  backupPath?: string
): { store: Conf<UserConfig> } | { corruptedBy: Error } {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return { store: new Conf<UserConfig>(options) };
    } catch (error) {
      lastError = error;
      const kind = classifyConfigLoadFailure(error);
      const condemn = (): { corruptedBy: Error } => ({
        corruptedBy: error instanceof Error ? error : new Error(String(error)),
      });
      if (kind === 'corrupt') return condemn();
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        // The staircase is spent. An `io` failure still says nothing about the
        // contents, so it is reported and the file survives. An `unknown` one
        // has now failed identically across ~750ms, which is what a
        // file-caused failure looks like and a transient one does not: condemn
        // it, so a config `conf` can never open again gets recovered instead of
        // blocking every boot from here on.
        if (kind === 'unknown') {
          logger.warn(
            `[Config] ${configPath} failed to open the same way on every attempt: ` +
              `${describeLoadError(error)}. Treating it as damaged.`
          );
          return condemn();
        }
        break;
      }
      logger.warn(
        `[Config] Could not read ${configPath}: ${describeLoadError(error)}. ` +
          `Leaving the file alone and retrying in ${delay}ms.`
      );
      sleepSync(delay);
    }
  }
  logger.error(`[Config] Gave up reading ${configPath} without modifying it`, logError(lastError));
  throw new ConfigUnreadableError(configPath, lastError, backupPath);
}

/**
 * Append-only `conf` migration chain keyed by app version. See
 * `contributing/configuration.md` → Schema Migrations and
 * `.claude/skills/adding-config-fields/SKILL.md` for the full process.
 *
 * Rules:
 *
 * 1. Never edit a shipped migration body. Append a new entry instead.
 * 2. Every migration must be idempotent (guard with `store.has()`).
 * 3. Keys are app versions (semver), matching real release versions.
 * 4. Conf tracks last-applied state internally at
 *    `__internal__.migrations.version` inside the config file itself.
 */
/**
 * Migration body: backfill `extensions.disabled: []` for configs persisted
 * before the two-list deviation model (Core Extensions). Additive and
 * idempotent — only writes when `disabled` is not already an array, and never
 * touches `enabled`. Configs with no `extensions` key are skipped (the schema
 * default supplies the object on read).
 *
 * Exported for direct unit testing: its {@link CONFIG_MIGRATIONS} key (`0.44.0`)
 * only fires for users upgrading across that release, so exercising the body
 * directly is the reliable test path.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillExtensionsDisabled(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (ext && typeof ext === 'object' && !Array.isArray((ext as { disabled?: unknown }).disabled)) {
    store.set('extensions', { ...(ext as Record<string, unknown>), disabled: [] });
  }
}

/**
 * Migration body: backfill `extensions.approvedToRun: []` for configs persisted
 * before extension code needed a person's approval to run in-process (DOR-516).
 *
 * Seeds the list EMPTY, which means nothing an upgrading user already had
 * installed is pre-approved. That is the deliberate choice, and it is the one
 * place this migration could have gone wrong: backfilling from
 * `extensions.enabled` would read "the person once toggled this on in the
 * cockpit" as "the person reviewed this code", and an agent can turn an extension
 * on through an ungated route. An upgrade must never hand out an approval nobody
 * gave. The cost is that anyone already running a user extension with a server
 * entry approves it once, which is one click and is stated in the changelog.
 *
 * Core extensions are unaffected either way — they are exempt by origin, not by
 * this list (see `extension-load-policy.ts`), so the shipped `linear-issues`
 * data proxy keeps working across the upgrade with nothing to click.
 *
 * Additive and idempotent — only writes when `approvedToRun` is not already an
 * array, and never touches `enabled` or `disabled`. Configs with no `extensions`
 * key are skipped (the schema default supplies the object on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillExtensionsApprovedToRun(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (
    ext &&
    typeof ext === 'object' &&
    !Array.isArray((ext as { approvedToRun?: unknown }).approvedToRun)
  ) {
    store.set('extensions', { ...(ext as Record<string, unknown>), approvedToRun: [] });
  }
}

/**
 * Migration body: backfill the `workspace` section (WorkspaceManager, DOR-84)
 * for configs persisted before it existed. Additive + idempotent — only writes
 * when the key is absent; the schema default also yields this object on read, so
 * this just writes it through on the upgrade where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkspaceDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('workspace') == null) {
    store.set('workspace', {
      enabled: true,
      rootPath: null,
      portBase: 4250,
      portBlockSize: 10,
      defaultProvider: 'worktree',
      retentionCap: null,
    });
  }
}

/**
 * Migration body: backfill the `harness` section (Harness Sync auto-sync gate,
 * GAP-4) for configs persisted before it existed. Additive + idempotent: only
 * writes when the key is absent; the schema default also yields this object on
 * read, so this just writes it through on the upgrade where it lands. Defaults
 * `autoSync` to `true` (auto-sync on install/uninstall is on by default).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillHarnessDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('harness') == null) {
    store.set('harness', { autoSync: true });
  }
}

/**
 * Migration body: backfill `harness.approvedHooks: []` for configs persisted
 * before an installed package needed a person's approval to write shell commands
 * into a coding agent's hook files (DOR-522).
 *
 * Seeds the list EMPTY, exactly as {@link backfillExtensionsApprovedToRun} does
 * and for the same reason: an upgrade must never hand out an approval nobody
 * gave. Anyone already running a hook-shipping plugin is asked once, on the next
 * install into that project, and the commands land the moment they say yes.
 *
 * Additive and idempotent — only writes when `approvedHooks` is not already an
 * array, and never touches `autoSync`. Configs with no `harness` key are skipped
 * (the schema default supplies the object on read, and
 * {@link backfillHarnessDefaults} seeds the section itself).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillHarnessApprovedHooks(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const harness = store.get('harness');
  if (
    harness &&
    typeof harness === 'object' &&
    !Array.isArray((harness as { approvedHooks?: unknown }).approvedHooks)
  ) {
    store.set('harness', { ...(harness as Record<string, unknown>), approvedHooks: [] });
  }
}

/**
 * Migration body: backfill the `runtimes` section (multi-runtime support,
 * additional-agent-runtimes spec) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema
 * default also yields this object on read, so this just writes it through on
 * the upgrade where it lands. Defaults the registry default to `claude-code`
 * with both optional runtimes (opencode, codex) enabled.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRuntimesDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('runtimes') == null) {
    store.set('runtimes', {
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0 },
      codex: { enabled: true, binaryPath: null },
    });
  }
}

/**
 * Migration body: backfill the `auth` section (local login gate,
 * accounts-and-auth P1) for configs persisted before it existed. Additive +
 * idempotent: only writes when the key is absent; the schema default also yields
 * `{ enabled: false }` on read, so this just writes the key through on the
 * upgrade where it lands. Defaults `enabled` to `false` (login is opt-in;
 * progressive disclosure).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillAuthDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('auth') == null) {
    store.set('auth', { enabled: false });
  }
}

/**
 * Migration body: backfill the `approvals` section (standing permissions,
 * DOR-501) for configs persisted before it existed. Additive + idempotent: only
 * writes when the key is absent, and the schema default yields the same shape on
 * read, so this just writes the key through on the upgrade where it lands.
 *
 * Seeds `standingGrants: false`. A safety feature does not get quietly relaxed
 * by an upgrade — nothing changes for an existing user until they ask for it.
 *
 * Also seeds `standingGrantsVoidBefore: null` (DOR-520) onto an `approvals` block
 * an earlier build of this same unreleased key already created, which is why the
 * two seeds are separate `if`s rather than one. `null` means "nothing has been
 * voided yet", which is the honest starting point: no upgrade should retroactively
 * end permissions the person still expects to hold.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillApprovalsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const approvals = store.get('approvals');
  if (approvals == null) {
    store.set('approvals', {
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    return;
  }
  const section = approvals as Record<string, unknown>;
  if (!('standingGrantsVoidBefore' in section)) {
    store.set('approvals', { ...section, standingGrantsVoidBefore: null });
  }
}

/**
 * Migration body: remove the tunnel passcode fields (`tunnel.passcodeEnabled`,
 * `tunnel.passcodeHash`, `tunnel.passcodeSalt`) and the root `sessionSecret`
 * from stored configs. The tunnel passcode auth path and the cookie-session
 * signing secret were removed in the accounts-and-auth spec — Better Auth is the
 * one auth path and manages its own session signing. Existing passcode hashes
 * are discarded, not migrated. Idempotent: only rewrites `tunnel` when a stale
 * passcode key is present, and only deletes `sessionSecret` when it exists.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`/`delete`).
 */
export function dropTunnelPasscodeAndSessionSecret(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const tunnel = store.get('tunnel');
  if (tunnel && typeof tunnel === 'object') {
    const t = tunnel as Record<string, unknown>;
    if ('passcodeEnabled' in t || 'passcodeHash' in t || 'passcodeSalt' in t) {
      const {
        passcodeEnabled: _passcodeEnabled,
        passcodeHash: _passcodeHash,
        passcodeSalt: _passcodeSalt,
        ...rest
      } = t;
      store.set('tunnel', rest);
    }
  }
  if (store.get('sessionSecret') !== undefined) {
    store.delete('sessionSecret');
  }
}

/**
 * Migration body: backfill the `cloud` section (device-link instance token,
 * accounts-and-auth P2, task 2.4) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema default
 * also yields `{ instanceToken: null, instanceName: null, linkedAccountLabel:
 * null }` on read, so this just writes the key through on the upgrade where it
 * lands. A fresh install is never linked (all three fields `null`).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillCloudDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('cloud') == null) {
    store.set('cloud', { instanceToken: null, instanceName: null, linkedAccountLabel: null });
  }
}

/**
 * Migration body: backfill the `workbench` section (right-panel workbench
 * viewer registry overrides, DOR-219) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema default
 * also yields `{ defaultViewers: {} }` on read, so this just writes the key
 * through on the upgrade where it lands. A fresh install has no overrides.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('workbench') == null) {
    store.set('workbench', { defaultViewers: {} });
  }
}

/**
 * Migration body: backfill the credential substrate (CredentialProvider port,
 * effortless-runtime-switching T1, ADR-0315) for configs persisted before it
 * existed. Two additive, idempotent steps:
 *
 * 1. Add the top-level `providers` registry (`{}`) when absent — the shallow
 *    conf defaults-merge already yields it on read, so this just writes the key
 *    through on the upgrade where it lands.
 * 2. Backfill the new per-runtime credential fields onto an EXISTING `runtimes`
 *    block (`codex.credentialRef`, `opencode.provider`, `opencode.baseURL`).
 *    conf merges top-level defaults SHALLOWLY, so a `runtimes` object already on
 *    disk never inherits new nested defaults — this step supplies them. Only
 *    writes the fields that are missing; never overwrites a set value and never
 *    touches the whole-object-absent case (handled by the schema default on
 *    read + the `runtimes` backfill).
 *
 * Never writes a secret: the new fields are seeded to `null` (delegate/host
 * auth), never a plaintext key.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillProvidersDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('providers') == null) {
    store.set('providers', {});
  }

  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const r = runtimes as Record<string, unknown>;
  let changed = false;

  const codex = r.codex;
  if (codex && typeof codex === 'object' && !('credentialRef' in codex)) {
    r.codex = { ...(codex as Record<string, unknown>), credentialRef: null };
    changed = true;
  }

  const opencode = r.opencode;
  if (opencode && typeof opencode === 'object') {
    const o = opencode as Record<string, unknown>;
    if (!('provider' in o) || !('baseURL' in o)) {
      r.opencode = {
        ...o,
        ...(!('provider' in o) ? { provider: null } : {}),
        ...(!('baseURL' in o) ? { baseURL: null } : {}),
      };
      changed = true;
    }
  }

  if (changed) store.set('runtimes', r);
}

/**
 * Migration body: backfill `workbench.terminalGraceTtlMinutes` (embedded-terminal
 * re-attach grace window, DOR-225) onto an EXISTING `workbench` block. conf merges
 * top-level defaults SHALLOWLY, so a `workbench` object already on disk never
 * inherits the new nested default — this step supplies it. Additive + idempotent:
 * only writes when the field is absent, never overwrites a set value. The
 * whole-object-absent case is handled by {@link backfillWorkbenchDefaults} (which
 * runs first) plus the schema default on read. Defaults to 10 minutes, matching
 * the schema and the terminal manager's prior hardcoded grace period.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchTerminalGraceTtl(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const workbench = store.get('workbench');
  if (workbench && typeof workbench === 'object' && !('terminalGraceTtlMinutes' in workbench)) {
    store.set('workbench', {
      ...(workbench as Record<string, unknown>),
      terminalGraceTtlMinutes: 10,
    });
  }
}

/**
 * Migration body: generalize the `telemetry` section into the shared opt-in
 * consent namespace (DOR-293, ADR 260711-141639). Two additive, idempotent
 * steps on an EXISTING `telemetry` block:
 *
 * 1. Rename `telemetry.enabled` → `telemetry.install` (the marketplace-install
 *    channel), preserving the user's prior choice exactly. Only runs when the
 *    legacy `enabled` key is present and `install` is not, then deletes
 *    `enabled` so the block matches the new schema.
 * 2. Backfill the two new peer channel flags — `heartbeat` and
 *    `errorReporting` — to `false` when absent. conf merges top-level defaults
 *    SHALLOWLY, so a `telemetry` object already on disk never inherits these
 *    nested defaults; this step supplies them without touching consent.
 *
 * Never flips a user from opted-out to opted-in: the new channels default OFF
 * and `userHasDecided` is left untouched, so a user who already answered the
 * marketplace consent is not re-prompted but is also not silently enrolled in
 * the heartbeat. The whole-object-absent case is handled by the schema default
 * on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`/`delete`).
 */
export function generalizeTelemetryConsent(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  let changed = false;

  if ('enabled' in t && !('install' in t)) {
    t.install = t.enabled;
    delete t.enabled;
    changed = true;
  }
  if (!('heartbeat' in t)) {
    t.heartbeat = false;
    changed = true;
  }
  if (!('errorReporting' in t)) {
    t.errorReporting = false;
    changed = true;
  }

  if (changed) store.set('telemetry', t);
}

/**
 * Migration body: backfill `workbench.autoOpenDiff` (auto-open the diff review
 * surface on agent edits, DOR-212) onto an EXISTING `workbench` block. conf merges
 * top-level defaults SHALLOWLY, so a `workbench` object already on disk never
 * inherits the new nested default — this supplies it. Additive + idempotent: only
 * writes when the field is absent, never overwrites a set value. Defaults to
 * `true`, matching the schema.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchAutoOpenDiff(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const workbench = store.get('workbench');
  if (workbench && typeof workbench === 'object' && !('autoOpenDiff' in workbench)) {
    store.set('workbench', {
      ...(workbench as Record<string, unknown>),
      autoOpenDiff: true,
    });
  }
}

/**
 * Migration body: backfill `telemetry.lastPromptedVersion` (the consent
 * re-prompt anchor, DOR-312, ADR 260713-143958 Phase 1) onto an EXISTING
 * `telemetry` block. conf merges top-level defaults SHALLOWLY, so a `telemetry`
 * object already on disk never inherits the new nested default — this supplies
 * it. Additive + idempotent: only writes when the field is absent, never
 * overwrites a set value. Seeds `null` (never prompted), which preserves the
 * consent-flip semantics: a never-answered install is not enrolled until a
 * later phase shows the notice. The whole-object-absent case is handled by the
 * schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryLastPromptedVersion(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('lastPromptedVersion' in telemetry)) {
    store.set('telemetry', {
      ...(telemetry as Record<string, unknown>),
      lastPromptedVersion: null,
    });
  }
}

/**
 * Migration body: flip the Tier 1 telemetry channels (`install`, `heartbeat`) to
 * the new opt-out default for never-answered installs (DOR-314, ADR
 * 260713-143958 Phase 2). Operates on an EXISTING `telemetry` block:
 *
 * - If `userHasDecided === true`, the user made an explicit choice (either way) —
 *   change NOTHING, so a prior "no" (or "yes") survives byte-identical.
 * - Otherwise (never answered), set `install = true` and `heartbeat = true`,
 *   enrolling the install in the anonymous opt-out channels. `errorReporting`
 *   (Tier 2, opt-in) and every other field are left untouched.
 *
 * This only flips the config flags; the notice-before-first-send gate
 * (`hasTier1SendGate`, evaluated at boot) still holds back every Tier 1 send
 * until the first-run notice has been shown, so enrollment never means an
 * immediate send. Idempotent: a fully-enrolled never-answered block, and any
 * explicit-choice block, are left as-is. The whole-object-absent case is handled
 * by the schema default on read (which already yields the new `true` defaults).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function applyTier1OptOutDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  // An explicit prior choice is never overridden.
  if (t.userHasDecided === true) return;
  // Idempotent short-circuit: already enrolled, nothing to write.
  if (t.install === true && t.heartbeat === true) return;
  store.set('telemetry', { ...t, install: true, heartbeat: true });
}

/**
 * Migration body: return the Tier 1 telemetry channels (`install`, `heartbeat`,
 * `usage`) to opt-in for every install that never answered a consent prompt
 * (ADR 260727-181825, superseding 260713-143958's Tier 1 posture).
 *
 * The mirror image of {@link applyTier1OptOutDefaults}, which is shipped and
 * therefore frozen — this reverses its effect for the population it enrolled,
 * rather than editing it:
 *
 * - If `userHasDecided === true`, the person made an explicit choice (either
 *   way) — change NOTHING. Someone who chose to keep sharing keeps sharing.
 * - Otherwise (never answered), set all three channels `false`. That includes
 *   installs the 0.48.0 migration enrolled and installs that have since had
 *   their first-run notice shown, which is the point: enrolment by silence is
 *   what this reverses.
 *
 * The consequence is deliberate and is the whole cost of the change: installs
 * that are sending anonymous data today, having never been asked, stop sending
 * it. They are not re-prompted here — `lastPromptedVersion` is untouched, so the
 * cockpit's consent surfaces remain the way back in.
 *
 * Idempotent: an already-opted-out never-answered block, and any
 * explicit-choice block, are left as-is. The whole-object-absent case is handled
 * by the schema default on read, which now yields `false`.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function applyTier1OptInDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  // An explicit prior choice is never overridden — the same rule the opt-out
  // flip honored, applied in the other direction.
  if (t.userHasDecided === true) return;
  // Idempotent short-circuit: already opted out, nothing to write.
  if (t.install === false && t.heartbeat === false && t.usage === false) return;
  store.set('telemetry', { ...t, install: false, heartbeat: false, usage: false });
}

/**
 * Migration body: backfill `telemetry.usage` (the anonymous feature-usage
 * channel, DOR-315, ADR 260713-143958 Phase 3) onto an EXISTING `telemetry`
 * block. conf merges top-level defaults SHALLOWLY, so a `telemetry` object
 * already on disk never inherits the new nested default — this supplies it.
 *
 * Consent-flip semantics: a user who already answered a telemetry consent
 * prompt (`userHasDecided === true`) answered one that did NOT include this
 * channel, so we must not silently expand their explicit choice — they get
 * `usage: false`. A never-answered install gets the Tier 1 default `true`
 * (still gated by the first-run notice before anything sends). Additive +
 * idempotent: only writes when the field is absent, never overwrites a set
 * value. The whole-object-absent case is handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryUsageChannel(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('usage' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    // An explicit prior "no" (or "yes") to the older channels is never widened:
    // if they decided, the new channel starts OFF; otherwise it takes the Tier 1
    // default ON (notice-gated at send time).
    const userDecided = t.userHasDecided === true;
    store.set('telemetry', { ...t, usage: !userDecided });
  }
}

/**
 * Migration body: backfill `telemetry.linkAnalyticsToAccount` (the device-link
 * analytics merge opt-in, DOR-320, ADR 260713-143958 Phase 4) onto an EXISTING
 * `telemetry` block. conf merges top-level defaults SHALLOWLY, so a `telemetry`
 * object already on disk never inherits the new nested default — this supplies
 * it.
 *
 * This is a Tier 2, explicit-opt-in flag: unlike the Tier 1 usage backfill, it
 * always seeds `false` regardless of `userHasDecided`. The consent for this
 * channel is captured in the account-link flow, never inferred from a prior
 * telemetry choice, so every upgraded install starts OFF and only turns on by an
 * explicit choice at link time. Additive + idempotent: only writes when the
 * field is absent, never overwrites a set value. The whole-object-absent case is
 * handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryLinkAnalyticsToAccount(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('linkAnalyticsToAccount' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    store.set('telemetry', { ...t, linkAnalyticsToAccount: false });
  }
}

/**
 * Migration body: backfill `telemetry.aiMetadata` (the opt-in AI-run metadata
 * bridge, DOR-319, ADR 260713-143958 Phase 7) onto an EXISTING `telemetry`
 * block. conf merges top-level defaults SHALLOWLY, so a `telemetry` object
 * already on disk never inherits the new nested default — this supplies it.
 *
 * Unlike the Tier 1 channels, this is a Tier 2 OPT-IN channel: it seeds `false`
 * for EVERY existing install, regardless of `userHasDecided`. A prior consent
 * choice never enrolls anyone in a new opt-in channel — turning it on is always
 * a fresh, explicit act. Additive + idempotent: only writes when the field is
 * absent, never overwrites a set value. The whole-object-absent case is handled
 * by the schema default on read (which already yields `false`).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryAiMetadataChannel(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('aiMetadata' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    store.set('telemetry', { ...t, aiMetadata: false });
  }
}

/**
 * Migration body: backfill `ui.sidebar` (server-persisted sidebar organization —
 * groups, pinned, per-section sort/collapse; DOR-329) onto an EXISTING `ui`
 * block. conf merges top-level defaults SHALLOWLY, so a `ui` object already on
 * disk never inherits the new nested `sidebar` default — this supplies it.
 * Additive + idempotent: only writes when `ui.sidebar` is absent, never
 * overwrites a user's existing organization. The whole-`ui`-absent case is
 * handled by the schema default on read (which already yields the sidebar
 * defaults). Seeds an empty, unorganized sidebar (no pins, no groups).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui && typeof ui === 'object' && (ui as { sidebar?: unknown }).sidebar === undefined) {
    store.set('ui', {
      ...(ui as Record<string, unknown>),
      sidebar: {
        pinned: [],
        groups: [],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
      },
    });
  }
}

/**
 * Migration body: backfill `ui.shapes` (person-scoped Shape state — active
 * Shape, reverse affinity hints, follow toggle; DOR-355) onto an EXISTING `ui`
 * block. conf merges top-level defaults SHALLOWLY, so a `ui` object already on
 * disk never inherits the new nested `shapes` default — this supplies it.
 * Additive + idempotent: only writes when `ui.shapes` is absent, never
 * overwrites an existing value. The whole-`ui`-absent case is handled by the
 * schema default on read (which already yields the shapes defaults). Seeds no
 * active Shape, no affinity hints, and follow off.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillShapesDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui && typeof ui === 'object' && (ui as { shapes?: unknown }).shapes === undefined) {
    store.set('ui', {
      ...(ui as Record<string, unknown>),
      shapes: {
        active: null,
        agentDefaults: {},
        autoFollowAgent: false,
      },
    });
  }
}

/**
 * Migration body: put `ui.statusBar` into its pins shape (`{ pins: [] }`) on an
 * EXISTING `ui` block. conf merges top-level defaults SHALLOWLY, so a `ui`
 * object already on disk never inherits the new nested `statusBar` default —
 * this supplies it. The whole-`ui`-absent case needs nothing: the shallow merge
 * brings in the default `ui`, pins included.
 *
 * Two cases, one write:
 *
 * 1. `ui.statusBar` absent (an upgrade from any released version) — seed
 *    `{ pins: [] }`.
 * 2. `ui.statusBar` holding the retired ten-boolean visibility shape — replace
 *    it with `{ pins: [] }`. **This drops the old show/hide choices rather than
 *    translating them, deliberately.** The semantics inverted: the ten booleans
 *    were subtractive (everything visible, hide what you don't want) and pins
 *    are additive (nothing but news, pin what you always want). Mapping
 *    "visible" to "pinned" would hand anyone still on the defaults ten pins and
 *    erase the quiet-by-default line the pins exist to serve, so this is a
 *    one-time reset (spec composer-status-redesign §5.1, DOR-452).
 *
 * The retired shape can only be on disk from a pre-release build: `ui.statusBar`
 * was introduced (as ten booleans) after v0.56.0 and never appeared in a tagged
 * release, so case 2 only ever fires on a machine that ran `main` between
 * DOR-431 and DOR-452. It is handled here rather than in a later key because the
 * booleans now violate the schema (`additionalProperties: false`, `pins`
 * required) and conf validates the whole store once migrations finish — leaving
 * them for a `0.58.0` key would hard-fail startup on any release cut as 0.57.0.
 *
 * Idempotent: a `statusBar` that already carries a `pins` array is left exactly
 * as it is, so re-running (corrupt-recovery, a hand-edited migration version)
 * never clears someone's pins.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateStatusBarToPins(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;

  const statusBar = (ui as { statusBar?: unknown }).statusBar;
  const alreadyPinned =
    statusBar !== null &&
    typeof statusBar === 'object' &&
    Array.isArray((statusBar as { pins?: unknown }).pins);
  if (alreadyPinned) return;

  store.set('ui', { ...(ui as Record<string, unknown>), statusBar: { pins: [] } });
}

/**
 * Migration body: backfill `ui.composer: { richText: false }` onto an EXISTING
 * `ui` block (the message box's formatting preference, DOR-948). conf merges
 * top-level defaults SHALLOWLY, so a `ui` object already on disk never inherits
 * a newly-added nested section; the whole-`ui`-absent case needs nothing,
 * because the shallow merge brings in the default `ui` with this section already
 * in it. Same shape and same reasoning as {@link migrateStatusBarToPins}.
 *
 * Seeds `false` — the plain markdown box everyone has today. An upgrade must
 * never change what someone's composer does under them; turning it on is the
 * person's choice, in Settings.
 *
 * Additive + idempotent: an existing `ui.composer` object is left exactly as it
 * stands, so re-running (corrupt-recovery, a hand-edited migration version)
 * never flips someone's preference back off.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillComposerPrefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;

  // The SCHEMA decides whether what is on disk is a `ComposerPrefs`, not
  // `typeof`. `typeof [] === 'object'`, so an on-disk `ui.composer: []` — or a
  // half-written object — would otherwise be left exactly where it is, and
  // conf's Ajv would condemn the whole config file on the next boot rather than
  // just this section (the DOR-584 lesson). Anything the schema rejects is
  // replaced with the shipped default; anything it accepts is left untouched,
  // which is what keeps this idempotent and keeps a person's `true` safe.
  //
  // `.strict()` because the generated JSON Schema for this object is
  // `additionalProperties: false` (verified, not assumed). A plain `safeParse`
  // would ACCEPT `{ rich: 'yes' }` — Zod strips unknown keys and fills the
  // default — and leave on disk exactly the shape Ajv is about to reject. The
  // check has to agree with the validator it is protecting against.
  const composer = (ui as { composer?: unknown }).composer;
  if (ComposerPrefsSchema.strict().safeParse(composer).success) return;

  store.set('ui', { ...(ui as Record<string, unknown>), composer: { richText: false } });
}

/**
 * Migration body: backfill `ui.autonomyAcknowledgedAt: null` onto an EXISTING
 * `ui` block (the standing Full-autonomy acknowledgement; spec `trust-dial`,
 * decision 5). conf merges top-level defaults SHALLOWLY, so a `ui` object
 * already on disk never inherits a newly-added nested key; the whole-`ui`-absent
 * case needs nothing, because the shallow merge brings in the default `ui` with
 * this key already in it.
 *
 * Seeds `null` — nobody has acknowledged anything. That direction is the whole
 * point: an upgrade must never hand out a consent nobody gave, so every
 * upgrading install sees the dialog the first time it reaches for Full autonomy,
 * exactly as a fresh one does.
 *
 * Additive + idempotent: an existing value, including one somebody has already
 * cleared back to `null`, is left exactly as it stands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillAutonomyAcknowledgement(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  if ('autonomyAcknowledgedAt' in (ui as Record<string, unknown>)) return;
  store.set('ui', { ...(ui as Record<string, unknown>), autonomyAcknowledgedAt: null });
}

/**
 * Migration body: backfill the DOR-339 display-filter/mute fields onto an
 * EXISTING `ui.sidebar` — `muted: []` and `ungroupedDisplayFilter: 'all'` on
 * the section itself, plus `displayFilter: 'all'` and `muted: false` on every
 * already-stored group. conf merges top-level defaults SHALLOWLY and never
 * reaches inside array elements at all, so a `ui.sidebar` already on disk —
 * including every group inside it — never inherits these new fields on its
 * own; this supplies them. Additive + idempotent: only writes a field that is
 * actually missing, never overwrites an existing value (a user who already
 * set a group's filter, or muted a group or agent, keeps that choice
 * untouched). The whole-section-absent case is handled by the schema default
 * on read (already yields these defaults) and by `backfillSidebarDefaults`
 * for an existing `ui` block with no `sidebar` at all.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarSettingsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;

  let groups = s.groups;
  let groupsChanged = false;
  if (Array.isArray(s.groups)) {
    groups = s.groups.map((g: unknown) => {
      if (!g || typeof g !== 'object') return g;
      const group = g as Record<string, unknown>;
      if (group.displayFilter !== undefined && group.muted !== undefined) return group;
      groupsChanged = true;
      return {
        ...group,
        displayFilter: group.displayFilter ?? 'all',
        muted: group.muted ?? false,
      };
    });
  }

  const needsSectionFields = s.muted === undefined || s.ungroupedDisplayFilter === undefined;
  if (!needsSectionFields && !groupsChanged) return;

  store.set('ui', {
    ...(ui as Record<string, unknown>),
    sidebar: {
      ...s,
      muted: s.muted ?? [],
      ungroupedDisplayFilter: s.ungroupedDisplayFilter ?? 'all',
      groups,
    },
  });
}

/**
 * Migration body: backfill the three room-section collapse flags onto an
 * EXISTING `ui.sidebar` — `channelsCollapsed` and `dmsCollapsed` (rooms sidebar,
 * DOR-525) and `threadsCollapsed` (the Threads section, room-messaging-design
 * §3), all `false`. conf merges top-level defaults SHALLOWLY, so a `ui.sidebar`
 * already on disk never inherits new nested fields on its own; this supplies
 * them. Additive + idempotent: only writes a field that is actually missing.
 *
 * `threadsCollapsed` joins the same unreleased key rather than taking one of
 * its own: it is the identical backfill on the identical object, and a second
 * function would run a second write for the same reason.
 * The whole-section-absent case is handled by the schema default on read and by
 * `backfillSidebarDefaults` for an existing `ui` block with no `sidebar`.
 *
 * Both start expanded. A person upgrading into this release should SEE the two
 * new sections rather than have to discover two collapsed headers.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarRoomSections(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (
    s.channelsCollapsed !== undefined &&
    s.dmsCollapsed !== undefined &&
    s.threadsCollapsed !== undefined
  ) {
    return;
  }

  store.set('ui', {
    ...(ui as Record<string, unknown>),
    sidebar: {
      ...s,
      channelsCollapsed: s.channelsCollapsed ?? false,
      dmsCollapsed: s.dmsCollapsed ?? false,
      threadsCollapsed: s.threadsCollapsed ?? false,
    },
  });
}

/**
 * Migration body: backfill the `connectors` section (`rawMcpServers`, the
 * remote MCP servers the raw-MCP connector offers; connector-completion spec)
 * for configs persisted before it existed. Additive + idempotent: only writes
 * when the key is absent; the schema default also yields `{ rawMcpServers: [] }`
 * on read, so this just writes it through on the upgrade where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `has`/`set`).
 */
export function backfillConnectorsDefaults(store: {
  has: (key: string) => boolean;
  set: (key: string, value: unknown) => void;
}): void {
  if (!store.has('connectors')) {
    store.set('connectors', { rawMcpServers: [] });
  }
}

/**
 * Migration body: backfill the `rooms` section (the cascade ceiling agents
 * reply within, DOR-526) for configs persisted before it existed. Additive +
 * idempotent: only writes when the key is absent; the schema default also
 * yields this object on read, so this just writes it through on the upgrade
 * where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRoomsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const seeded = {
    maxAgentDepth: 3,
    maxAutomaticTurnsPerRoomPerHour: 60,
    maxAutomaticTurnsTotalPerHour: 240,
    replyWaitMinutes: 10,
    lateReplyCeilingMinutes: 60,
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
  };
  const rooms = store.get('rooms');
  if (rooms == null) {
    store.set('rooms', seeded);
    return;
  }
  // conf merges top-level defaults SHALLOWLY, so a `rooms` block already on disk
  // never inherits a new nested field on its own. Supplying them here is what
  // stops an upgrade landing with no spend cap at all.
  const current = { ...(rooms as Record<string, unknown>) };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  // `maxAutomaticTurnsPerHour` only ever existed on unreleased builds of this
  // feature; it was split into the per-room and total caps before shipping.
  // Carry its value onto the per-room cap rather than silently resetting a
  // number somebody chose, then drop it so the schema stops rejecting it.
  if (current.maxAutomaticTurnsPerHour !== undefined) {
    if (typeof current.maxAutomaticTurnsPerHour === 'number') {
      current.maxAutomaticTurnsPerRoomPerHour = current.maxAutomaticTurnsPerHour;
    }
    delete current.maxAutomaticTurnsPerHour;
    changed = true;
  }
  if (changed) store.set('rooms', current);
}

/**
 * Migration body: backfill the `welcomeBack` section (what agents may say when
 * you come back after being away; spec `team-room-home`, D5.2) for configs
 * persisted before it existed.
 *
 * Additive + idempotent: writes the whole section when it is absent, and fills
 * only the individual keys that are missing when it is present. conf merges
 * top-level defaults SHALLOWLY, so a `welcomeBack` block already on disk — from
 * an unreleased build, or from a later key being added to it — never inherits a
 * new nested field on its own. Filling here is what stops a return running with
 * no post cap at all — and, since DOR-1046, with no answer at all to whether a
 * greeting may spend a model turn on a next-step offer.
 *
 * `offersEnabled` seeds `false`, which is the only safe direction: it is the one
 * leaf in this block that costs money, so an upgrade must never be the thing
 * that turns it on. It is filled the same way as its siblings, so somebody who
 * turned offers ON keeps them.
 *
 * Nothing depends on this having run: every leaf carries a Zod default, so an
 * install that skips the migration (a dev tree resolves `SERVER_VERSION` to
 * `0.0.0` and runs none of them) still reads the same shipped values.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWelcomeBackDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const seeded = {
    enabled: true,
    absenceThresholdMinutes: 240,
    maxPosts: 3,
    offersEnabled: false,
  };
  const stored = store.get('welcomeBack');
  if (stored == null || typeof stored !== 'object') {
    store.set('welcomeBack', seeded);
    return;
  }
  const current = { ...(stored as Record<string, unknown>) };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  if (changed) store.set('welcomeBack', current);
}

/**
 * Migration body: backfill `kind: 'manual'` onto every EXISTING stored group
 * (smart-agent-groups, DOR-338). conf merges top-level defaults SHALLOWLY and
 * never reaches inside array elements, so a `ui.sidebar.groups` array already
 * on disk never inherits the new `kind` discriminator on its own — every
 * pre-DOR-338 group would read back with `kind: undefined` even though the
 * `SidebarGroupSchema` type says it's always `'manual' | 'smart'`. Additive +
 * idempotent: only writes `kind` when it is actually missing, never touches
 * `rules` (absent is correct for a manual group). The whole-`ui`/whole-section
 * -absent cases are handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSmartGroupKindDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (!Array.isArray(s.groups)) return;

  let changed = false;
  const groups = s.groups.map((g: unknown) => {
    if (!g || typeof g !== 'object') return g;
    const group = g as Record<string, unknown>;
    if (group.kind !== undefined) return group;
    changed = true;
    return { ...group, kind: 'manual' };
  });
  if (!changed) return;

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: { ...s, groups } });
}

/**
 * Migration body: convert the three sidebar membership lists from bare agent
 * `projectPath` strings to `SidebarItemRef` objects, and rename
 * `groups[].agentPaths` to `groups[].items` (sidebar-groups, DOR-579).
 *
 * `ui.sidebar.pinned`, `ui.sidebar.muted` and every group's member list used to
 * hold a `string[]` of agent paths, which left nowhere to reference a room (a
 * room has a ULID, not a path). They now hold
 * `{ kind: 'agent'; path } | { kind: 'room'; roomId }`.
 *
 * **The rename is not additive, so this backfill is load-bearing.** Without it
 * an upgraded config reads back with `items` absent, takes the Zod default of
 * `[]`, and every group silently empties while the real data sits in an
 * `agentPaths` key nothing reads. It is keyed to the release that ships the new
 * schema for exactly that reason.
 *
 * The mapping is total: every string in these arrays predates rooms in the
 * sidebar, so all of them ARE agent paths and none can be misread. Idempotent —
 * an entry that is already an object passes through untouched, a group that
 * already has `items` keeps it, and a run that finds nothing to convert writes
 * nothing. `agentPaths` is dropped rather than left beside `items`: the
 * generated JSON Schema closes each group object, so a leftover key would fail
 * validation on the first read after the migration.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateSidebarMembersToItemRefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  let changed = false;

  /**
   * Wrap each stored path; anything already an object is a ref and passes
   * through. Delegates to the shared {@link toSidebarItemRef} so this file and
   * the read-time `normalizeSidebarPrefs` conversion state the rule once.
   */
  const toItemRefs = (value: unknown): unknown[] =>
    (Array.isArray(value) ? value : []).map((entry) =>
      toSidebarItemRef(entry as SidebarItemRef | string)
    );
  /** Whether a list still holds the pre-DOR-579 shape (and so needs converting). */
  const hasStringEntry = (value: unknown): boolean =>
    Array.isArray(value) && value.some((entry) => typeof entry === 'string');

  const next: Record<string, unknown> = { ...s };

  for (const field of ['pinned', 'muted'] as const) {
    if (!hasStringEntry(s[field])) continue;
    next[field] = toItemRefs(s[field]);
    changed = true;
  }

  if (Array.isArray(s.groups)) {
    next.groups = s.groups.map((g: unknown) => {
      if (!g || typeof g !== 'object') return g;
      const group = g as Record<string, unknown>;
      if (!('agentPaths' in group) && !hasStringEntry(group.items)) return group;
      changed = true;
      const { agentPaths, ...rest } = group;
      return {
        ...rest,
        // An existing `items` wins over a leftover `agentPaths`: only a config
        // written before DOR-579 carries the old key, so the two can never hold
        // different truths, and preferring `items` keeps a re-run from
        // resurrecting a list the person has since edited.
        items: toItemRefs(group.items ?? agentPaths),
      };
    });
  }

  if (!changed) return;

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: next });
}

/**
 * The suggestion id the "group your agents" hint card became when Getting
 * started absorbed it (`specs/sidebar-now-today-library` §B). A person who
 * dismissed the card has already answered that suggestion, so the migration
 * records the dismissal as a retirement rather than asking again.
 */
export const GROUPS_HINT_SUGGESTION_ID = 'suggestion:groups-hint';

/**
 * The eight `ui.sidebar` keys the sidebar redesign retired, paired with the
 * section id each collapse flag becomes. Named once so the migration, the Ajv
 * tolerance below and the tests all read the same list.
 */
const RETIRED_SIDEBAR_COLLAPSE_KEYS = {
  ungroupedCollapsed: 'agents',
  channelsCollapsed: 'channels',
  dmsCollapsed: 'dms',
  threadsCollapsed: 'threads',
  recentsCollapsed: 'recents',
} as const;

/** Every key {@link migrateSidebarSectionPrefs} removes, collapse flags included. */
const RETIRED_SIDEBAR_KEYS = [
  ...Object.keys(RETIRED_SIDEBAR_COLLAPSE_KEYS),
  'ungroupedSortMode',
  'ungroupedDisplayFilter',
  'groupsHintDismissed',
] as const;

/**
 * Migration body: move the sidebar's seven per-section flags into the
 * `ui.sidebar.sections` record, translate the groups-hint dismissal into a
 * retired Getting-started suggestion, and delete all eight retired keys
 * (`specs/sidebar-now-today-library` §D, the table there is authoritative).
 *
 * | Retired key                | Becomes                                       |
 * | -------------------------- | --------------------------------------------- |
 * | `ungroupedCollapsed`       | `sections.agents.collapsed`                   |
 * | `channelsCollapsed`        | `sections.channels.collapsed`                 |
 * | `dmsCollapsed`             | `sections.dms.collapsed`                      |
 * | `threadsCollapsed`         | `sections.threads.collapsed`                  |
 * | `recentsCollapsed`         | `sections.recents.collapsed`                  |
 * | `ungroupedSortMode`        | `sections.agents.sortMode`                    |
 * | `ungroupedDisplayFilter`   | `sections.agents.displayFilter`               |
 * | `groupsHintDismissed: true`| `gettingStarted.retired += 'suggestion:…'`    |
 *
 * `pinned`, `groups` and `muted` are not touched at all. They are the person's
 * own manual structure, and the programme's promise is that it never moves.
 *
 * **A stored value equal to its old default is not carried across**, because on
 * both sides of this migration an absent key and the default mean the same
 * thing: `collapsed` reads `false` when the section is absent, and the Agents
 * section's sort and filter fall back to `name` / `all`. Copying them would
 * write a block of defaults into every config on earth to say nothing. What a
 * person actually changed is what moves.
 *
 * **Anything already in `sections` wins.** Someone who ran this, downgraded and
 * upgraded again has a `sections` record built from choices made SINCE the
 * retired flags were last written, so a stale flag must not overwrite it.
 *
 * Idempotent by construction: the whole body is gated on at least one retired
 * key still being present, and the run that carries them across is also the run
 * that deletes them — so a second run finds nothing and writes nothing.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateSidebarSectionPrefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (!RETIRED_SIDEBAR_KEYS.some((key) => key in s)) return;

  const storedSections = s.sections;
  const sections: Record<string, Record<string, unknown>> = storedSections &&
  typeof storedSections === 'object' &&
  !Array.isArray(storedSections)
    ? Object.fromEntries(
        Object.entries(storedSections as Record<string, unknown>).map(([id, value]) => [
          id,
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>) }
            : {},
        ])
      )
    : {};

  /** Write one section field, unless the section already answers for it. */
  const carry = (id: string, field: string, value: unknown): void => {
    const section = (sections[id] ??= {});
    if (field in section) return;
    section[field] = value;
  };

  for (const [flag, id] of Object.entries(RETIRED_SIDEBAR_COLLAPSE_KEYS)) {
    if (s[flag] === true) carry(id, 'collapsed', true);
  }
  if (s.ungroupedSortMode === 'recent') carry('agents', 'sortMode', 'recent');
  if (s.ungroupedDisplayFilter === 'active' || s.ungroupedDisplayFilter === 'attention') {
    carry('agents', 'displayFilter', s.ungroupedDisplayFilter);
  }
  // `carry` seeds an empty object for a section it is asked about; drop any that
  // ended up with nothing to say rather than persisting `{}`.
  for (const [id, section] of Object.entries(sections)) {
    if (Object.keys(section).length === 0) delete sections[id];
  }

  const storedGettingStarted = s.gettingStarted;
  const retired =
    storedGettingStarted &&
    typeof storedGettingStarted === 'object' &&
    Array.isArray((storedGettingStarted as { retired?: unknown }).retired)
      ? [...((storedGettingStarted as { retired: unknown[] }).retired as unknown[])]
      : [];
  if (s.groupsHintDismissed === true && !retired.includes(GROUPS_HINT_SUGGESTION_ID)) {
    retired.push(GROUPS_HINT_SUGGESTION_ID);
  }

  const next: Record<string, unknown> = { ...s, sections, gettingStarted: { retired } };
  for (const key of RETIRED_SIDEBAR_KEYS) delete next[key];

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: next });
}

/**
 * Migration body: scrub retired onboarding step ids from a persisted
 * `onboarding` block. The first-run flow was shortened, narrowing
 * `ONBOARDING_STEPS` from four values to two — `'tasks'` and `'adapters'` no
 * longer exist. A config carrying either in `completedSteps`/`skippedSteps`
 * (most upgraders do: the old finish path recorded a synthetic `'adapters'`
 * completion) would fail the narrowed enum's final validation, so this filters
 * both arrays down to the still-valid set.
 *
 * Additive-safe + idempotent: only rewrites an array when it actually contains a
 * retired value, so re-running is a no-op. conf skips validation during
 * migrations, so the stale values pass through every earlier migration's writes
 * unharmed; this body just has to run before the single post-migration validate.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function scrubRetiredOnboardingSteps(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const onboarding = store.get('onboarding');
  if (onboarding == null || typeof onboarding !== 'object') return;
  const valid = new Set<string>(ONBOARDING_STEPS);
  const o = onboarding as Record<string, unknown>;
  let changed = false;
  const next = { ...o };
  // The old flow's finish path recorded a synthetic 'adapters' completion, so
  // its presence means this user already finished onboarding. Backfill the new
  // authoritative signal BEFORE scrubbing it away, or every already-onboarded
  // user would be re-onboarded on upgrade.
  const completed = Array.isArray(o.completedSteps) ? o.completedSteps : [];
  if (completed.includes('adapters') && typeof o.completedAt !== 'string') {
    next.completedAt = typeof o.startedAt === 'string' ? o.startedAt : new Date().toISOString();
    changed = true;
  }
  for (const field of ['completedSteps', 'skippedSteps'] as const) {
    const arr = o[field];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((step) => typeof step === 'string' && valid.has(step));
    if (filtered.length !== arr.length) {
      next[field] = filtered;
      changed = true;
    }
  }
  if (changed) store.set('onboarding', next);
}

/**
 * Migration body: backfill the `profile` section (who the user is — roles,
 * tools, display name; spec `user-profile-onboarding`) for configs persisted
 * before it existed. Additive + idempotent: only writes when the key is absent;
 * conf's top-level defaults-merge also yields this object on read, so this is a
 * no-op anchor that writes the key through on the upgrade where it lands. Seeds
 * everything empty/null: DorkOS knows nothing about the person until they say.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillProfileDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('profile') == null) {
    store.set('profile', { roles: [], tools: [], displayName: null, rolePromptDismissedAt: null });
  }
}

/**
 * Migration body: backfill `runtimes.claudeCode` — which Claude account new
 * sessions run and bill on, and the accounts DorkOS knows about (spec
 * `claude-code-accounts` D1) — onto an EXISTING `runtimes` block.
 *
 * conf merges top-level defaults SHALLOWLY, so a `runtimes` object already on
 * disk never inherits a newly-added nested section on its own, and every install
 * upgraded past the `0.45.0` backfill has one. Ajv does fill the key in at READ
 * time, but that fill is not written back (conf's `Object.assign` shares the
 * section object, so the `deepEqual` short-circuit leaves the file sparse), which
 * is why this writes it through on the upgrade where it lands — the same
 * no-op-anchor role {@link backfillProfileDefaults} plays for its section.
 *
 * Additive + idempotent: only writes when `claudeCode` is absent, and never
 * touches `default`, `opencode` or `codex`. The whole-`runtimes`-absent case
 * belongs to the schema default on read plus {@link backfillRuntimesDefaults}.
 *
 * Seeds `{ activeAccount: null, accounts: [] }` — no account chosen and none
 * registered, which is byte-for-byte the behavior before the field existed: the
 * inherited `$CLAUDE_CONFIG_DIR`, else `~/.claude`. An upgrade therefore never
 * moves anybody's work onto a different account.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillClaudeCodeRuntimeDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  if ('claudeCode' in runtimes) return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { activeAccount: null, accounts: [] },
  });
}

/**
 * @internal Exported for testing only — lets the migration-key invariant test
 * assert the newest key is always ahead of the current release (the DOR-339
 * "0.54.0 shipped mid-flight" class of bug: a key equal to or behind an
 * already-tagged version is silently excluded by conf's `(storedVersion,
 * projectVersion]` window, so it never runs for upgrading users).
 */
/**
 * Migration body: backfill the per-runtime execution defaults
 * (`defaultModel` on all three runtime sections, `defaultEffort` on claude-code
 * and codex only) onto `runtimes` blocks already on disk.
 *
 * Needed for the same reason {@link backfillClaudeCodeRuntimeDefaults} is:
 * conf's defaults-merge is SHALLOW, so an existing `runtimes.claudeCode` object
 * never gains a new nested key from the schema default alone.
 *
 * Additive + idempotent — each leaf is written only when absent, and every value
 * is `null`, which means "let the runtime choose". An upgrade therefore starts
 * nobody's sessions on a model they did not pick.
 *
 * OpenCode deliberately gets `defaultModel` and no `defaultEffort`: its prompt API
 * accepts no effort, so the field would be a setting that does nothing.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRuntimeExecutionDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;

  /** Add the named leaves to one runtime section, leaving anything already set alone. */
  const seed = (section: string, leaves: readonly string[]): Record<string, unknown> | null => {
    const value = current[section];
    if (value == null || typeof value !== 'object') return null;
    const block = value as Record<string, unknown>;
    const missing = leaves.filter((leaf) => !(leaf in block));
    if (missing.length === 0) return null;
    return { ...block, ...Object.fromEntries(missing.map((leaf) => [leaf, null])) };
  };

  const claudeCode = seed('claudeCode', ['defaultModel', 'defaultEffort']);
  const codex = seed('codex', ['defaultModel', 'defaultEffort']);
  const opencode = seed('opencode', ['defaultModel']);
  if (!claudeCode && !codex && !opencode) return;

  store.set('runtimes', {
    ...current,
    ...(claudeCode ? { claudeCode } : {}),
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
  });
}

/**
 * Migration body: backfill the default-trust-stop leaves — the global
 * `runtimes.defaultTrustStop` and the per-runtime override on each of the three
 * runtime sections (spec `trust-dial`, decision 6).
 *
 * Needed for the same reason {@link backfillRuntimeExecutionDefaults} is: conf's
 * defaults-merge is SHALLOW, so a `runtimes` block already on disk never gains a
 * new key — nested or top-level — from the schema default alone.
 *
 * Additive + idempotent: every leaf is written only when absent, and every value
 * is `null`, which means "let the runtime decide". An upgrade therefore never
 * moves anybody's new sessions to a stop they did not choose, least of all the
 * one that stops asking.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillDefaultTrustStops(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;

  /** The section object with `defaultTrustStop: null` added, or null when it already has one. */
  const seed = (section: string): Record<string, unknown> | null => {
    const value = current[section];
    if (value == null || typeof value !== 'object') return null;
    const block = value as Record<string, unknown>;
    if ('defaultTrustStop' in block) return null;
    return { ...block, defaultTrustStop: null };
  };

  const claudeCode = seed('claudeCode');
  const codex = seed('codex');
  const opencode = seed('opencode');
  const global = 'defaultTrustStop' in current ? null : { defaultTrustStop: null };
  if (!claudeCode && !codex && !opencode && !global) return;

  store.set('runtimes', {
    ...current,
    ...(global ?? {}),
    ...(claudeCode ? { claudeCode } : {}),
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
  });
}

/**
 * The `conf` migration chain, keyed by the app version each entry ships in.
 *
 * ## Where a new migration goes
 *
 * Under a NEW key strictly greater than the newest `v*` tag in the repository
 * (`git tag -l 'v*' | sort -V | tail -1`). Nothing else is safe, for one reason:
 * `conf` runs a key only when `storedVersion < key <= projectVersion`. So a key
 * at or below a version that already shipped is skipped for everybody already on
 * it — no error, no warning, the backfill simply never happens (DOR-339).
 *
 * Two things follow, and both have been got wrong here before:
 *
 * - **Never append to a key that has shipped.** The key being present is not the
 *   point; the BODY is what runs. Appending to an already-tagged composite key
 *   ships dead code that looks alive (DOR-988).
 * - **Never edit a shipped migration body.** Everyone who upgraded past it ran
 *   the old body, and no re-run is coming. Write a new, idempotent entry that
 *   corrects the state instead.
 *
 * Both rules are enforced: `__tests__/migration-safety.ts` compares every key's
 * source text against the newest release tag, and `config-manager.test.ts` runs
 * that comparison over the real repository on every CI run.
 *
 * ## The comparison is byte-identity, so a shipped body's COMMENTS are frozen too
 *
 * Deliberate. A rule that skipped comments would need a parser deciding which
 * lines are code, and "an appended line the parser mis-read as a comment" is the
 * same class of hole this guard exists to close. The consequence is that a stale
 * sentence inside a shipped body cannot be corrected in place: `'0.57.0'` still
 * carries one, pointing at the composition convention this docblock replaced.
 * Correct that kind of thing HERE, or in the comment directly above the key
 * (both sit outside every key's slice), not inside the body.
 */
export const CONFIG_MIGRATIONS = {
  '1.0.0': (store: {
    has: (key: string) => boolean;
    set: (key: string, value: unknown) => void;
  }) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
  // Backfill `extensions.disabled: []` for configs persisted before the two-list
  // deviation model (Core Extensions). Resolved from a `<next-release>` placeholder
  // to v0.44.0 at release time (/system:release). Additive + idempotent; the schema
  // default also yields `disabled: []` on read, so this just writes the key through
  // on the upgrade where it lands.
  '0.44.0': backfillExtensionsDisabled,
  // Everything below shipped together in v0.45.0. Each body was authored on a
  // placeholder "next ascending release" key (0.45.0-0.53.0) while on main, and
  // the keys were collapsed onto the one real release when it was tagged
  // (2026-07-09) — by hand, during that release. Nothing renames a stale key for
  // you, which is why the placeholder convention is retired (see the rule on
  // CONFIG_MIGRATIONS above). Order matters: conf runs entries in insertion order, and
  // `backfillWorkbenchTerminalGraceTtl` must follow `backfillWorkbenchDefaults`.
  // Every body is idempotent, so re-running the composite is safe.
  '0.45.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  }) => {
    // `workspace` section (WorkspaceManager, DOR-84).
    backfillWorkspaceDefaults(store);
    // `harness` section (Harness Sync auto-sync gate, GAP-4).
    backfillHarnessDefaults(store);
    // `runtimes` section (multi-runtime support, DOR-180).
    backfillRuntimesDefaults(store);
    // Credential substrate (`providers` registry, DOR-183, ADR-0315). Seeds
    // only references/nulls, never a plaintext secret.
    backfillProvidersDefaults(store);
    // `auth` section (local login gate, accounts-and-auth P1).
    backfillAuthDefaults(store);
    // Remove tunnel passcode fields + root `sessionSecret` (accounts-and-auth
    // P1, task 1.6). Better Auth replaced them; stale hashes are discarded,
    // not migrated.
    dropTunnelPasscodeAndSessionSecret(store);
    // `cloud` section (device-link instance token, accounts-and-auth P2).
    backfillCloudDefaults(store);
    // `workbench` section (viewer-registry overrides, DOR-219).
    backfillWorkbenchDefaults(store);
    // `workbench.terminalGraceTtlMinutes` (terminal re-attach grace window,
    // DOR-225) — supplies the nested field conf's shallow defaults-merge won't
    // add to a `workbench` block the previous body just created.
    backfillWorkbenchTerminalGraceTtl(store);
  },
  // Both authored under the RETIRED placeholder convention (see the rule on
  // CONFIG_MIGRATIONS above): a "next ascending release" key, on the belief that
  // /system:release would reconcile it at tag time. It does not — it scaffolds a
  // migration for the release version or confirms one already there, and never
  // renames an existing key. Shipped and frozen; recorded, not endorsed. One
  // composite body (an object literal can't repeat the key); order is insertion
  // order and both are idempotent + independent.
  '0.46.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  }) => {
    // Generalize `telemetry` into the shared opt-in consent namespace (DOR-293,
    // ADR 260711-141639): rename `telemetry.enabled` → `telemetry.install` and
    // backfill the new `heartbeat` + `errorReporting` channel flags (both OFF).
    generalizeTelemetryConsent(store);
    // `workbench.autoOpenDiff` (auto-open the diff review surface on agent
    // edits, DOR-212).
    backfillWorkbenchAutoOpenDiff(store);
  },
  // Reconciled from the `0.47.0` placeholder to `0.48.0` at release time
  // (DOR-315 watch-item): a `v0.47.0` tag briefly existed on a divergent commit,
  // so the telemetry backfills ship in 0.48.0 — keying them here guarantees
  // every 0.46.0 -> 0.48.0 upgrade actually runs them.
  '0.48.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // Backfill `telemetry.lastPromptedVersion` (consent re-prompt anchor,
    // DOR-312, ADR 260713-143958 Phase 1). Additive + idempotent; seeds `null`.
    backfillTelemetryLastPromptedVersion(store);
    // Flip the Tier 1 channels (`install`, `heartbeat`) to opt-out for
    // never-answered installs (DOR-314, ADR 260713-143958 Phase 2). Preserves an
    // explicit prior choice; the notice-before-first-send gate still applies.
    applyTier1OptOutDefaults(store);
    // Backfill `telemetry.usage` (anonymous feature-usage channel, DOR-315,
    // ADR 260713-143958 Phase 3). Additive + idempotent; already-decided
    // installs start OFF, never-answered take the Tier 1 default ON.
    backfillTelemetryUsageChannel(store);
    // Backfill `telemetry.linkAnalyticsToAccount` (device-link analytics merge
    // opt-in, DOR-320, ADR 260713-143958 Phase 4). Additive + idempotent; Tier 2
    // opt-in, so every upgraded install starts OFF regardless of prior choice.
    backfillTelemetryLinkAnalyticsToAccount(store);
    // Backfill `telemetry.aiMetadata` (opt-in AI-run metadata bridge, DOR-319,
    // ADR 260713-143958 Phase 7). Additive + idempotent; Tier 2 opt-in, so it
    // seeds OFF for every existing install regardless of a prior consent choice.
    backfillTelemetryAiMetadataChannel(store);
  },
  // Backfill `ui.sidebar` (server-persisted sidebar organization — groups,
  // pinned, per-section sort/collapse; DOR-329) onto an existing `ui` block.
  // Additive + idempotent; seeds an empty, unorganized sidebar.
  '0.50.0': backfillSidebarDefaults,
  // Backfill `ui.shapes` (person-scoped Shape state — active Shape, reverse
  // affinity hints, follow toggle; DOR-355) onto an existing `ui` block.
  // Additive + idempotent; seeds no active Shape. Keyed under the RETIRED
  // placeholder convention (see the rule on CONFIG_MIGRATIONS above), on the
  // belief that /system:release reconciles a stale key at tag time. It does not.
  // Shipped and frozen; recorded, not endorsed.
  '0.52.0': backfillShapesDefaults,
  // Composite: both DOR-339 and DOR-338 targeted "the next unreleased version"
  // while developed concurrently and landed on the same key (0.55.0) — a plain
  // object literal can't repeat a key, so their bodies compose here in insertion
  // order. That composition is a RECORD of the retired convention, not a pattern
  // to copy: composing into a key is only ever safe while it is unreleased, and
  // this one shipped. Concurrent work now opens separate keys above the newest
  // tag (see the rule on CONFIG_MIGRATIONS above). Each body is independent and
  // idempotent.
  '0.55.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // Backfill the DOR-339 display-filter/mute fields (`ui.sidebar.muted`,
    // `ui.sidebar.ungroupedDisplayFilter`, and `displayFilter`/`muted` on
    // every stored group) onto an existing `ui.sidebar`. Additive +
    // idempotent; every filter defaults to 'all' and nothing starts muted.
    backfillSidebarSettingsDefaults(store);
    // Backfill `kind: 'manual'` onto every existing stored group
    // (smart-agent-groups, DOR-338). Additive + idempotent; runs AFTER the
    // DOR-339 backfill above so it sees the same groups array (order is
    // immaterial here since the two bodies touch disjoint fields, but
    // matches the "append yours after it" sequencing).
    backfillSmartGroupKindDefaults(store);
    // Scrub retired onboarding step ids (`'tasks'`, `'adapters'`) from
    // `onboarding.completedSteps`/`skippedSteps` so the narrowed
    // `ONBOARDING_STEPS` enum's final validation never rejects an upgraded
    // config (shorter first-run flow). Additive-safe + idempotent.
    scrubRetiredOnboardingSteps(store);
  },
  // Composite: DOR-452, DOR-501, DOR-516, DOR-522, DOR-525, DOR-526 and DOR-579
  // all landed before v0.57.0 was tagged, and an object literal cannot repeat a
  // key, so their bodies composed here in insertion order — the same convention
  // as the 0.45.0/0.46.0/0.48.0/0.55.0 composites above. All seven are
  // independent and idempotent.
  //
  // THIS KEY HAS SHIPPED. Do not append a body to it. v0.57.0 is tagged, so
  // every user who upgraded past it already ran what was here at tag time and
  // will never run anything added now — `conf` only runs a key in
  // `(storedVersion, projectVersion]`. Open a NEW key above the newest `v*` tag
  // instead; see the authoring rule on `CONFIG_MIGRATIONS` above.
  '0.57.0': (store: {
    get: (key: string) => unknown;
    has: (key: string) => boolean;
    set: (key: string, value: unknown) => void;
  }) => {
    // Put `ui.statusBar` into its pins shape on an existing `ui` block —
    // status-bar preferences live in server config so devices/agents can read +
    // flip them (DOR-431), and the line is now quiet by default with an additive
    // pin list instead of ten subtractive visibility booleans (DOR-452). Seeds
    // nothing pinned, and drops the retired booleans on the one machine shape
    // that can still carry them (see `migrateStatusBarToPins` for why the reset
    // is deliberate and why it is not deferred to a later key).
    migrateStatusBarToPins(store);
    // `approvals` section (standing permissions, DOR-501). Additive +
    // idempotent; seeds the feature OFF, so an upgrade never relaxes the gate.
    backfillApprovalsDefaults(store);
    // `extensions.approvedToRun` (extension load approval, DOR-516). Additive +
    // idempotent; seeds the list EMPTY, so an upgrade never hands out an approval
    // nobody gave.
    backfillExtensionsApprovedToRun(store);
    // `harness.approvedHooks` (a package writing shell commands into a coding
    // agent's hook files, DOR-522). Additive + idempotent; seeds the list EMPTY,
    // so an upgrade never hands out an approval nobody gave.
    backfillHarnessApprovedHooks(store);
    // `ui.sidebar.channelsCollapsed` / `dmsCollapsed` / `threadsCollapsed` (the
    // Channels, Direct messages and Threads sections; DOR-525 and the room
    // messaging design §3). Additive + idempotent; all seed expanded so an
    // upgrade shows the new sections rather than hiding them.
    backfillSidebarRoomSections(store);
    // The `rooms` section (DOR-526): `maxAgentDepth`, how far agents may reply
    // to each other before a room stops them, plus the two spend caps that hold
    // whoever the caller claims to be — per room, and across the whole install.
    // Extended by DOR-621 with the two turn-wait bounds (`replyWaitMinutes`,
    // `lateReplyCeilingMinutes`), and again by RP4 with the two engaged-window
    // ceilings (`engagedWindowMinutes`, `engagedWindowPosts`), all of which ship
    // in this same unreleased key.
    // Additive + idempotent; seeds the shipped defaults, so every bound is on
    // for every upgraded install.
    backfillRoomsDefaults(store);
    // Return the Tier 1 telemetry channels to opt-in for every install that
    // never answered a consent prompt (ADR 260727-181825). Reverses the 0.48.0
    // enrolment for that population only; an explicit choice, either way, is
    // left exactly as it stands.
    applyTier1OptInDefaults(store);
    // Convert `ui.sidebar.pinned`, `ui.sidebar.muted` and every group's member
    // list from agent-path strings to `SidebarItemRef` objects, renaming
    // `groups[].agentPaths` -> `groups[].items` (sidebar-groups, DOR-579).
    // Idempotent, but NOT additive: this is a rename, so an install that skips
    // it reads `items` as the schema default `[]` and loses its groups. Runs
    // after the sidebar backfills above so it sees the same `ui.sidebar` object
    // (order is otherwise immaterial — they touch disjoint fields).
    migrateSidebarMembersToItemRefs(store);
    // The `profile` section (who the user is; spec user-profile-onboarding).
    // Added-with-defaults, so this is a no-op anchor: conf's defaults-merge
    // supplies the block on read, and this writes it through on the upgrade
    // where it lands. Composed into this same next-unreleased key per
    // .claude/rules/safe-defaults.md (a fresh key above the release that ships
    // the schema would never run).
    backfillProfileDefaults(store);
    // The `connectors` section (`rawMcpServers`, connector-completion spec):
    // the remote MCP servers the raw-MCP connector offers as connectable
    // services. Additive + idempotent; seeds the list EMPTY, so an upgrade
    // never grants a tool endpoint nobody configured. Independent of the
    // profile backfill above — disjoint fields, order-immaterial.
    backfillConnectorsDefaults(store);
    // `runtimes.claudeCode` (which Claude account new sessions run and bill on;
    // spec claude-code-accounts). Supplies the nested section conf's shallow
    // defaults-merge will not add to a `runtimes` block already on disk.
    // Additive + idempotent; seeds "no account chosen, none registered", which
    // is exactly today's inherit-the-environment behavior.
    backfillClaudeCodeRuntimeDefaults(store);
    // The per-runtime execution defaults (`defaultModel` everywhere,
    // `defaultEffort` on claude-code and codex; spec execution-defaults E1).
    // Runs AFTER the claudeCode backfill above so the section it seeds into
    // exists on every config. Additive + idempotent; every leaf seeds `null`,
    // which is "let the runtime choose" — today's behavior exactly.
    backfillRuntimeExecutionDefaults(store);
    // `ui.autonomyAcknowledgedAt` (the standing Full-autonomy acknowledgement;
    // spec `trust-dial`, decision 5). Additive + idempotent; seeds `null`, so an
    // upgrade never hands out a consent nobody gave and everyone meets the
    // dialog once before their first Full-autonomy session.
    backfillAutonomyAcknowledgement(store);
    // The default trust stops (`runtimes.defaultTrustStop` and the per-runtime
    // override on each section; spec `trust-dial`, decision 6). Runs AFTER the
    // two `runtimes` backfills above so it seeds into the same sections they
    // guarantee exist. Additive + idempotent; every leaf seeds `null`, which
    // leaves each runtime starting new sessions exactly where it does today.
    backfillDefaultTrustStops(store);
  },
  // v0.58.0 is tagged and `package.json` reads 0.58.0, so the next key that can
  // still run for everybody is 0.59.0 — strictly above the newest `v*` tag, and
  // not the current version (`conf` runs a key only in
  // `(storedVersion, projectVersion]`). Enforced by
  // `__tests__/migration-safety.ts`. Two changes landed in the same release
  // window and share this key; both are additive + idempotent.
  '0.59.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // The `welcomeBack` section (what agents may say when you come back after
    // being away; spec `team-room-home`, D5.2). Seeds the shipped defaults, so
    // an upgraded install gets the same caps a fresh one does — including
    // `offersEnabled: false` (DOR-1046), which is folded into this key rather
    // than given one of its own for the reason the sidebar body below states:
    // it ships in this same still-unreleased window (`v0.58.0` is the newest
    // tag), so a key above it would be one more version boundary for a leaf
    // whose whole job is to seed OFF.
    backfillWelcomeBackDefaults(store);
    // `ui.composer` (whether the message box shows formatting as you type,
    // DOR-948). Added-with-defaults, so this is a no-op anchor in the same sense
    // `backfillProfileDefaults` is: conf builds Ajv with `useDefaults`, so the
    // declared default is written into a stored `ui` block during validation
    // whether or not this runs. It writes the section through on the upgrade
    // where it lands, which keeps the intent — seeded OFF — reviewable in the
    // table rather than implicit in a schema default. Additive + idempotent.
    backfillComposerPrefs(store);
    // Move the sidebar's seven per-section flags into `ui.sidebar.sections`,
    // record a dismissed groups hint as a retired Getting-started suggestion,
    // and delete all eight retired keys (spec `sidebar-now-today-library` §D).
    // Composed into this still-unreleased key rather than a fresh one above it
    // BECAUSE the schema that removes those keys ships in this same release: a
    // key of its own would leave everyone upgrading into 0.59.0 with a config
    // the new schema no longer describes.
    //
    // THAT ARGUMENT HAS A CONDITION, so state it rather than leaving the next
    // person cutting a release to infer it: this must land BEFORE anything tags
    // `v0.59.0`. If 0.59.0 ships first, this body is inside a key that has
    // shipped, everyone who upgraded past it will never run it, and the schema
    // removal goes out with nothing moving the data — DOR-988 verbatim. Reopen
    // at `'0.60.0'` in that case; the body itself needs no change, because it
    // is idempotent and reads the retired keys rather than a version.
    //
    // Independent of the backfill above — disjoint sections,
    // order-immaterial — and idempotent.
    migrateSidebarSectionPrefs(store);
  },
} as const;

/**
 * Widen the generated JSON Schema so conf's Ajv ACCEPTS a `ui.sidebar` written
 * before DOR-579, instead of condemning the whole config file.
 *
 * ## Why this has to exist at all
 *
 * DOR-579 is the first change in this file's migration history that RENAMES a
 * field rather than adding one. Every additive backfill degrades safely when its
 * migration is skipped: the key is absent, a Zod default fills in, nothing
 * breaks. A rename does not. Skipping it leaves `agentPaths` on a group object
 * whose schema is now closed (`additionalProperties: false`), and bare path
 * strings in `pinned`/`muted` where objects are now required — so a config that
 * was valid yesterday becomes schema-INVALID, `new Conf(...)` throws, and the
 * constructor's recovery path backs the file up and replaces it with defaults.
 *
 * That is not "the sidebar forgets its groups". It resets the ENTIRE file:
 * `mesh.scanRoots`, `approvals`, `runtimes`, `cloud`, `onboarding`.
 *
 * It no longer takes the person's privacy choice with it —
 * `safe-defaults/protected-state.ts` salvages that (and every other protective
 * value) before the file is replaced, which is what DOR-584 closed. Do not read
 * that as making this widening optional: salvage keeps protections, not
 * preferences, and it needs the doomed file to still parse as JSON. Not
 * condemning the file in the first place is still the goal.
 *
 * And the migration is skipped more often than it sounds. `conf` runs a key only
 * when `key > storedVersion && key <= projectVersion`, so: a dev tree resolves
 * `SERVER_VERSION` to `0.0.0` and runs NO migrations at all, and shipping this
 * schema in a patch release below the migration key would skip it for every
 * user. Correctness must not hang on the migration running.
 *
 * ## Why it is here and not in the Zod schema
 *
 * Ajv is the ONLY validator on the config read path — nothing calls Zod on a
 * stored object, and `z.toJSONSchema` emits a pipe's OUTPUT schema, so a Zod
 * `.preprocess` would neither run nor widen what Ajv sees. Keying the widening
 * off the schema identities here keeps the exported TypeScript types strict
 * (`SidebarItemRef[]`, no legacy field), which is what makes the compiler
 * enumerate every membership test, and keeps the legacy encoding out of the
 * operator disclosure walker and the OpenAPI export — both of which build their
 * own schema without this override.
 *
 * ## One thing not to assume
 *
 * `SidebarItemRefSchema` is used at THREE sites (`pinned`, `muted`, and each
 * group's `items`), but this fires ONCE for it — Zod emits the node a single
 * time and clones it into each site afterwards, so one widening reaches all
 * three. That is Zod's un-referencing pass, an implementation detail rather
 * than a contract. The fixture in `'a config written before DOR-579 is not
 * condemned'` exercises all three lists together precisely so a Zod change that
 * stopped sharing the node, or a regression widening only one site, goes red
 * rather than silently leaving two paths condemning the file.
 *
 * ## The eight keys the sidebar redesign retired
 *
 * The same hazard, one release later and in the other direction. The redesign
 * (`specs/sidebar-now-today-library` §D) REMOVES `ungroupedCollapsed`,
 * `channelsCollapsed`, `dmsCollapsed`, `threadsCollapsed`, `recentsCollapsed`,
 * `ungroupedSortMode`, `ungroupedDisplayFilter` and `groupsHintDismissed` from
 * `SidebarPrefsSchema`, and Zod closes the object it generates
 * (`additionalProperties: false`). So a config written by yesterday's release —
 * which is every config there is — becomes schema-INVALID the moment the
 * migration is skipped, and the whole file gets condemned and replaced.
 *
 * Naming them here keeps Ajv from condemning the file while the migration has
 * not run, which is precisely the dev-tree case (`SERVER_VERSION` resolves to
 * `0.0.0`, so no migration runs at all). It is tolerance, not a read path:
 * nothing reads these keys, the exported TypeScript types do not carry them, and
 * Zod strips them on the first write that goes through `applyConfigPatch`.
 *
 * ## Removing it
 *
 * This is back-compat for ONE release: delete this function and its `override`
 * once the DOR-579 migration has shipped, together with the read-time
 * `normalizeSidebarPrefs` conversion and `ConfigManager.canonicalUi`. The tests
 * named above fail if it is removed early.
 *
 * @param ctx - The `z.toJSONSchema` override context for one schema node.
 */
function tolerateLegacySidebarEncoding(ctx: {
  zodSchema: unknown;
  jsonSchema: Record<string, unknown>;
}): void {
  // The eight keys the redesign retired. Declared with their real types rather
  // than as an open catchall: "tolerate what yesterday wrote" must not quietly
  // become "validate nothing".
  if (ctx.zodSchema === SidebarPrefsSchema) {
    const properties = ctx.jsonSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return;
    for (const key of Object.keys(RETIRED_SIDEBAR_COLLAPSE_KEYS)) {
      properties[key] = { type: 'boolean' };
    }
    properties.groupsHintDismissed = { type: 'boolean' };
    properties.ungroupedSortMode = { type: 'string', enum: ['name', 'recent'] };
    properties.ungroupedDisplayFilter = { type: 'string', enum: ['all', 'active', 'attention'] };
    return;
  }
  // `pinned`, `muted` and `groups[].items` all held a bare agent projectPath.
  if (ctx.zodSchema === SidebarItemRefSchema) {
    ctx.jsonSchema.anyOf = [{ type: 'string', minLength: 1 }, { oneOf: ctx.jsonSchema.oneOf }];
    delete ctx.jsonSchema.oneOf;
    return;
  }
  // `groups[].items` was `groups[].agentPaths`; the group object is closed, so
  // the retired key has to be named for Ajv to let it through.
  if (ctx.zodSchema === SidebarGroupSchema) {
    const properties = ctx.jsonSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return;
    properties.agentPaths = { type: 'array', items: { type: 'string' } };
    // conf builds Ajv with `useDefaults`, so a declared `default` is WRITTEN IN
    // during validation, and Zod marks a defaulted field `required` because its
    // OUTPUT always has one. Left alone, an un-migrated group would gain an
    // empty `items` before anything could read its `agentPaths`, and the
    // read-time conversion — which treats a present `items` as authoritative —
    // would hand back an empty group. Dropping both keeps "absent" meaning
    // absent, so the conversion can tell the two encodings apart at all.
    // `normalizeSidebarPrefs` supplies `[]` for a group that genuinely has
    // neither, and the Zod default still applies wherever Zod parses.
    delete properties.items?.default;
    const required = ctx.jsonSchema.required;
    if (Array.isArray(required)) {
      ctx.jsonSchema.required = required.filter((key) => key !== 'items');
    }
  }
}

const jsonSchemaFull = z.toJSONSchema(UserConfigSchema, {
  target: 'jsonSchema2019-09',
  override: tolerateLegacySidebarEncoding,
}) as { properties?: Record<string, unknown> };
/**
 * The per-top-level-key JSON Schema conf validates against, tolerances included.
 *
 * Exported so a test that builds its own `Conf` — the only way to pin a
 * `projectVersion` and exercise one migration boundary — validates against the
 * SAME schema production does. A test that rebuilt it from `UserConfigSchema`
 * would silently drop every `override` above, and then fail on a config shape
 * the shipped code accepts. That has already happened once.
 *
 * @internal Exported for testing only.
 */
export const CONF_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFull.properties ?? {};

// Cast the runtime JSON schema to conf's Schema type. The Zod-generated schema
// is structurally compatible at runtime but TypeScript cannot verify it statically.
const confSchema = CONF_JSON_SCHEMA as unknown as Schema<UserConfig>;

/** Construction-time overrides for {@link ConfigManager}. */
export interface ConfigManagerOptions {
  /**
   * Backoff between attempts when a load or a salvage read fails for a reason
   * that is not the file's fault. Defaults to
   * {@link CONFIG_LOAD_RETRY_DELAYS_MS}; its LENGTH is the retry count.
   *
   * Exists for the tests, and earns its place there. Proving that a config
   * survives a storm takes dozens of constructions that each exhaust the
   * staircase, and `sleepSync` parks the worker thread for real: at the shipped
   * delays that suite held a vitest worker for around thirty seconds and made
   * timing-sensitive tests in other files flake. Shortening the delays keeps
   * every attempt, and the attempt count is what those tests are about. One
   * test deliberately uses the default schedule so the shipped path is still
   * exercised end to end.
   */
  retryDelaysMs?: readonly number[];
}

/**
 * Manages persistent user configuration at ~/.dork/config.json.
 *
 * Uses `conf` for atomic JSON I/O with Ajv validation via the JSON Schema
 * generated from UserConfigSchema. Handles first-run detection, corrupt
 * config recovery (backup + recreate), and sensitive field warnings.
 *
 * Construction throws {@link ConfigUnreadableError} when the operating system
 * would not let DorkOS read the file. That is the loud half of the guarantee in
 * {@link classifyConfigLoadFailure}: the file is neither replaced nor deleted,
 * and a restart picks it up. Every other failure recovers rather than
 * throwing.
 *
 * The class is exported alongside the {@link configManager} singleton for one
 * reason: a SECOND manager over the same directory is the faithful stand-in for
 * `dorkos config set`, which is a different process holding its own manager over
 * the same file. Tests that need to reproduce an out-of-process write build one
 * here rather than re-running {@link initConfigManager}, which would replace the
 * singleton and read like a restart — the very thing those tests must not
 * simulate. Production code uses the singleton.
 */
/**
 * What a settings write tells its subscribers.
 *
 * Only the sections, never the values: a listener that cares reads the value it
 * cares about back off the manager, which keeps this event from going stale
 * between the write and the read, and keeps a credential out of an event object
 * that anything may subscribe to.
 */
export interface ConfigChange {
  /** Top-level sections this write touched, e.g. `['runtimes']`. */
  sections: readonly string[];
}

/** Called after a settings write lands. See {@link ConfigManager.onChange}. */
export type ConfigChangeListener = (change: ConfigChange) => void;

export class ConfigManager {
  private store: Conf<UserConfig>;
  private _isFirstRun = false;
  private listeners = new Set<ConfigChangeListener>();

  /**
   * Open the config store, recovering or refusing per the rules above.
   *
   * @param dorkHome - The DorkOS data directory holding `config.json`.
   * @param options - Overrides for the retry policy. Production passes none.
   */
  constructor(dorkHome: string, options: ConfigManagerOptions = {}) {
    const retryDelaysMs = options.retryDelaysMs ?? CONFIG_LOAD_RETRY_DELAYS_MS;
    const configDir = dorkHome;
    const configPath = path.join(configDir, 'config.json');
    this._isFirstRun = !fs.existsSync(configPath);

    // Single source of truth for Conf constructor options. Used by both the
    // primary instantiation (try branch) and the corrupt-recovery fallback
    // (catch branch) so migrations and projectVersion apply on recovery too.
    // Previously the catch branch silently dropped projectVersion and
    // migrations, which meant users who hit corrupt-recovery would never run
    // migrations on subsequent upgrades.
    const confOptions = {
      configName: 'config',
      cwd: configDir,
      schema: confSchema,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      // `projectVersion` is the app version — sourced from the canonical
      // version resolver (`lib/version.ts`) which honors
      // `DORKOS_VERSION_OVERRIDE`, the esbuild-injected CLI version, and the
      // package.json dev fallback in that order. Migration keys in
      // CONFIG_MIGRATIONS must be semver strings matching real releases.
      projectVersion: SERVER_VERSION,
      migrations: CONFIG_MIGRATIONS,
    } satisfies ConstructorParameters<typeof Conf<UserConfig>>[0];

    // Only a failure the file itself caused reaches the recovery branch. An
    // errno failure — a busy file, a machine out of file descriptors, a
    // permission that changed — is retried and then reported by
    // `loadConfigStore`, with the file untouched, however long it lasts. See
    // {@link classifyConfigLoadFailure}.
    const opened = loadConfigStore(confOptions, configPath, retryDelaysMs);
    if ('store' in opened) {
      this.store = opened.store;
      logger.info(`[Config] Loaded from ${configPath} (first run: ${this._isFirstRun})`);
    } else {
      // The actual reason, logged before anything is moved. Without it, the
      // only record of WHY a config was replaced was the fact that it had been.
      logger.warn(
        `[Config] ${configPath} could not be used: ${describeLoadError(opened.corruptedBy)}`
      );
      // Read the doomed file BEFORE deleting it. The common failure is a file
      // that parses as JSON but no longer satisfies the schema (a skipped
      // rename, a narrowed enum, a hand edit), so the person's privacy and
      // permission choices are sitting right there, perfectly readable, in the
      // file we are about to replace. Losing state must not lose a protection.
      let stored: unknown;
      let backupPath: string | undefined;
      if (fs.existsSync(configPath)) {
        const salvage = readStoredConfigForSalvage(configPath, retryDelaysMs);
        if (!salvage.read) {
          // NOTHING GETS REPLACED THAT COULD NOT BE READ. This is the general
          // guarantee behind the errno classification, and it holds even when
          // the classifier was fooled: a failure that looked deterministic but
          // is really a machine in trouble shows up again here, because the
          // machine is still in trouble. Replacing now would destroy a file we
          // have no evidence against and cannot salvage a single protection
          // from.
          logger.error(
            `[Config] Refusing to replace ${configPath}: it could not be read`,
            logError(salvage.error)
          );
          throw new ConfigUnreadableError(configPath, salvage.error);
        }
        stored = salvage.value;
        backupPath = configPath + '.bak';
        try {
          fs.copyFileSync(configPath, backupPath);
          fs.unlinkSync(configPath);
        } catch (error) {
          // Same rule, one step later: if the backup or the removal is
          // refused, stop rather than half-replace. The original is still
          // where the person left it, so the plain message is the true one.
          logger.error(`[Config] Could not replace ${configPath}`, logError(error));
          throw new ConfigUnreadableError(configPath, error);
        }
        logger.warn(`Corrupt config backed up to ${backupPath}`);
        logger.warn('Creating fresh config with defaults.');
      }
      // Reuse the exact same options so the recovered store still has the
      // migration chain wired up. `backupPath` only changes what a failure
      // here SAYS: the original is gone by now, so the message has to send the
      // person to the backup rather than to a path that no longer holds their
      // settings.
      const recovered = loadConfigStore(confOptions, configPath, retryDelaysMs, backupPath);
      if (!('store' in recovered)) {
        // Defaults that `conf` itself condemns are a defect in the defaults,
        // not in anything the person did, and there is nothing further to
        // recover to. Wrapped rather than rethrown bare: both callers of the
        // constructor print a `ConfigUnreadableError` and swallow its stack,
        // and rethrow anything else. A bare error here would reach the person
        // as the uncaught stack trace that wrapping exists to prevent.
        logger.error(`[Config] Could not create a fresh config`, logError(recovered.corruptedBy));
        throw new ConfigUnreadableError(configPath, recovered.corruptedBy, backupPath);
      }
      this.store = recovered.store;
      restoreProtectedState(this.store, stored, 'Recovered a damaged config');
    }
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /**
   * Put a stored `ui` section into the canonical sidebar encoding.
   *
   * **This class is the server's read boundary for the legacy encoding.** A
   * `ui.sidebar` written before DOR-579 holds bare agent paths and
   * `groups[].agentPaths`; the widened conf schema lets conf LOAD that file, but
   * the declared `UserConfig` type says otherwise, and every server-side reader
   * believes the type. Normalizing here — rather than at each consumer — is what
   * makes the type true at the one place the value is handed out, so a new
   * reader cannot reintroduce the gap by forgetting to convert.
   *
   * It matters most on the WRITE path: `applyConfigPatch` merges a patch onto
   * this value and re-validates with Zod, which is strict. Un-normalized, a
   * legacy `pinned` fails that validation and every config write is refused —
   * theme, telemetry consent, onboarding, all of it — and a legacy `agentPaths`
   * is silently stripped by Zod and persisted as an empty group.
   *
   * Returns its input unchanged once the file is canonical, so callers keep
   * referential equality and the steady state costs one scan per list.
   *
   * Removed with the rest of the DOR-579 back-compat, one release on.
   *
   * @param ui - The stored `ui` section, in either encoding.
   */
  private canonicalUi(ui: UserConfig['ui']): UserConfig['ui'] {
    const sidebar = ui?.sidebar;
    if (!sidebar) return ui;
    const normalized = normalizeSidebarPrefs(sidebar);
    return normalized === sidebar ? ui : { ...ui, sidebar: normalized };
  }

  /** Get a top-level config section */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    const value = this.store.get(key);
    // `ui` is the only section that can carry the pre-DOR-579 sidebar encoding.
    return key === 'ui' ? (this.canonicalUi(value as UserConfig['ui']) as UserConfig[K]) : value;
  }

  /**
   * Get a nested value via dot-path (e.g., 'server.port').
   *
   * Reads the store verbatim, so a dot-path INTO `ui.sidebar` on a config that
   * predates DOR-579 reports the stored encoding rather than the canonical one.
   * That is deliberate: this is the "show me what is on disk" accessor behind
   * `dorkos config get`, and no code path derives behaviour from it. Everything
   * that acts on the sidebar goes through {@link ConfigManager.get} or
   * {@link ConfigManager.getAll}, which normalize.
   */
  getDot(key: string): unknown {
    return this.store.get(key as keyof UserConfig);
  }

  /** Set a top-level config section */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    this.store.set(key, value);
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
    this.emitChange([key as string]);
  }

  /**
   * Subscribe to settings changes made through this manager.
   *
   * ## Why this exists
   *
   * Most settings are read at use, so a change simply applies to the next thing
   * that reads them. A few are APPLIED once — `runtimes.default` is set on the
   * registry at boot and never re-read — and shipping a Settings screen over a
   * field like that is a quiet lie: the person changes it, the screen agrees,
   * and nothing happens until they restart. This is the seam that lets the
   * applied ones re-apply (spec `execution-defaults` §3.2).
   *
   * ## What it does and does not see
   *
   * It fires on every write **this process** makes: `PATCH /api/config` (via
   * `applyConfigPatch`), the `config_patch` operator tool, and every internal
   * `set`/`setDot`/`reset` caller — including a write that changes nothing,
   * since it reports the sections a write TOUCHED rather than diffing them.
   * Subscribers are therefore expected to be idempotent, which the one that
   * exists is: re-applying the same default runtime is a no-op and says nothing.
   *
   * It does NOT see `dorkos config set` run in a terminal, or somebody editing
   * `~/.dork/config.json` by hand while the server runs — those still take effect
   * at the next restart, exactly as today.
   *
   * That boundary was chosen over conf's own file watcher (`watch: true`), which
   * would cover the out-of-process cases too. Three reasons not to: conf's
   * `onDidChange` is unreachable from outside this class (the store is private,
   * and exposing it hands every caller the unvalidated store), a live `fs.watch`
   * on the config file is a handle held by every `ConfigManager` a test
   * constructs, and the case this feature was actually asked for — a person
   * changing a setting in the cockpit and expecting it to hold — is in-process
   * by construction. If out-of-process live-apply is ever the complaint, the
   * upgrade is `watch: true` plus an internal `onDidChange` bridge into this same
   * emitter; nothing above this line changes.
   *
   * Listener errors are caught and logged: a subscriber that throws must not
   * turn somebody's settings write into a 500 after the value has been persisted.
   *
   * @param listener - Called after a write lands, with the sections it touched.
   * @returns An unsubscribe function.
   */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify subscribers that the named top-level sections were just written. */
  private emitChange(sections: string[]): void {
    if (this.listeners.size === 0) return;
    const change: ConfigChange = { sections };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        logger.warn('[Config] a change listener threw; the write itself is unaffected', { err });
      }
    }
  }

  /** Set a nested value via dot-path. Returns warning if key is sensitive. */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    this.store.set(key as keyof UserConfig, value as UserConfig[keyof UserConfig]);
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
    // Subscribers speak in top-level sections, so a dot-path reports the section
    // it wrote into: `runtimes.default` and `runtimes` are the same news.
    this.emitChange([key.split('.')[0]!]);
    return result;
  }

  /**
   * Get the full config object, in the canonical sidebar encoding
   * (see {@link ConfigManager.canonicalUi}).
   */
  getAll(): UserConfig {
    const config = this.store.store;
    const ui = this.canonicalUi(config.ui);
    return ui === config.ui ? config : { ...config, ui };
  }

  /**
   * Reset a specific key, or every key, to defaults.
   *
   * A whole-config reset keeps the settings a person moved to the protective
   * side — their telemetry answer, a login gate they switched on, a bound they
   * tightened (see `safe-defaults/protected-state.ts`). "Reset my preferences" is not
   * consent to start sharing again, and this is the verb the operator's own
   * phrasing was about: the safe option has to win *in case things get reset*.
   *
   * Resetting one key is the escape hatch and stays literal: `reset('telemetry')`
   * really does put the telemetry block back to its defaults, because naming the
   * section IS the explicit act that the blanket reset lacks.
   *
   * @param key - The top-level section to reset, or omitted for all of them.
   */
  reset(key?: string): void {
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    if (key) {
      this.store.reset(key as keyof UserConfig);
    } else {
      const stored = this.store.store;
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
      restoreProtectedState(this.store, stored, 'Reset your config');
    }
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
    // A whole-config reset is news about every section, so subscribers that
    // applied something once get to apply it again.
    this.emitChange(key ? [key] : Object.keys(this.store.store));
  }

  /**
   * Whether the two settings, as stored RIGHT NOW, license a standing permission
   * to exist: local login is on (a cookie is the only thing that tells the person
   * in the cockpit from an agent on the same machine) and the master switch is on.
   *
   * Reads the store rather than taking a posture argument, because the callers are
   * the write methods and the answer has to reflect the file on both sides of the
   * write. Mirrors `readStandingGrantPosture` in
   * `services/core/approvals/standing-grant-settings.ts`, which cannot be reused
   * here: it reads the module singleton, and this may be any manager — including
   * the one the CLI holds in another process, which is the whole point.
   */
  private standingGrantsLicensed(): boolean {
    return (
      this.store.get('auth')?.enabled === true &&
      this.store.get('approvals')?.standingGrants === true
    );
  }

  /** The posture floor as stored right now, or `null` when nothing has narrowed. */
  private standingGrantVoidFloor(): string | null {
    return this.store.get('approvals')?.standingGrantsVoidBefore ?? null;
  }

  /**
   * Hold the posture floor at or above where it was before this write, and move
   * it to now when this write is what took the license away (DOR-520).
   *
   * ## Why the marker lives in the config file, written here
   *
   * `revokeStandingGrantsIfPostureNarrowed` ends live permissions, but it only
   * fires on a write the SERVER performs. `dorkos config set
   * approvals.standingGrants false` and `dorkos config reset` are a different
   * process holding its own manager, with no database and no route — so they end
   * nothing, and switching the setting back on used to wake every surviving
   * permission. This method is on the one seam BOTH processes travel: every write
   * to `~/.dork/config.json` in DorkOS goes through a `ConfigManager`.
   *
   * The floor is durable, which the alternatives are not. It survives the server
   * being down for the whole round trip — the case a config-file watcher cannot
   * see at all, and the case the boot sweep misses too, because by the time the
   * server starts the settings look fine again.
   *
   * ## The floor is MONOTONIC, and that is the whole guarantee
   *
   * The first version stamped on the licensed → unlicensed TRANSITION and nothing
   * else. Review broke it in one line: any write performed while the posture was
   * ALREADY narrowed is not a transition, so it did not stamp — while
   * `dorkos config reset` had meanwhile rewritten the whole file from defaults and
   * put the leaf back to `null`. Switch off, reset, switch on, and the permission
   * was live again, through nothing but the verbs this feature claims to cover.
   *
   * The same shape reached `PATCH /api/config`: `applyConfigPatch` computes the
   * merged value ONCE from the pre-write snapshot and then writes each top-level
   * section in turn, so a batch carrying `auth` before `approvals` stamped the
   * floor and then wrote the snapshot's stale `null` straight back over it.
   *
   * So the rule is stated as an invariant on the STORED value rather than as a
   * reaction to a transition: after any write, the floor is `floorBefore`, except
   * on a narrowing where it becomes `max(floorBefore, now)`. Never lower, on any
   * path, whatever the write happened to contain.
   *
   * `max` rather than `now` is what makes it monotonic rather than merely current:
   * a backwards clock (an NTP correction, a container with a bad RTC) would
   * otherwise lower a floor that had already voided permissions.
   *
   * ## It still writes nothing when nothing narrowed
   *
   * Stating the rule as "stamp whenever the posture is unlicensed after the write"
   * would also close the hole, and would move the floor on EVERY config write for
   * the vast majority of installs, which never switch this feature on — doubling
   * config write I/O to maintain a marker with nothing to void. Comparing against
   * the stored value first keeps the common path free.
   *
   * @param licensedBefore - Whether the posture licensed a permission before the
   *   write that just happened.
   * @param floorBefore - The floor as it stood before the write, which this write
   *   may raise but must never lower.
   */
  private stampStandingGrantVoidFloor(licensedBefore: boolean, floorBefore: string | null): void {
    const narrowed = licensedBefore && !this.standingGrantsLicensed();
    const required = narrowed ? latestInstant(floorBefore, new Date().toISOString()) : floorBefore;
    if (required === null) return;

    const approvals = this.store.get('approvals');
    if (approvals?.standingGrantsVoidBefore === required) return;
    this.store.set('approvals', { ...approvals, standingGrantsVoidBefore: required });
  }

  /** Validate the current config against the Zod schema */
  validate(): { valid: boolean; errors?: string[] } {
    try {
      UserConfigSchema.parse(this.store.store);
      return { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      }
      throw error;
    }
  }

  /** Absolute path to the config file */
  get path(): string {
    return this.store.path;
  }
}

export let configManager: ConfigManager;

/** Initialize the config manager. Called once at startup. */
export function initConfigManager(dorkHome: string): ConfigManager {
  configManager = new ConfigManager(dorkHome);
  return configManager;
}
