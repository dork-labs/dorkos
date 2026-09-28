/**
 * The usage ledger on disk: one small JSON file per account at
 * `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json`, shared with flow.
 *
 * Every writer, flow or DorkOS, follows the same seven steps (marketplace
 * `specs/flow-cli-core` §1.2 "Writing", contract revision 4 and later), and this
 * module is DorkOS's one implementation of them:
 *
 * 1. Take the lock: exclusive-create `<id>.json.lock` (`wx`) holding a fresh
 *    token `<pid>:<128-bit hex>`. The token, not the pid, names the holder, so
 *    two writers in one process never mistake each other's lock.
 * 2. A lock whose mtime is older than 10 s is stale. Read its token, rename it
 *    to `<id>.json.lock.stale-<random>`, read the moved file's token, and when it
 *    is NOT the token judged stale (a fresh lock was moved by mistake) put it
 *    back with `link`, which fails harmlessly when a newer lock exists. Then
 *    delete the moved name and retry. A lock is never deleted by its original
 *    name.
 * 3. Retry every 25-100 ms (jittered); give up after 2 s. Giving up returns
 *    `gaveUp` and never throws, so a turn is never failed by a busy ledger.
 * 4. Under the lock, read the file. Missing = empty; unparsable = renamed to
 *    `<id>.json.corrupt-<epoch ms>` and started empty.
 * 5. Merge (`mergeLedger`). Nothing changed: release and stop.
 * 6. Write `<id>.json.<pid>.<random>.tmp`, `fsync`, `rename` over the file.
 * 7. Release: delete the lock only while it still holds our token.
 *
 * Reading takes no lock: `rename` is atomic, so a reader sees the old file or
 * the new one, never half of one.
 *
 * Folder mode `0700`, file mode `0600`: a ledger says how much of someone's
 * subscription is used, which is nobody else's business on a shared machine.
 *
 * @module services/core/usage/ledger-file
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACCOUNT_ID_PATTERN,
  LEDGER_RUNTIMES,
  mergeLedger,
  parseStoredLedger,
  type LedgerMergeWarning,
  type LedgerObservation,
  type LedgerRuntime,
  type UsageLedger,
} from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';

/** A lock whose mtime is older than this is stale (contract step 2). */
export const LOCK_STALE_MS = 10_000;
/** How long a writer keeps trying for the lock before it gives up (contract step 3). */
export const LOCK_GIVE_UP_MS = 2_000;
const RETRY_MIN_MS = 25;
const RETRY_SPREAD_MS = 75;

/** The suffixes of the files a ledger folder holds beside the ledgers themselves. */
const SIDE_FILE_PATTERN = /\.(lock|tmp)$|\.stale-|\.corrupt-/;

/** Injectable timing, so tests can drive retries and give-ups without waiting. */
export interface LedgerLockOptions {
  /** Give up after this many ms. Default {@link LOCK_GIVE_UP_MS}. */
  giveUpMs?: number;
  /** Sleep between attempts. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for {@link writeLedger}. */
export interface WriteLedgerOptions extends LedgerLockOptions {
  /**
   * Top-level fields to keep from another ledger being folded into this one
   * (writers keep fields they do not know, contract §1.2). The target's own
   * value wins on a clash; the declared ledger fields are never taken.
   */
  carryFields?: Readonly<Record<string, unknown>>;
}

/** The outcome of {@link writeLedger}. */
export interface WriteLedgerResult {
  /** True when the file was rewritten. False when nothing changed, or on a give-up. */
  written: boolean;
  /** Observations `mergeLedger` set aside, for the caller's warning log. */
  dropped: LedgerMergeWarning[];
  /** True when the lock could not be taken within the give-up time. */
  gaveUp?: boolean;
  /**
   * True when the file is a ledger of another version, which is left alone
   * (contract §1.2): nothing was merged into it.
   */
  otherVersion?: boolean;
  /** The ledger as it stands on disk after this write (`null` when there is none). */
  ledger: UsageLedger | null;
}

/** The outcome of {@link withLedgerLock}. */
export type LockedResult<T> = { gaveUp: false; value: T } | { gaveUp: true };

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Refuse an account id that is not a ledger file name. The id is part of a
 * path, so anything outside {@link ACCOUNT_ID_PATTERN} could escape the folder.
 */
function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`Refused a ledger for account id "${accountId}": not a valid account id.`);
  }
}

/**
 * The runtime a ledger folder belongs to, read off its path
 * (`<dorkHome>/runtimes/<runtime>/usage`). The contract says readers trust the
 * path, so the writer does too.
 */
