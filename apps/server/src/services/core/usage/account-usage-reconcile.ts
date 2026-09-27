/**
 * Registry transitions for the account usage store (spec `claude-account-fleet`
 * §6 R "Registry transitions keep state"), applied idempotently from the files
 * and the config file on disk, because a `flow accounts add` or a hand edit
 * never reaches `ConfigManager.onChange`:
 *
 * - **An account leaves the registry:** its ledger is deleted under the
 *   contract's lock, per the pure `pruneTargets`, once the file is older than
 *   60 s (so a ledger flow writes for an account it has just added survives).
 * - **An account is registered at the default's folder:** `default` becomes its
 *   alias; `default.json` is merged into `<id>.json` under both locks, THEN
 *   deleted, and never deleted when the merge could not happen.
 * - **The aliased account is removed:** `default` stands alone again and starts a
 *   fresh `default.json` with its next reading (nothing to do here).
 *
 * The ledger files are listed FIRST and the registry read LAST. Nothing is
 * deleted when `config.json` cannot be read in full.
 *
 * @module services/core/usage/account-usage-reconcile
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_FACT_KINDS,
  LEDGER_RUNTIMES,
  type LedgerObservation,
  type LedgerRuntime,
  type UsageLedger,
} from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import {
  deleteLedger,
  inspectLedgerFile,
  listLedgerFiles,
  setLedgerAside,
  withLedgerLock,
  writeLedger,
  type LedgerFileEntry,
  type LedgerLockOptions,
} from './ledger-file.js';
import type { AccountRename } from './account-reference-move.js';
import {
  pruneTargets,
  resolveRuntimeAccounts,
  type DefaultFolderResolver,
  type RealpathLookup,
  type RuntimeAccount,
} from './runtime-accounts.js';

/** What a `readConfig` returns when `config.json` cannot be read in full. */
export const CONFIG_UNREADABLE: unique symbol = Symbol('config-unreadable');

/**
 * Read a `config.json` from disk, in full: `null` when the file is missing (no
 * registered accounts), {@link CONFIG_UNREADABLE} when it exists but cannot be
 * read or parsed (so nothing is deleted on its word).
 *
 * @param configPath - `<dorkHome>/config.json`.
 */
export async function readConfigFile(configPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.promises.readFile(configPath, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : CONFIG_UNREADABLE;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return CONFIG_UNREADABLE;
  }
}

/**
 * The windows and facts of a ledger, as observations, so two ledgers merge
 * newest-wins through `mergeLedger`.
 *
 * @param ledger - A ledger, or `null` for none.
 */
export function observationsOf(ledger: UsageLedger | null): LedgerObservation[] {
  if (!ledger) return [];
  const out: LedgerObservation[] = [];
  for (const [key, entry] of Object.entries(ledger.windows)) out.push({ key, ...entry });
  for (const kind of LEDGER_FACT_KINDS) {
    const fact = ledger[kind];
    if (fact) out.push({ kind, ...fact } as LedgerObservation);
  }
  return out;
}

/** What {@link reconcileAccounts} needs from the store it reconciles. */
export interface ReconcileHost {
  /** The runtime's ledger folder. */
  dir(runtime: LedgerRuntime): string;
  /** Read `config.json` in full, or {@link CONFIG_UNREADABLE}. */
  readConfig(): Promise<unknown>;
  /** Each runtime's default folder, from config and the OS home only. */
  resolveDefaultRoot: DefaultFolderResolver;
  /** The real-path lookup folders are compared with. */
  realpath: RealpathLookup;
  /** Lock timing overrides. */
  lockOptions?: LedgerLockOptions;
  /** A ledger file younger than this is never pruned. */
  pruneMinAgeMs: number;
  /** The store's clock, for merges. */
  now(): Date;
  /** Log a warning once per key. */
  logOnce(key: string, message: string, meta?: Record<string, unknown>): void;
  /** Allow a once-per-key warning to be logged again. */
  forgetLog(key: string): void;
  /** Install the accounts just resolved. */
  setAccounts(accounts: RuntimeAccount[]): void;
  /** Move the in-memory `default` record's readings to its new alias. */
  moveDefaultInMemory(runtime: LedgerRuntime, aliasId: string): Promise<void>;
  /** Merge a ledger just written for `id` into memory. */
  mergeWritten(runtime: LedgerRuntime, id: string, ledger: UsageLedger): void;
  /** Forget file-backed records whose ledger id is not registered. */
  forgetUnregistered(runtime: LedgerRuntime, registered: ReadonlySet<string>): void;
  /**
   * Move the references to accounts the `'0.87.0'` migration renamed; true when
   * all moved. Absent until the agent registry and the task database exist,
   * and then no rename is carried and every marker stays.
   */
  moveRenamedReferences?(renames: readonly AccountRename[]): Promise<boolean>;
  /** Drop the `renamedFrom` marker from these Claude Code registry rows. */
  dropRenameMarkers?(ids: readonly string[]): Promise<void>;
}

