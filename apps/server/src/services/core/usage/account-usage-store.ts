/**
 * How much of each account is used, for every runtime: one in-memory record per
 * account, persisted through the usage ledger flow shares
 * (`<dorkHome>/runtimes/<runtime>/usage/<id>.json`).
 *
 * Runtime-neutral (spec `claude-account-fleet` §6 R, D2). Records are keyed by
 * (runtime, ledger id), and an account's identity is its folder
 * (`runtime-accounts.ts`). A session is attributed by the folder it actually
 * runs in: the registered row with that folder, else the runtime's ambient
 * `default` when it is the machine default's folder, else it is memory-only
 * (`accountId: null`, never written to disk). A registered row whose id fails
 * the pattern is memory-only too.
 *
 * - `record()` merges into memory synchronously, so a stream mapper never waits
 *   on disk, then schedules a flush (1 s trailing, one in flight per account).
 * - The ledger files ARE the persistence: `load()` reads them at boot, a folder
 *   watcher and a 60 s scan pick up what flow writes, and `flush()` drains
 *   what is pending at shutdown.
 * - `reconcileAccounts()` applies every registry transition (an account
 *   removed, `default` becoming or ceasing to be an alias) idempotently, from
 *   the files and the config file on disk, because a `flow accounts add` or a
 *   hand edit never reaches `ConfigManager.onChange`.
 * - A change to what an account shows (ignoring `observedAt` and `updatedAt`)
 *   is emitted at most once per account per 2 s, trailing.
 *
 * @module services/core/usage/account-usage-store
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_FACT_KINDS,
  LEDGER_RUNTIMES,
  mergeLedger,
  resolveAccountColor,
  toAccountUsage,
  type AccountUsage,
  type LedgerObservation,
  type LedgerPlan,
  type LedgerRuntime,
  type UsageLedger,
} from '@dorkos/shared/account-usage';
import type { LedgerCredits, LedgerSpend } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import {
  deleteLedger,
  ledgerDir,
  ledgerIdOfFileName,
  listLedgerFiles,
  readLedger,
  withLedgerLock,
  writeLedger,
  type LedgerFileEntry,
  type LedgerLockOptions,
} from './ledger-file.js';
import {
  accountForPath,
  canonicalAccountPath,
  pruneTargets,
  resolveAccountRef,
  resolveRuntimeAccounts,
  systemRealpath,
  type DefaultFolderResolver,
  type RealpathLookup,
  type RuntimeAccount,
} from './runtime-accounts.js';

/** What {@link AccountUsageStoreOptions.readConfig} returns when `config.json` cannot be read in full. */
export const CONFIG_UNREADABLE: unique symbol = Symbol('config-unreadable');

/** Timings, overridable by tests. */
export interface AccountUsageStoreTimings {
  /** Trailing debounce before a record's pending readings are written. Default 1 s. */
  flushDebounceMs?: number;
  /** Trailing throttle on `account_usage` emissions, per account. Default 2 s. */
  broadcastThrottleMs?: number;
  /** Debounce on a ledger folder's change events. Default 500 ms. */
  watchDebounceMs?: number;
  /** The periodic scan (reconcile, new folders, re-read files). Default 60 s. */
  scanIntervalMs?: number;
  /** A ledger file younger than this is never pruned. Default 60 s. */
  pruneMinAgeMs?: number;
}

/** What an {@link AccountUsageStore} is built from. */
export interface AccountUsageStoreOptions {
  /** The DorkOS data directory; ledgers live under `runtimes/<runtime>/usage/`. */
  dorkHome: string;
  /**
   * Read `<dorkHome>/config.json` from disk, in full, on every call (never a
   * cached copy): `null` when the file is missing, {@link CONFIG_UNREADABLE}
   * when it exists but cannot be read or parsed.
   */
  readConfig: () => Promise<unknown>;
  /** The folder each runtime's `default` names (`claude-config-dir.ts`, `codex-home.ts`). */
  resolveDefaultRoot: DefaultFolderResolver;
  /** The real-path lookup folders are compared with. Default: the filesystem. */
  realpath?: RealpathLookup;
  /** The clock. Default: `new Date()`. */
  now?: () => Date;
  /** Where each throttled change goes (the `account_usage` event). */
  broadcast?: (usage: AccountUsage) => void;
  /** Lock timing overrides for the ledger writes. */
  lockOptions?: LedgerLockOptions;
  /** Timing overrides. */
  timings?: AccountUsageStoreTimings;
}