export function runtimeOfLedgerDir(dir: string): LedgerRuntime {
  const runtime = path.basename(path.dirname(dir));
  if (!(LEDGER_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new Error(`Refused ledger folder "${dir}": it is not under runtimes/<runtime>/usage.`);
  }
  return runtime as LedgerRuntime;
}

/**
 * The ledger folder for one runtime: `<dorkHome>/runtimes/<runtime>/usage`.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param runtime - The runtime slug.
 */
export function ledgerDir(dorkHome: string, runtime: LedgerRuntime): string {
  return path.join(dorkHome, 'runtimes', runtime, 'usage');
}

/** Create the ledger folder (mode `0700`) and its parents, if missing. */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
  }
}

async function readToken(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a file's mtime is older than {@link LOCK_STALE_MS}; a missing file is `null`. */
async function isStale(file: string): Promise<boolean | null> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return null;
  }
}

/**
 * Break the lock at `lockPath` when it is stale (contract step 2). Returns true
 * when the caller should retry at once (the lock is gone or was just broken),
 * false when a live lock is held.
 *
 * The token is read BEFORE the age is checked. Checking the age first would let
 * a lock replaced in between (another breaker broke the stale one and a writer
 * took a fresh one) hand over the FRESH token, which the moved file would then
 * match, and a live lock would be deleted. Read first, a replacement shows up as
 * a fresh mtime (no break) or as a token that no longer matches (put back).
 */
async function breakIfStale(lockPath: string): Promise<boolean> {
  const judged = await readToken(lockPath);
  if (judged === null) return true;
  const stale = await isStale(lockPath);
  if (stale === null) return true;
  if (!stale) return false;
  const moved = `${lockPath}.stale-${randomHex(8)}`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    // Somebody else broke or released it first.
    return true;
  }
  const movedToken = await readToken(moved);
  // We moved a lock that is not the one judged stale, or one that is fresh: its
  // holder replaced the stale lock between our read and our rename. Put it back;
  // a newer lock already there wins (EEXIST).
  if (movedToken !== judged || (await isStale(moved)) === false) {
    try {
      await fs.link(moved, lockPath);
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) {
        logger.debug('[ledger-file] could not restore a lock moved by mistake', {
          lockPath,
          err: String(err),
        });
      }
    }
  }
  await fs.rm(moved, { force: true });
  return true;
}

/** Take the lock (contract steps 1-3). Returns our token, or null on a give-up. */
async function acquire(lockPath: string, opts: LedgerLockOptions): Promise<string | null> {
  const giveUpMs = opts.giveUpMs ?? LOCK_GIVE_UP_MS;
  const sleep = opts.sleep ?? realSleep;
  const token = `${process.pid}:${randomHex()}`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
    }
    const broke = await breakIfStale(lockPath);
    if (Date.now() - started >= giveUpMs) return null;
    if (!broke) await sleep(RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
  }
}

/** Release the lock only while it still holds our token (contract step 7). */
async function release(lockPath: string, token: string): Promise<void> {
  if ((await readToken(lockPath)) !== token) return;
  await fs.rm(lockPath, { force: true });
}

/**
 * Run `fn` while holding one ledger's lock (contract steps 1-3 and 7).
 *
 * @param dir - The runtime's ledger folder; created (mode `0700`) when missing.
 * @param accountId - The ledger id. Refused unless it matches {@link ACCOUNT_ID_PATTERN}.
 * @param fn - The work to do under the lock.
 * @param opts - Timing overrides.
 * @returns `fn`'s value, or `{ gaveUp: true }` when the lock could not be taken.
 */
export async function withLedgerLock<T>(
  dir: string,
  accountId: string,
  fn: () => Promise<T>,
  opts: LedgerLockOptions = {}
): Promise<LockedResult<T>> {
  assertAccountId(accountId);
  await ensureDir(dir);
  const lockPath = path.join(dir, `${accountId}.json.lock`);
  const token = await acquire(lockPath, opts);
  if (token === null) return { gaveUp: true };
  try {
    return { gaveUp: false, value: await fn() };
  } finally {
    await release(lockPath, token);
  }
}

/** What one ledger file on disk is, read without judging its readings. */
export type LedgerFileState =
  | { state: 'missing' }
  /** The file exists but could not be read right now (EMFILE, EIO, EACCES, …). */
  | { state: 'read-error'; error: unknown }
  /** Not JSON, not an object, no `v`, or a version-1 file with no `windows` object. */
  | { state: 'not-a-ledger' }
  /** A ledger of another version: left alone (contract §1.2). */
  | { state: 'other-version'; raw: Record<string, unknown> }
  /** A version-1 ledger, raw: its entries are validated when merged. */
  | { state: 'ledger'; raw: Record<string, unknown> };

