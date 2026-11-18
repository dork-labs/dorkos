/**
 * Notice a Claude account being signed in again from the command line
 * (DOR-4425 step 2).
 *
 * While an account is signed out, this watches the metadata of one file: the
 * CLI config file `<account root>/.claude.json`, which the CLI rewrites when it
 * signs in. A change does not clear anything by itself. It asks for one probe
 * ({@link probeAccount}), and only a probe that reads the account's plan limits
 * clears the signed-out state, through the probe's own proof path.
 *
 * Three rules, each pinned by a test (`__tests__/signin-credential-watch.test.ts`):
 *
 * 1. **The registry names the file.** The folder comes only from DorkOS's own
 *    account registry. A root no registered account matches gets no watch.
 *    The file is checked with `lstat` and never followed: a symlink is not
 *    watched. Its contents are never read, only its size and change time.
 * 2. **At most one probe per floor window.** A burst of events collapses into
 *    one probe after a short pause, and no two probes start within
 *    {@link PROBE_FLOOR_MS} of each other.
 * 3. **Off under the test runtime**, whose accounts are not real folders.
 *
 * A file that does not exist yet is skipped, not waited for: the simplest safe
 * choice, since watching the whole folder would hear every write in it.
 *
 * @module services/runtimes/claude-code/accounts/signin-credential-watch
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import {
  accountForPath,
  canonicalAccountPath,
  type RuntimeAccount,
} from '../../../core/usage/runtime-accounts.js';
import { onAccountSigninChange } from '../../../observability/index.js';
import { PROBE_FLOOR_MS, probeAccount, type AccountProbeOutcome } from './account-probe.js';

/** The CLI config file the watch looks at, inside an account's folder. */
export const CLI_CONFIG_FILE_NAME = '.claude.json';

/** How long after a burst's first file event the probe is asked for; the rest join it. */
export const CREDENTIAL_CHANGE_DEBOUNCE_MS = 1_000;

/** What `lstat` says about the file: metadata only. */
export interface CliConfigFileFacts {
  /** The path is itself a symlink. Never watched. */
  isSymbolicLink: boolean;
  /** The path is a regular file. */
  isFile: boolean;
  /** Its last change time, in ms. */
  mtimeMs: number;
  /** Its size in bytes. */
  size: number;
}

/** A running file watch. */
export interface CliConfigFileWatch {
  /** Stop watching. */
  close(): void;
}

/**
 * Starts a watch on one file. Production uses `fs.watch`, unreferenced so it
 * never keeps the process alive.
 */
export type CliConfigWatchFactory = (
  file: string,
  onEvent: (eventType: string) => void,
  onError: (err: unknown) => void
) => CliConfigFileWatch;

/** Injectable collaborators, all defaulted for production. */
export interface SigninCredentialWatchDeps {
  /** Under the test runtime the watch does nothing at all. */
  testRuntime: boolean;
  /** The registered Claude Code accounts (default: the usage store's). */
  listAccounts?: () => readonly RuntimeAccount[];
  /** Starts a file watch (default: `fs.watch`). */
  watch?: CliConfigWatchFactory;
  /** Reads the file's metadata without following a symlink, or `null` when it is missing. */
  lstat?: (file: string) => CliConfigFileFacts | null;
  /** Asks for one probe of an account (default: {@link probeAccount}). */
  probe?: (accountId: string) => Promise<{ probe: AccountProbeOutcome }>;
  /** Clock in ms (default: `Date.now`). */
  now?: () => number;
  /** The quiet time before a probe (default {@link CREDENTIAL_CHANGE_DEBOUNCE_MS}). */
  debounceMs?: number;
}

/** One signed-out account being watched. */
interface WatchedAccount {
  /** The registry id the probe is asked about. */
  accountId: string;
  /** `<registry folder>/.claude.json`. */
  file: string;
  /** The running watch. */
  watch: CliConfigFileWatch;
  /** The metadata last seen, so an event that changed nothing asks for nothing. */
  seen: { mtimeMs: number; size: number };
  /** The pending probe timer, while one is waiting. */
  timer?: ReturnType<typeof setTimeout>;
  /** A probe is running now. */
  probing: boolean;
  /** When the last probe was asked for, in ms. */
  lastProbeAt?: number;
}

/** The production file watch. */
const watchWithFs: CliConfigWatchFactory = (file, onEvent, onError) => {
  const watcher = fs.watch(file, { persistent: false }, (eventType) => onEvent(eventType));
  watcher.on('error', onError);
  return { close: () => watcher.close() };
};