/**
 * Apply every registry transition that is due. Idempotent: a second run changes
 * nothing.
 *
 * @param host - The store being reconciled.
 */
export async function reconcileAccounts(host: ReconcileHost): Promise<void> {
  // Files FIRST, registry LAST: a file flow writes for an account it adds in
  // between is then either listed with its account registered, or not listed.
  const onDisk = {} as Record<LedgerRuntime, LedgerFileEntry[]>;
  for (const runtime of LEDGER_RUNTIMES) onDisk[runtime] = await listLedgerFiles(host.dir(runtime));

  let config: unknown;
  try {
    config = await host.readConfig();
  } catch {
    config = CONFIG_UNREADABLE;
  }
  if (config === CONFIG_UNREADABLE) {
    host.logOnce(
      'config-unreadable',
      '[account-usage] config.json could not be read in full; kept the accounts as they were and deleted no ledger'
    );
    return;
  }
  host.forgetLog('config-unreadable');

  const accounts: RuntimeAccount[] = [];
  for (const runtime of LEDGER_RUNTIMES) {
    const read = resolveRuntimeAccounts(runtime, {
      config,
      realpath: host.realpath,
      defaultFolder: host.resolveDefaultRoot,
    });
    accounts.push(...read.accounts);
    for (const warning of read.warnings) {
      host.logOnce(
        `warn:${runtime}:${warning.code}:${warning.message}`,
        `[account-usage] ${warning.message}`,
        {
          runtime,
          code: warning.code,
        }
      );
    }
  }
  host.setAccounts(accounts);
  await carryRenames(host, accounts);

  const registered = {} as Record<LedgerRuntime, string[]>;
  const diskIds = {} as Record<LedgerRuntime, string[]>;
  for (const runtime of LEDGER_RUNTIMES) {
    registered[runtime] = accounts
      .filter((a) => a.runtime === runtime && a.ledgerId !== null)
      .map((a) => a.ledgerId!);
    diskIds[runtime] = onDisk[runtime].map((e) => e.id);
  }

  for (const runtime of LEDGER_RUNTIMES) {
    const alias = accounts.find((a) => a.runtime === runtime && a.isDefault && !a.implicit);
    if (!alias?.ledgerId) continue;
    await host.moveDefaultInMemory(runtime, alias.ledgerId);
    if (diskIds[runtime].includes(IMPLICIT_ACCOUNT_ID)) {
      await foldDefaultInto(host, runtime, alias.ledgerId);
    }
  }

  const targets = pruneTargets(registered, diskIds);
  // File mtimes are real time, so the age guard is too (never the store's clock).
  const nowMs = Date.now();
  for (const runtime of LEDGER_RUNTIMES) {
    const aliased = accounts.some((a) => a.runtime === runtime && a.isDefault && !a.implicit);
    for (const id of targets[runtime]) {
      // An aliased default's file is folded into its row, never just deleted: a
      // fold that could not run leaves it for the next reconcile.
      if (aliased && id === IMPLICIT_ACCOUNT_ID) continue;
      const entry = onDisk[runtime].find((e) => e.id === id);
      if (!entry || nowMs - entry.mtimeMs < host.pruneMinAgeMs) continue;
      if (await deleteLedger(host.dir(runtime), id, host.lockOptions)) {
        logger.info('[account-usage] deleted the usage ledger of an account that was removed', {
          runtime,
          accountId: id,
        });
      }
    }
    host.forgetUnregistered(runtime, new Set(registered[runtime]));
  }
}