/**
 * Read one ledger file and say what it is, without a lock and without
 * dropping anything: only `not-a-ledger` may be set aside, `other-version` is
 * left alone, and a `read-error` means "try again later".
 *
 * @param dir - The runtime's ledger folder.
 * @param accountId - The ledger id.
 */
export async function inspectLedgerFile(dir: string, accountId: string): Promise<LedgerFileState> {
  assertAccountId(accountId);
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, `${accountId}.json`), 'utf8');
  } catch (err) {
    return isErrno(err, 'ENOENT') ? { state: 'missing' } : { state: 'read-error', error: err };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'not-a-ledger' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'not-a-ledger' };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.v === undefined) return { state: 'not-a-ledger' };
  if (raw.v !== 1) return { state: 'other-version', raw };
  const windows = raw.windows;
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) {
    return { state: 'not-a-ledger' };
  }
  return { state: 'ledger', raw };
}

/**
 * Read the file under the lock (contract step 4): missing = empty; not a
 * ledger = set aside as `.corrupt-<ms>` and read as empty, never overwritten;
 * a ledger of ANOTHER version is returned as is, for `mergeLedger` to leave
 * alone. A read error throws, so the write is retried rather than clobbering.
 */
async function readUnderLock(dir: string, accountId: string): Promise<unknown> {
  const file = await inspectLedgerFile(dir, accountId);
  switch (file.state) {
    case 'missing':
      return null;
    case 'read-error':
      throw file.error;
    case 'not-a-ledger':
      await setLedgerAside(dir, accountId);
      return null;
    default:
      return file.raw;
  }
}

/**
 * Set a ledger file that cannot be read aside as `<id>.json.corrupt-<epoch ms>`,
 * so nothing it held is lost to a rewrite. Call it under the ledger's lock. A
 * missing file is fine.
 *
 * @param dir - The runtime's ledger folder.
 * @param accountId - The ledger id.
 */
export async function setLedgerAside(dir: string, accountId: string): Promise<void> {
  assertAccountId(accountId);
  const file = path.join(dir, `${accountId}.json`);
  const corrupt = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.rename(file, corrupt);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return;
    throw err;
  }
  logger.warn('[ledger-file] a usage ledger could not be read; set it aside and started empty', {
    file,
    movedTo: corrupt,
  });
}