/** The production metadata read: `lstat`, which does not follow a symlink. */
function lstatWithFs(file: string): CliConfigFileFacts | null {
  const stats = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stats) return null;
  return {
    isSymbolicLink: stats.isSymbolicLink(),
    isFile: stats.isFile(),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

/** The registered accounts, from the usage store once it runs. */
function registeredAccounts(): readonly RuntimeAccount[] {
  return getAccountUsageStore()?.listAccounts('claude-code') ?? [];
}

/**
 * Start watching signed-out Claude accounts for a sign-in from the command line.
 *
 * @param deps - Injectable collaborators; `testRuntime` turns the whole watch off.
 * @returns A function that stops every watch and stops listening.
 */
export function startSigninCredentialWatch(deps: SigninCredentialWatchDeps): () => void {
  if (deps.testRuntime) return () => {};
  const listAccounts = deps.listAccounts ?? registeredAccounts;
  const watchFile = deps.watch ?? watchWithFs;
  const lstat = deps.lstat ?? lstatWithFs;
  const probe = deps.probe ?? ((accountId: string) => probeAccount(accountId));
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? CREDENTIAL_CHANGE_DEBOUNCE_MS;
  /** Watches by the registry's canonical folder. */
  const watched = new Map<string, WatchedAccount>();

  const quietly = (what: string, err: unknown, extra: Record<string, unknown> = {}): void =>
    logger.debug(`[account-signin-watch] ${what}`, { err: String(err), ...extra });

  /** The registered account a root names, or null: the only source of a folder. */
  const registryAccount = (root: string): RuntimeAccount | null =>
    accountForPath(listAccounts(), 'claude-code', root, undefined);

  /** The file's metadata when it is safe to watch: a regular file, not a symlink. */
  const safeFacts = (file: string): CliConfigFileFacts | null => {
    const facts = lstat(file);
    return facts && facts.isFile && !facts.isSymbolicLink ? facts : null;
  };

  const stop = (key: string): void => {
    const entry = watched.get(key);
    if (!entry) return;
    watched.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watch.close();
    } catch (err) {
      quietly('could not close a watch', err);
    }
  };

  const stopAll = (): void => {
    for (const key of [...watched.keys()]) stop(key);
  };

  /** Ask for the probe at the soonest moment the floor allows. */
  const schedule = (key: string, entry: WatchedAccount, delayMs: number): void => {
    if (entry.timer) return;
    const floorLeft =
      entry.lastProbeAt === undefined ? 0 : entry.lastProbeAt + PROBE_FLOOR_MS - now();
    entry.timer = setTimeout(() => runProbe(key, entry), Math.max(delayMs, floorLeft));
    entry.timer.unref?.();
  };

  const runProbe = (key: string, entry: WatchedAccount): void => {
    entry.timer = undefined;
    if (watched.get(key) !== entry) return;
    if (entry.probing) {
      // The running probe's answer covers this change; one more after the floor.
      schedule(key, entry, debounceMs);
      return;
    }
    entry.probing = true;
    entry.lastProbeAt = now();
    // The probe clears the account itself when it reads plan limits; this
    // watch only asks. A throttled probe is asked again once the floor passes.
    void probe(entry.accountId)
      .then((result) => {
        if (result.probe === 'throttled' && watched.get(key) === entry) {
          schedule(key, entry, PROBE_FLOOR_MS);
        }
      })
      .catch((err: unknown) => quietly('a probe after a change failed', err))
      .finally(() => {
        entry.probing = false;
      });
  };

  /** Arm (or re-arm) the watch on an entry's file. */
  const arm = (key: string, accountId: string, file: string): void => {
    const facts = safeFacts(file);
    if (!facts) {
      logger.debug('[account-signin-watch] not watching: missing, a symlink, or not a file', {
        accountId,
      });
      stop(key);
      return;
    }
    const previous = watched.get(key);
    const entry: WatchedAccount = previous ?? {
      accountId,
      file,
      watch: { close: () => {} },
      seen: { mtimeMs: facts.mtimeMs, size: facts.size },
      probing: false,
    };
    try {
      previous?.watch.close();
    } catch (err) {
      quietly('could not close a watch', err);
    }
    entry.watch = watchFile(
      file,
      (eventType) => onEvent(key, entry, eventType),
      (err) => {
        quietly('a watch stopped', err, { accountId });
        stop(key);
      }
    );
    watched.set(key, entry);
  };

  const onEvent = (key: string, entry: WatchedAccount, eventType: string): void => {
    try {
      if (watched.get(key) !== entry) return;
      const facts = safeFacts(entry.file);
      if (!facts) {
        stop(key);
        return;
      }
      // A rewrite by rename replaces the file the watch was on: watch the new one.
      if (eventType === 'rename') {
        arm(key, entry.accountId, entry.file);
        if (watched.get(key) !== entry) return;
      }
      if (facts.mtimeMs === entry.seen.mtimeMs && facts.size === entry.seen.size) return;
      entry.seen = { mtimeMs: facts.mtimeMs, size: facts.size };
      schedule(key, entry, debounceMs);
    } catch (err) {
      quietly('could not handle a change', err, { accountId: entry.accountId });
      stop(key);
    }
  };

  const start = (root: string): void => {
    const account = registryAccount(root);
    const folder = account?.canonicalPath;
    if (!account || !folder) return;
    if (watched.has(folder)) return;
    try {
      arm(folder, account.id, path.join(folder, CLI_CONFIG_FILE_NAME));
    } catch (err) {
      quietly('could not watch an account', err, { accountId: account.id });
      stop(folder);
    }
  };

  const unsubscribe = onAccountSigninChange((change) => {
    if (change.kind === 'reset') {
      stopAll();
      return;
    }
    if (change.runtime !== 'claude-code' || change.accountRoot === undefined) return;
    try {
      if (change.state === 'signed-out') {
        start(change.accountRoot);
        return;
      }
      stop(
        registryAccount(change.accountRoot)?.canonicalPath ??
          canonicalAccountPath(change.accountRoot, undefined)
      );
    } catch (err) {
      quietly('could not follow a sign-in change', err);
    }
  });

  return () => {
    unsubscribe();
    stopAll();
  };
}