/** Account-level facts a reading may carry beside its windows. */
export interface AccountUsageMeta {
  /** The plan a usage call reported; memory only, never written. */
  subscriptionType?: string | null;
  /** A plan fact to merge (with its own `observedAt` and `source`). */
  plan?: LedgerPlan;
  /** A credits fact to merge. */
  credits?: LedgerCredits;
  /** A spend fact to merge. */
  spend?: LedgerSpend;
}

/** Which account a reading belongs to: a folder a session runs in, or an id. */
export type AccountKey = { path: string } | { accountId: string };

interface UsageRecord {
  runtime: LedgerRuntime;
  /** The ledger id, or `null` for a memory-only root. */
  ledgerId: string | null;
  /** The canonical folder of a memory-only root. */
  path: string;
  ledger: UsageLedger | null;
  pending: LedgerObservation[];
  subscriptionType: string | null;
  flushTimer?: NodeJS.Timeout;
  flushing?: Promise<void>;
  broadcastTimer?: NodeJS.Timeout;
  lastSignature?: string;
  lastFlushWarnAt?: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** The windows and facts of a ledger, as observations, so two ledgers merge newest-wins. */
function observationsOf(ledger: UsageLedger | null): LedgerObservation[] {
  if (!ledger) return [];
  const out: LedgerObservation[] = [];
  for (const [key, entry] of Object.entries(ledger.windows)) out.push({ key, ...entry });
  for (const kind of LEDGER_FACT_KINDS) {
    const fact = ledger[kind];
    if (fact) out.push({ kind, ...fact } as LedgerObservation);
  }
  return out;
}

/** What an account shows, minus the parts that change on every reading. */
function signatureOf(usage: AccountUsage): string {
  return JSON.stringify({
    ...usage,
    updatedAt: null,
    windows: usage.windows.map((w) => ({ ...w, observedAt: null })),
  });
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.();
  return timer;
}

/** The runtime-neutral per-account usage store. See the module TSDoc. */
export class AccountUsageStore {
  private readonly opts: AccountUsageStoreOptions;
  private readonly timings: Required<AccountUsageStoreTimings>;
  private readonly realpath: RealpathLookup;
  private accounts: RuntimeAccount[] = [];
  private readonly records = new Map<string, UsageRecord>();
  private readonly listeners = new Set<(usage: AccountUsage) => void>();
  private readonly watchers = new Map<LedgerRuntime, fs.FSWatcher>();
  private readonly watchTimers = new Map<LedgerRuntime, NodeJS.Timeout>();
  private readonly loggedOnce = new Set<string>();
  private scanTimer?: NodeJS.Timeout;
  private reconciling?: Promise<void>;
  private stopped = false;

  /**
   * Build a store; nothing is read until {@link load}.
   *
   * @param opts - See {@link AccountUsageStoreOptions}.
   */
  constructor(opts: AccountUsageStoreOptions) {
    this.opts = opts;
    this.realpath = opts.realpath ?? systemRealpath;
    this.timings = {
      flushDebounceMs: 1_000,
      broadcastThrottleMs: 2_000,
      watchDebounceMs: 500,
      scanIntervalMs: 60_000,
      pruneMinAgeMs: 60_000,
      ...opts.timings,
    };
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private dir(runtime: LedgerRuntime): string {
    return ledgerDir(this.opts.dorkHome, runtime);
  }

  private logOnce(key: string, message: string, meta?: Record<string, unknown>): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    logger.warn(message, meta);
  }

  // === Lifecycle ===