/** Write `ledger` over `file` through a temp file, `fsync` and `rename` (contract step 6). */
async function replaceFile(dir: string, file: string, ledger: UsageLedger): Promise<void> {
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${randomHex(8)}.tmp`);
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Merge observations into one account's ledger file (contract §1.2 "Writing",
 * steps 1-7 exactly).
 *
 * Never throws on a busy lock: after 2 s it returns `{ written: false, gaveUp:
 * true }` and the caller keeps its readings for the next try. It does throw on
 * a refused account id or an unexpected filesystem error, which the caller logs.
 *
 * @param dir - `<dorkHome>/runtimes/<runtime>/usage`; the runtime is read off the path.
 * @param accountId - The ledger id (`default` for a standalone default account).
 * @param observations - The readings to merge.
 * @param now - The moment of the write.
 * @param opts - Timing overrides.
 */
export async function writeLedger(
  dir: string,
  accountId: string,
  observations: readonly LedgerObservation[],
  now: Date,
  opts: WriteLedgerOptions = {}
): Promise<WriteLedgerResult> {
  const runtime = runtimeOfLedgerDir(dir);
  const file = path.join(dir, `${accountId}.json`);
  const locked = await withLedgerLock(
    dir,
    accountId,
    async (): Promise<WriteLedgerResult> => {
      const existing = await readUnderLock(dir, accountId);
      const merged = mergeLedger(existing, observations, now, { runtime, accountId });
      if (merged.warnings.some((w) => w.code === 'ledger-version-unknown')) {
        return { written: false, dropped: merged.warnings, ledger: null, otherVersion: true };
      }
      const base = merged.changed ? merged.ledger : existing;
      const carried = withCarriedFields(base, opts.carryFields, now);
      if (!merged.changed && carried === base) {
        return {
          written: false,
          dropped: merged.warnings,
          ledger: parseStoredLedger(existing).ledger,
        };
      }
      await replaceFile(dir, file, carried as UsageLedger);
      // The file keeps what this version cannot read; memory gets only what it can.
      return { written: true, dropped: merged.warnings, ledger: parseStoredLedger(carried).ledger };
    },
    opts
  );
  if (locked.gaveUp) return { written: false, dropped: [], gaveUp: true, ledger: null };
  return locked.value;
}

/** The fields every ledger declares; anything else is a field a writer keeps. */
const LEDGER_FIELDS = new Set([
  'v',
  'runtime',
  'accountId',
  'updatedAt',
  'windows',
  'plan',
  'credits',
  'spend',
]);

/**
 * `base` with the undeclared top-level fields of `carry` added where `base` has
 * none of its own (the target's value wins), and `updatedAt` moved to `now`
 * when anything was added. `base` itself when nothing is added, or when there
 * is no ledger to add them to.
 */
function withCarriedFields(
  base: unknown,
  carry: Readonly<Record<string, unknown>> | undefined,
  now: Date
): unknown {
  if (!carry || base === null || typeof base !== 'object' || Array.isArray(base)) return base;
  const target = base as Record<string, unknown>;
  const extra = Object.entries(carry).filter(
    ([key]) => !LEDGER_FIELDS.has(key) && !(key in target)
  );
  if (extra.length === 0) return base;
  return { ...target, ...Object.fromEntries(extra), updatedAt: now.toISOString() };
}

/**
 * The set-aside warnings already logged, by file and what was set aside. A
 * writer never deletes an entry it cannot read, so the same file reads the same
 * way on every watch event and every 60 s scan; one warning per distinct
 * set-aside is enough.
 */
const warnedSetAside = new Set<string>();

function warnSetAsideOnce(file: string, dropped: readonly string[]): void {
  const key = `${file}\0${[...dropped].sort().join('\0')}`;
  if (warnedSetAside.has(key)) return;
  warnedSetAside.add(key);
  logger.warn('[ledger-file] set aside usage ledger entries it could not read', {
    file,
    dropped,
  });
}

/**
 * Read one account's ledger without a lock. Missing = `null`. A file that is not
 * a version-1 ledger at all also reads as `null`, with a warning. Inside a
 * readable file, one window or fact this version does not understand is set
 * aside with a warning and the rest reads ({@link parseStoredLedger}), so a
 * newer writer's entry never blanks the whole account (DOR-2471).
 *
 * @param dir - The runtime's ledger folder.
 * @param accountId - The ledger id.
 */
export async function readLedger(dir: string, accountId: string): Promise<UsageLedger | null> {
  assertAccountId(accountId);
  const file = path.join(dir, `${accountId}.json`);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) {
      logger.warn('[ledger-file] could not read a usage ledger', { file, err: String(err) });
    }
    return null;
  }
  let read: ReturnType<typeof parseStoredLedger> = { ledger: null, dropped: [] };
  try {
    read = parseStoredLedger(JSON.parse(text));
  } catch {
    // Unparsable JSON: falls through to the warning below.
  }
  if (!read.ledger) {
    logger.warn('[ledger-file] a usage ledger is not valid; read it as empty', { file });
    return null;
  }
  if (read.dropped.length > 0) warnSetAsideOnce(file, read.dropped);
  return read.ledger;
}

/**
 * Delete one account's ledger file under its lock (contract §1.2 "Removing an
 * account"). A missing file or folder is not an error.
 *
 * @param dir - The runtime's ledger folder.
 * @param accountId - The ledger id.
 * @param opts - Timing overrides.
 * @returns False on a give-up, else true.
 */
export async function deleteLedger(
  dir: string,
  accountId: string,
  opts: LedgerLockOptions = {}
): Promise<boolean> {
  assertAccountId(accountId);
  try {
    await fs.access(dir);
  } catch {
    return true;
  }
  const locked = await withLedgerLock(
    dir,
    accountId,
    () => fs.rm(path.join(dir, `${accountId}.json`), { force: true }),
    opts
  );
  return !locked.gaveUp;
}

/** One ledger file found in a folder. */
export interface LedgerFileEntry {
  /** The account id its name carries. */
  id: string;
  /** Its last modification time, in epoch ms. */
  mtimeMs: number;
}

/**
 * The ledger files in one folder, skipping locks, temp files, and the
 * `.stale-*` and `.corrupt-*` names. A missing folder has none.
 *
 * @param dir - The runtime's ledger folder.
 */
export async function listLedgerFiles(dir: string): Promise<LedgerFileEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: LedgerFileEntry[] = [];
  for (const name of names.sort()) {
    const id = ledgerIdOfFileName(name);
    if (id === null) continue;
    try {
      entries.push({ id, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs });
    } catch {
      // Gone between the listing and the stat: not a file any more.
    }
  }
  return entries;
}

/**
 * The account id a ledger folder entry names, or `null` for anything that is
 * not a ledger file (a lock, a temp file, a `.stale-*` or `.corrupt-*` name, or
 * a name whose id is not a valid account id).
 *
 * @param name - A file name inside a ledger folder.
 */
export function ledgerIdOfFileName(name: string): string | null {
  if (SIDE_FILE_PATTERN.test(name) || !name.endsWith('.json')) return null;
  const id = name.slice(0, -'.json'.length);
  return ACCOUNT_ID_PATTERN.test(id) ? id : null;
}