/**
 * Move the references to every Claude Code row the `'0.87.0'` migration
 * renamed, then drop its marker (`account-reference-move.ts`). A failure keeps
 * every marker for the next reconcile; it never stops the rest of this one.
 */
async function carryRenames(host: ReconcileHost, accounts: readonly RuntimeAccount[]) {
  const renamed = accounts.filter(
    (a) => a.runtime === 'claude-code' && a.routable && a.renamedFrom !== undefined
  );
  if (renamed.length === 0 || !host.moveRenamedReferences || !host.dropRenameMarkers) return;
  try {
    const renames = renamed.map((a) => ({ from: a.renamedFrom!, to: a.id }));
    if (!(await host.moveRenamedReferences(renames))) return;
    await host.dropRenameMarkers(renamed.map((a) => a.id));
  } catch (err) {
    host.logOnce(
      'rename-move-failed',
      '[account-usage] could not move every reference to a renamed account; will try again',
      { err: String(err) }
    );
  }
}

/**
 * Readings from a raw version-1 ledger object, unvalidated: `mergeLedger`
 * validates each one and drops (with a warning) only the entries that are bad,
 * so one bad window never costs the others.
 */
function observationsOfRaw(raw: Record<string, unknown>): LedgerObservation[] {
  const out: unknown[] = [];
  const windows = raw.windows as Record<string, unknown>;
  for (const [key, entry] of Object.entries(windows)) {
    if (entry && typeof entry === 'object') out.push({ ...entry, key });
  }
  for (const kind of LEDGER_FACT_KINDS) {
    const fact = raw[kind];
    if (fact && typeof fact === 'object') out.push({ ...fact, kind });
  }
  return out as LedgerObservation[];
}

/**
 * Merge `default.json` into `<aliasId>.json` under both locks, THEN delete
 * `default.json` under its lock, and only when the merge landed. Anything else
 * keeps the file for a later pass: a merge that gave up or that the row's own
 * ledger refused (another version), a `default.json` of another version (left
 * alone, contract §1.2), a read error. Only a file that is not a ledger at all
 * is set aside, as `.corrupt-<ms>`, never deleted.
 */
async function foldDefaultInto(
  host: ReconcileHost,
  runtime: LedgerRuntime,
  aliasId: string
): Promise<void> {
  const dir = host.dir(runtime);
  const file = path.join(dir, `${IMPLICIT_ACCOUNT_ID}.json`);
  const folded = await withLedgerLock(
    dir,
    IMPLICIT_ACCOUNT_ID,
    async (): Promise<boolean> => {
      const standalone = await inspectLedgerFile(dir, IMPLICIT_ACCOUNT_ID);
      if (standalone.state === 'missing') return false;
      if (standalone.state === 'not-a-ledger') {
        await setLedgerAside(dir, IMPLICIT_ACCOUNT_ID);
        return false;
      }
      if (standalone.state !== 'ledger') {
        host.logOnce(
          `fold-skipped:${runtime}:${standalone.state}`,
          '[account-usage] left default.json alone for now; its readings were not merged',
          { runtime, reason: standalone.state }
        );
        return false;
      }
      const result = await writeLedger(
        dir,
        aliasId,
        observationsOfRaw(standalone.raw),
        host.now(),
        { ...host.lockOptions, carryFields: standalone.raw }
      );
      // Landed: written, or unchanged because the row already holds it all. A
      // row ledger of another version took nothing, so default.json stays.
      if (result.gaveUp || result.otherVersion) return false;
      if (result.ledger) host.mergeWritten(runtime, aliasId, result.ledger);
      await fs.promises.rm(file, { force: true });
      return true;
    },
    host.lockOptions
  );
  if (!folded.gaveUp && folded.value) {
    logger.info(
      '[account-usage] the default account is now a registered account; merged its usage',
      { runtime, accountId: aliasId }
    );
  }
}