  /**
   * Boot: reconcile the registry with the ledger files, read every ledger into
   * memory, watch the folders that exist, and start the 60 s scan. Readings
   * loaded here set each account's baseline, so boot emits nothing.
   */
  async load(): Promise<void> {
    await this.reconcileAccounts();
    await this.reloadFiles({ baseline: true });
    this.watchExistingDirs();
    if (!this.scanTimer) {
      this.scanTimer = unref(setInterval(() => void this.scan(), this.timings.scanIntervalMs));
    }
  }

  /** The periodic scan: reconcile, watch new folders, and re-read every file. */
  async scan(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reconcileAccounts();
      this.watchExistingDirs();
      await this.reloadFiles({ baseline: false });
    } catch (err) {
      logger.warn('[account-usage] usage scan failed', { err: String(err) });
    }
  }

  /** Write every account's pending readings now (at shutdown), and wait for writes in flight. */
  async flush(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = undefined;
      }
      if (record.ledgerId !== null && (record.pending.length > 0 || record.flushing)) {
        work.push(this.flushRecord(record));
      }
    }
    await Promise.all(work);
  }

  /** Stop the watchers, the scan and every timer. Pending readings are left for {@link flush}. */
  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const record of this.records.values()) {
      if (record.flushTimer) clearTimeout(record.flushTimer);
      if (record.broadcastTimer) clearTimeout(record.broadcastTimer);
      record.flushTimer = undefined;
      record.broadcastTimer = undefined;
    }
  }

  /**
   * Listen for throttled changes to what an account shows.
   *
   * @param listener - Called with the account's new usage.
   * @returns An unsubscribe function.
   */
  onChange(listener: (usage: AccountUsage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // === Recording ===

  /**
   * Merge readings into one account's record, synchronously, and schedule the
   * write. A file-backed account (a routable registered id, or a standalone
   * `default`) is flushed; a memory-only root never is.
   *
   * @param runtime - The account's runtime.
   * @param key - The folder the session runs in, or an account id (`default` resolves to its alias).
   * @param observations - Window and fact readings.
   * @param meta - Facts and the in-memory subscription type.
   */
  record(
    runtime: LedgerRuntime,
    key: AccountKey,
    observations: readonly LedgerObservation[],
    meta: AccountUsageMeta = {}
  ): void {
    const record = this.recordFor(runtime, key);
    if (!record) return;
    const all: LedgerObservation[] = [...observations];
    if (meta.plan) all.push({ kind: 'plan', ...meta.plan });
    if (meta.credits) all.push({ kind: 'credits', ...meta.credits });
    if (meta.spend) all.push({ kind: 'spend', ...meta.spend });
    if (meta.subscriptionType !== undefined) record.subscriptionType = meta.subscriptionType;
    if (all.length > 0) {
      const merged = mergeLedger(record.ledger, all, this.now(), {
        runtime,
        // A memory-only record is never written, so the id in its ledger is a placeholder.
        accountId: record.ledgerId ?? IMPLICIT_ACCOUNT_ID,
      });
      if (merged.warnings.length > 0) {
        logger.debug('[account-usage] readings set aside', { runtime, warnings: merged.warnings });
      }
      if (merged.changed) record.ledger = merged.ledger;
      if (record.ledgerId !== null) {
        record.pending.push(...all);
        this.scheduleFlush(record);
      }
    }
    this.scheduleBroadcast(record);
  }

  /** Find or create the record a reading belongs to, or `null` for an unknown id. */
  private recordFor(runtime: LedgerRuntime, key: AccountKey): UsageRecord | null {
    let account: RuntimeAccount | null;
    let rootPath: string | null = null;
    if ('accountId' in key) {
      account = resolveAccountRef(this.accounts, runtime, key.accountId);
      if (!account) {
        this.logOnce(
          `unknown:${runtime}:${key.accountId}`,
          '[account-usage] a reading named an account that is not registered; kept nothing',
          { runtime, accountId: key.accountId }
        );
        return null;
      }
    } else {
      rootPath = canonicalAccountPath(key.path, undefined, this.realpath);
      account = accountForPath(this.accounts, runtime, key.path, undefined, this.realpath);
    }
    if (account?.ledgerId) return this.fileRecord(runtime, account.ledgerId);
    const memoryPath = account?.canonicalPath ?? rootPath;
    if (memoryPath === null) return null;
    this.logOnce(
      `memory:${runtime}:${memoryPath}`,
      '[account-usage] readings for a folder that is neither a registered account nor the default are kept in memory only',
      { runtime, path: memoryPath }
    );
    return this.memoryRecord(runtime, memoryPath);
  }

  private fileRecord(runtime: LedgerRuntime, ledgerId: string): UsageRecord {
    const mapKey = `${runtime}:${ledgerId}`;
    let record = this.records.get(mapKey);
    if (!record) {
      record = { runtime, ledgerId, path: '', ledger: null, pending: [], subscriptionType: null };
      this.records.set(mapKey, record);
    }
    return record;
  }

  private memoryRecord(runtime: LedgerRuntime, canonical: string): UsageRecord {
    const mapKey = `${runtime}@${canonical}`;
    let record = this.records.get(mapKey);
    if (!record) {
      record = {
        runtime,
        ledgerId: null,
        path: canonical,
        ledger: null,
        pending: [],
        subscriptionType: null,
      };
      this.records.set(mapKey, record);
    }
    return record;
  }

  // === Flushing ===

  private scheduleFlush(record: UsageRecord): void {
    if (this.stopped || record.flushTimer) return;
    record.flushTimer = unref(
      setTimeout(() => {
        record.flushTimer = undefined;
        void this.flushRecord(record);
      }, this.timings.flushDebounceMs)
    );
  }

  /** Write one record's pending readings; one write in flight per account. */
  private flushRecord(record: UsageRecord): Promise<void> {
    if (record.flushing) {
      // Chain after the write in flight, so readings that arrived during it go next.
      return record.flushing.then(() =>
        record.pending.length > 0 ? this.flushRecord(record) : undefined
      );
    }
    const ledgerId = record.ledgerId;
    if (ledgerId === null || record.pending.length === 0) return Promise.resolve();
    const batch = record.pending;
    record.pending = [];
    record.flushing = (async () => {
      try {
        const result = await writeLedger(
          this.dir(record.runtime),
          ledgerId,
          batch,
          this.now(),
          this.opts.lockOptions
        );
        if (result.gaveUp) {
          record.pending = [...batch, ...record.pending];
          this.warnFlush(record, 'the ledger stayed locked');
          return;
        }
        if (result.ledger) this.mergeFileIntoMemory(record, result.ledger);
      } catch (err) {
        record.pending = [...batch, ...record.pending];
        this.warnFlush(record, String(err));
      } finally {
        record.flushing = undefined;
      }
    })();
    return record.flushing;
  }

  private warnFlush(record: UsageRecord, reason: string): void {
    const at = Date.now();
    if (record.lastFlushWarnAt !== undefined && at - record.lastFlushWarnAt < HOUR_MS) return;
    record.lastFlushWarnAt = at;
    logger.warn('[account-usage] could not write a usage ledger; kept the readings for next time', {
      runtime: record.runtime,
      accountId: record.ledgerId,
      reason,
    });
  }

  /** Make memory the newest of the file and what memory already held. */
  private mergeFileIntoMemory(record: UsageRecord, fileLedger: UsageLedger): void {
    if (record.ledger === null) {
      record.ledger = fileLedger;
      return;
    }
    const merged = mergeLedger(fileLedger, observationsOf(record.ledger), this.now(), {
      runtime: record.runtime,
      accountId: record.ledgerId ?? IMPLICIT_ACCOUNT_ID,
    });
    record.ledger = merged.changed ? merged.ledger : fileLedger;
  }

  // === Emitting ===

  private scheduleBroadcast(record: UsageRecord): void {
    if (this.stopped || record.broadcastTimer) return;
    record.broadcastTimer = unref(
      setTimeout(() => {
        record.broadcastTimer = undefined;
        this.emitIfChanged(record);
      }, this.timings.broadcastThrottleMs)
    );
  }

  private emitIfChanged(record: UsageRecord): void {
    const usage = this.usageOfRecord(record);
    if (!usage) return;
    const signature = signatureOf(usage);
    if (signature === record.lastSignature) return;
    record.lastSignature = signature;
    try {
      this.opts.broadcast?.(usage);
    } catch (err) {
      logger.warn('[account-usage] account_usage broadcast failed', { err: String(err) });
    }
    for (const listener of this.listeners) {
      try {
        listener(usage);
      } catch (err) {
        logger.warn('[account-usage] usage listener failed', { err: String(err) });
      }
    }
  }

  // === Reading ===

  /**
   * Every account's usage, from memory (no disk work): per runtime, registered
   * accounts in registry order, the ambient `default` when it stands alone, then
   * memory-only roots.
   *
   * @param runtime - Only this runtime's accounts; every runtime when omitted.
   */
  list(runtime?: LedgerRuntime): AccountUsage[] {
    const out: AccountUsage[] = [];
    for (const r of LEDGER_RUNTIMES) {
      if (runtime !== undefined && r !== runtime) continue;
      const accounts = this.accounts.filter((a) => a.runtime === r);
      const listedPaths = new Set<string>();
      for (const account of accounts) {
        out.push(this.usageOfAccount(account));
        if (account.canonicalPath) listedPaths.add(account.canonicalPath);
      }
      let position = accounts.length;
      for (const record of this.records.values()) {
        if (record.runtime !== r || record.ledgerId !== null || listedPaths.has(record.path)) {
          continue;
        }
        out.push(this.memoryUsage(record, position++));
      }
    }
    return out;
  }

  /**
   * Named accounts' usage, from memory only (synchronous). `default` resolves to
   * its alias. Unknown ids are left out.
   *
   * @param runtime - The accounts' runtime.
   * @param accountIds - Registry ids, or `default`.
   */
  peek(runtime: LedgerRuntime, accountIds: readonly string[]): AccountUsage[] {
    const out: AccountUsage[] = [];
    for (const id of accountIds) {
      const account = resolveAccountRef(this.accounts, runtime, id);
      if (account) out.push(this.usageOfAccount(account));
    }
    return out;
  }

  /** The accounts as the store last resolved them (registry plus `default`). */
  resolvedAccounts(): readonly RuntimeAccount[] {
    return this.accounts;
  }

  private usageOfAccount(account: RuntimeAccount): AccountUsage {
    const record =
      account.ledgerId !== null
        ? this.records.get(`${account.runtime}:${account.ledgerId}`)
        : account.canonicalPath !== null
          ? this.records.get(`${account.runtime}@${account.canonicalPath}`)
          : undefined;
    return toAccountUsage(
      record?.ledger ?? null,
      {
        runtime: account.runtime,
        accountId: account.routable ? account.id : null,
        path: account.path ?? '',
        label: account.label,
        color: account.color,
      },
      this.now(),
      record?.subscriptionType ?? null
    );
  }

  private memoryUsage(record: UsageRecord, position: number): AccountUsage {
    return toAccountUsage(
      record.ledger,
      {
        runtime: record.runtime,
        accountId: null,
        path: record.path,
        label: null,
        color: resolveAccountColor(null, position),
      },
      this.now(),
      record.subscriptionType
    );
  }

  private usageOfRecord(record: UsageRecord): AccountUsage | null {
    if (record.ledgerId !== null) {
      const account = this.accounts.find(
        (a) => a.runtime === record.runtime && a.ledgerId === record.ledgerId
      );
      return account ? this.usageOfAccount(account) : null;
    }
    const account = this.accounts.find(
      (a) => a.runtime === record.runtime && a.canonicalPath === record.path
    );
    if (account) return this.usageOfAccount(account);
    const position = this.accounts.filter((a) => a.runtime === record.runtime).length;
    return this.memoryUsage(record, position);
  }

  // === Files ===

  /** Read every known account's ledger file into memory. */
  private async reloadFiles({ baseline }: { baseline: boolean }): Promise<void> {
    for (const runtime of LEDGER_RUNTIMES) await this.reloadRuntime(runtime, baseline);
  }

  private async reloadRuntime(runtime: LedgerRuntime, baseline = false): Promise<void> {
    const dir = this.dir(runtime);
    const known = new Set(
      this.accounts
        .filter((a) => a.runtime === runtime && a.ledgerId !== null)
        .map((a) => a.ledgerId!)
    );
    for (const entry of await listLedgerFiles(dir)) {
      if (!known.has(entry.id)) continue;
      const ledger = await readLedger(dir, entry.id);
      if (!ledger) continue;
      const record = this.fileRecord(runtime, entry.id);
      this.mergeFileIntoMemory(record, ledger);
      if (baseline) {
        const usage = this.usageOfRecord(record);
        if (usage) record.lastSignature = signatureOf(usage);
      } else {
        this.scheduleBroadcast(record);
      }
    }
  }

  /** Watch each runtime's ledger folder that exists now; later ones are found by the scan. */
  private watchExistingDirs(): void {
    if (this.stopped) return;
    for (const runtime of LEDGER_RUNTIMES) {
      if (this.watchers.has(runtime)) continue;
      const dir = this.dir(runtime);
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename && ledgerIdOfFileName(filename.toString()) === null) return;
          this.onDirChange(runtime);
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(runtime);
        });
        watcher.unref?.();
        this.watchers.set(runtime, watcher);
      } catch (err) {
        logger.debug('[account-usage] could not watch a ledger folder', { dir, err: String(err) });
      }
    }
  }

  private onDirChange(runtime: LedgerRuntime): void {
    const existing = this.watchTimers.get(runtime);
    if (existing) clearTimeout(existing);
    this.watchTimers.set(
      runtime,
      unref(
        setTimeout(() => {
          this.watchTimers.delete(runtime);
          void this.reloadRuntime(runtime).catch((err: unknown) => {
            logger.debug('[account-usage] ledger re-read failed', { runtime, err: String(err) });
          });
        }, this.timings.watchDebounceMs)
      )
    );
  }

  // === Registry transitions ===

  /**
   * Bring memory and the ledger files in line with the registry on disk
   * (spec §6 R "Registry transitions keep state"). Idempotent; run at boot, on
   * every scan and after an in-app config write.
   *
   * The ledger files are listed FIRST and the registry read LAST, and a file
   * younger than 60 s is never pruned, so a ledger flow writes for an account it
   * has just added is not removed. Nothing is deleted when `config.json` cannot
   * be read in full.
   */
  reconcileAccounts(): Promise<void> {
    if (!this.reconciling) {
      this.reconciling = this.doReconcile().finally(() => {
        this.reconciling = undefined;
      });
    }
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const onDisk = {} as Record<LedgerRuntime, LedgerFileEntry[]>;
    for (const runtime of LEDGER_RUNTIMES)
      onDisk[runtime] = await listLedgerFiles(this.dir(runtime));

    let config: unknown;
    try {
      config = await this.opts.readConfig();
    } catch {
      config = CONFIG_UNREADABLE;
    }
    if (config === CONFIG_UNREADABLE) {
      this.logOnce(
        'config-unreadable',
        '[account-usage] config.json could not be read in full; kept the accounts as they were and deleted no ledger'
      );
      return;
    }
    this.loggedOnce.delete('config-unreadable');

    const accounts: RuntimeAccount[] = [];
    for (const runtime of LEDGER_RUNTIMES) {
      const read = resolveRuntimeAccounts(runtime, {
        config,
        realpath: this.realpath,
        defaultFolder: this.opts.resolveDefaultRoot,
      });
      accounts.push(...read.accounts);
      for (const warning of read.warnings) {
        this.logOnce(
          `warn:${runtime}:${warning.code}:${warning.message}`,
          '[account-usage] ' + warning.message,
          {
            runtime,
            code: warning.code,
          }
        );
      }
    }
    this.accounts = accounts;

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
      if (alias?.ledgerId) await this.foldDefaultInto(runtime, alias.ledgerId, diskIds[runtime]);
    }

    const targets = pruneTargets(registered, diskIds);
    const nowMs = this.now().getTime();
    for (const runtime of LEDGER_RUNTIMES) {
      const aliased = accounts.some((a) => a.runtime === runtime && a.isDefault && !a.implicit);
      for (const id of targets[runtime]) {
        // An aliased default's file was folded into its row above, never just deleted.
        if (aliased && id === IMPLICIT_ACCOUNT_ID) continue;
        const entry = onDisk[runtime].find((e) => e.id === id);
        if (!entry || nowMs - entry.mtimeMs < this.timings.pruneMinAgeMs) continue;
        const deleted = await deleteLedger(this.dir(runtime), id, this.opts.lockOptions);
        if (deleted) {
          logger.info('[account-usage] deleted the usage ledger of an account that was removed', {
            runtime,
            accountId: id,
          });
        }
      }
      // Forget file-backed records whose account is no longer registered.
      const known = new Set(registered[runtime]);
      for (const [mapKey, record] of this.records) {
        if (record.runtime !== runtime || record.ledgerId === null) continue;
        if (known.has(record.ledgerId)) continue;
        if (record.flushTimer) clearTimeout(record.flushTimer);
        if (record.broadcastTimer) clearTimeout(record.broadcastTimer);
        this.records.delete(mapKey);
      }
    }
  }

  /**
   * `default` became an alias of `aliasId`: merge `default.json` into
   * `<aliasId>.json` under both locks, THEN delete `default.json` under its
   * lock, and move the in-memory `default` record's readings to the row, so
   * nothing writes `default.json` while aliased.
   */
  private async foldDefaultInto(
    runtime: LedgerRuntime,
    aliasId: string,
    diskIds: string[]
  ): Promise<void> {
    const memory = this.records.get(`${runtime}:${IMPLICIT_ACCOUNT_ID}`);
    if (memory) {
      if (memory.flushTimer) clearTimeout(memory.flushTimer);
      if (memory.broadcastTimer) clearTimeout(memory.broadcastTimer);
      await memory.flushing;
      this.records.delete(`${runtime}:${IMPLICIT_ACCOUNT_ID}`);
      const target = this.fileRecord(runtime, aliasId);
      const moved = [...observationsOf(memory.ledger), ...memory.pending];
      if (moved.length > 0) {
        this.record(runtime, { accountId: aliasId }, moved, {
          subscriptionType: target.subscriptionType ?? memory.subscriptionType,
        });
      }
    }
    if (!diskIds.includes(IMPLICIT_ACCOUNT_ID)) return;
    const dir = this.dir(runtime);
    const folded = await withLedgerLock(
      dir,
      IMPLICIT_ACCOUNT_ID,
      async () => {
        const standalone = await readLedger(dir, IMPLICIT_ACCOUNT_ID);
        if (standalone) {
          const result = await writeLedger(
            dir,
            aliasId,
            observationsOf(standalone),
            this.now(),
            this.opts.lockOptions
          );
          if (result.gaveUp) return false;
          if (result.ledger)
            this.mergeFileIntoMemory(this.fileRecord(runtime, aliasId), result.ledger);
        }
        await fs.promises.rm(path.join(dir, `${IMPLICIT_ACCOUNT_ID}.json`), { force: true });
        return true;
      },
      this.opts.lockOptions
    );
    if (!folded.gaveUp && folded.value) {
      logger.info(
        '[account-usage] the default account is now a registered account; merged its usage',
        {
          runtime,
          accountId: aliasId,
        }
      );
    }
  }
}

/**
 * Read a `config.json` from disk, in full, for {@link AccountUsageStoreOptions.readConfig}:
 * `null` when the file is missing (no registered accounts), {@link CONFIG_UNREADABLE}
 * when it exists but cannot be read or parsed (so nothing is deleted on its word).
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

let currentStore: AccountUsageStore | undefined;

/**
 * Install the process's one usage store, so the runtime feeds, the route and
 * the MCP tool reach it (mirrors `setSessionEventStore`).
 *
 * @param store - The store, or `undefined` to clear it (tests).
 */
export function setAccountUsageStore(store: AccountUsageStore | undefined): void {
  currentStore = store;
}

/** The installed usage store, or `undefined` before boot wires one. */
export function getAccountUsageStore(): AccountUsageStore | undefined {
  return currentStore;
}
