/**
 * What a failed `conf` load says about the stored file: the four failure
 * kinds and the classifier the boot recovery reads. Moved out of
 * `config-manager.ts` unchanged; no migration reaches it.
 *
 * @module services/core/config/load-failure
 */
import { ERRNO_CODE, ERRNO_IN_MESSAGE } from './load-error-advice.js';

/**
 * What a failed `conf` load says about the file on disk.
 *
 * The four kinds differ in exactly one way that matters: whether the file may
 * be replaced, and after how long.
 *
 * - `corrupt` — the stored bytes are unusable and only replacing the file gets
 *   past it: the JSON does not parse, the contents fail the schema, or they
 *   cannot be decrypted. Condemned immediately, because re-reading the same
 *   bytes cannot change the answer. Note what is NOT in this class any more.
 *   A key this build does not declare is another build's key
 *   (`config/version-skew.ts`), and a named scalar leaf holding a value a newer
 *   build widened is another build's value (`config/widened-leaves.ts`);
 *   neither is a violation the validator can even see now. So what reaches this
 *   class is a SHAPE the schema does not describe — a section that is a list, a
 *   list that is a string, a required field with no default and nothing in it —
 *   which is what damage looks like and what a build widening a setting never
 *   produces.
 * - `io` — the READ failed and the contents were never in question. An `EMFILE`
 *   while the machine is out of file descriptors, an `EACCES` after an
 *   ownership change, an `EBUSY` while another program holds the file, an `EIO`
 *   off a flaky disk. **Never condemns the file, however long it lasts.**
 * - `migration` — a migration BODY threw. That is a defect in DorkOS's own
 *   upgrade code, and it says nothing about the file, so it condemns nothing:
 *   the boot stops loudly and the settings stay where they are. Same principle
 *   as `io`, one layer up — the code was wrong, not the data.
 * - `unknown` — none of those. Retried, and condemned only if it survives the
 *   whole backoff staircase, at which point it is deterministic and the file is
 *   the only thing it can be about.
 */
export type ConfigLoadFailureKind = 'corrupt' | 'io' | 'migration' | 'unknown';

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
 * condemned once the staircase has proved it deterministic.
 *
 * That is the general rule rather than a list of conf's internals: the caller
 * retries, and time does the classifying. It costs a broken file one 750ms
 * staircase before it is recovered.
 *
 * ## Why a throwing migration body is NOT in that class
 *
 * It used to be, and it was the same mistake as the errno class in a different
 * costume: a bug in DorkOS's own upgrade code failed identically four times,
 * looked deterministic, and was read as proof that the file was bad. The file
 * was fine. Whoever fixed the migration would have been able to boot straight
 * into their settings — except the settings had already been replaced.
 *
 * `conf` marks that case for us. `_migrate` wraps everything thrown inside its
 * per-migration `try` with {@link CONF_MIGRATION_WRAPPER}, and the semver check
 * above sits OUTSIDE that `try` (`conf@15`, `_migrate`: the version filter runs
 * before the loop), so a corrupt migration version still arrives bare and still
 * lands in `unknown`. The errno check runs first, so a laundered `EMFILE` from
 * inside a migration body is still `io`. What is left under the wrapper is
 * DorkOS's own code throwing, which condemns nothing.
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
  // conf's Ajv wrapper: `Config schema violation: mesh/scanRoots must be array`.
  if (error.message.startsWith('Config schema violation:')) return 'corrupt';
  // conf's decrypt failure, raised with exactly this message. Unreachable while
  // DorkOS passes no `encryptionKey`, and kept so it stays right if one is ever
  // added.
  if (error.message === 'Failed to decrypt config data.') return 'corrupt';
  // Before the wrapper check, because a wrapped errno is still the machine's
  // fault rather than the migration's.
  if (isIoFailure(error)) return 'io';
  if (error.message.startsWith(CONF_MIGRATION_WRAPPER)) return 'migration';
  return 'unknown';
}

/**
 * The first sentence `conf` puts on anything thrown from inside a migration.
 *
 * `conf@15`'s `_migrate` catches every failure in its per-migration `try` and
 * rethrows it as a plain `Error`, appending the original message and keeping
 * neither `code` nor `cause`.
 */
export const CONF_MIGRATION_WRAPPER = 'Something went wrong during the migration!';

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
