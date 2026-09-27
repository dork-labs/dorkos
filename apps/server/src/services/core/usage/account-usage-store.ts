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
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_RUNTIMES,
  mergeLedger,
  type AccountUsage,
  type LedgerObservation,
  type LedgerRuntime,
  type UsageLedger,
} from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import { ledgerDir, listLedgerFiles, readLedger, writeLedger } from './ledger-file.js';
import {
  accountForPath,
  canonicalAccountPath,
  resolveAccountRef,
  systemRealpath,
  type RealpathLookup,
  type RuntimeAccount,
} from './runtime-accounts.js';
import {
  observationsOf,
  reconcileAccounts,
  type ReconcileHost,
} from './account-usage-reconcile.js';
import { LedgerFolderWatcher } from './ledger-folder-watcher.js';
import { memoryUsage, usageOfAccount, usageOfRecord } from './account-usage-view.js';
import {
  flushRetryDelayMs,
  type AccountKey,
  type AccountReferenceMover,
  type AccountUsageMeta,
  type AccountUsageStoreOptions,
  type AccountUsageStoreTimings,
  type UsageRecord,
} from './account-usage-types.js';

const HOUR_MS = 60 * 60 * 1000;

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
  private readonly watcher: LedgerFolderWatcher;
  private readonly loggedOnce = new Set<string>();
  private scanTimer?: NodeJS.Timeout;
  private reconciling?: Promise<void>;
  private referenceMover?: AccountReferenceMover;
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
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
      ...opts.timings,
    };
    this.watcher = new LedgerFolderWatcher(
      (runtime) => this.dir(runtime),
      this.timings.watchDebounceMs,
      (runtime) => {
        void this.reloadRuntime(runtime).catch((err: unknown) => {
          logger.debug('[account-usage] ledger re-read failed', { runtime, err: String(err) });
        });
      }
    );
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
    // A failed reconcile or read must not stop the watch and the scan from
    // starting: the next scan retries it.
    try {
      await this.reconcileAccounts();
      await this.reloadFiles({ baseline: true });
    } catch (err) {
      logger.warn('[account-usage] usage load failed; the next scan retries it', {
        err: String(err),
      });
    }
    this.watcher.watchExisting();
    if (!this.scanTimer) {
      this.scanTimer = unref(setInterval(() => void this.scan(), this.timings.scanIntervalMs));
    }
  }

  /** The periodic scan: reconcile, watch new folders, and re-read every file. */
  async scan(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reconcileAccounts();
      this.watcher.watchExisting();
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
    this.watcher.close();
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
        this.setPending(record, [...record.pending, ...all]);
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
    return this.recordAt(`${runtime}:${ledgerId}`, runtime, ledgerId, '');
  }

  private memoryRecord(runtime: LedgerRuntime, canonical: string): UsageRecord {
    return this.recordAt(`${runtime}@${canonical}`, runtime, null, canonical);
  }

  /** The record under `mapKey`, created empty when missing. */
  private recordAt(
    mapKey: string,
    runtime: LedgerRuntime,
    ledgerId: string | null,
    path: string
  ): UsageRecord {
    let record = this.records.get(mapKey);
    if (!record) {
      record = {
        runtime,
        ledgerId,
        path,
        ledger: null,
        pending: [],
        subscriptionType: null,
        failures: 0,
      };
      this.records.set(mapKey, record);
    }
    return record;
  }

  // === Flushing ===

  private scheduleFlush(record: UsageRecord): void {
    if (this.stopped || record.retired || record.flushTimer) return;
    const { flushDebounceMs, retryBaseMs, retryMaxMs } = this.timings;
    const delay =
      record.failures > 0
        ? flushRetryDelayMs(record.failures, retryBaseMs, retryMaxMs)
        : flushDebounceMs;
    record.flushTimer = unref(
      setTimeout(() => {
        record.flushTimer = undefined;
        void this.flushRecord(record);
      }, delay)
    );
  }

  /**
   * Hold at most one pending reading per window and fact (the newest), so a
   * ledger that stays unwritable never grows memory.
   */
  private setPending(record: UsageRecord, observations: LedgerObservation[]): void {
    const collapsed = mergeLedger(null, observations, this.now(), {
      runtime: record.runtime,
      accountId: record.ledgerId ?? IMPLICIT_ACCOUNT_ID,
    });
    for (const warning of collapsed.warnings) {
      this.logOnce(
        `pending:${record.runtime}:${record.ledgerId}:${warning.code}:${warning.key ?? ''}`,
        '[account-usage] a usage reading was set aside and will not be written',
        { runtime: record.runtime, accountId: record.ledgerId, ...warning }
      );
    }
    record.pending = collapsed.changed ? observationsOf(collapsed.ledger) : [];
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
    if (ledgerId === null || record.retired || record.pending.length === 0) {
      return Promise.resolve();
    }
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
        if (result.gaveUp || result.otherVersion) {
          this.putBack(record, batch);
          this.warnFlush(
            record,
            result.gaveUp ? 'the ledger stayed locked' : 'the ledger is of another version'
          );
          return;
        }
        if (record.failures > 0) {
          // Back to the normal pace: a reading that arrived during this write
          // was scheduled at the backoff wait, so reschedule it (in `finally`).
          record.failures = 0;
          if (record.flushTimer) clearTimeout(record.flushTimer);
          record.flushTimer = undefined;
        }
        if (result.ledger) this.mergeFileIntoMemory(record, result.ledger);
      } catch (err) {
        this.putBack(record, batch);
        this.warnFlush(record, String(err));
      } finally {
        record.flushing = undefined;
        // Readings put back after a give-up or a failed write must not wait for
        // the next reading to reach disk.
        if (record.pending.length > 0) this.scheduleFlush(record);
      }
    })();
    return record.flushing;
  }

  /** A write failed: keep its readings (newest per key) and back off the next try. */
  private putBack(record: UsageRecord, batch: LedgerObservation[]): void {
    record.failures += 1;
    this.setPending(record, [...batch, ...record.pending]);
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
        out.push(memoryUsage(record, position++, this.now()));
      }
    }
    return out;
  }

  /**
   * The accounts the registry and each runtime's `default` resolve to, in
   * registry order with a standalone `default` last (an alias `default` is its
   * row, not a second entry). Memory-only roots are not accounts and are left out.
   *
   * @param runtime - Only this runtime's accounts; every runtime when omitted.
   */
  listAccounts(runtime?: LedgerRuntime): readonly RuntimeAccount[] {
    return runtime === undefined
      ? [...this.accounts]
      : this.accounts.filter((a) => a.runtime === runtime);
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

  /**
   * The usage of whichever account a session running in `dir` bills, from
   * memory only (synchronous): a registered account or the runtime's own
   * `default` when the folder matches one, else a memory-only root the store
   * has readings for, else `null`.
   *
   * @param runtime - The account's runtime.
   * @param dir - The folder the session runs in.
   */
  usageAtPath(runtime: LedgerRuntime, dir: string): AccountUsage | null {
    const account = accountForPath(this.accounts, runtime, dir, undefined, this.realpath);
    if (account) return this.usageOfAccount(account);
    const canonical = canonicalAccountPath(dir, undefined, this.realpath);
    const record = this.records.get(`${runtime}@${canonical}`);
    return record ? this.usageOfRecord(record) : null;
  }

  /**
   * One account's usage, from memory (synchronous).
   *
   * @param account - An account from {@link listAccounts}.
   */
  usageOfAccount(account: RuntimeAccount): AccountUsage {
    return usageOfAccount(account, this.records, this.now());
  }

  private usageOfRecord(record: UsageRecord): AccountUsage | null {
    return usageOfRecord(record, this.accounts, this.records, this.now());
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

  // === Registry transitions ===

  /**
   * Bring memory and the ledger files in line with the registry on disk
   * (`account-usage-reconcile.ts`). Idempotent, and never two at once; run at
   * boot, on every scan and after an in-app config write.
   *
   * @param opts - `fresh` waits for a pass in flight and runs a new one.
   */
  async reconcileAccounts(opts: { fresh?: boolean } = {}): Promise<void> {
    // `fresh`: a pass already running was built before whatever the caller just
    // wired (the reference mover), so wait it out and start a new one.
    if (opts.fresh) {
      while (this.reconciling) await this.reconciling.catch(() => {});
    }
    if (!this.reconciling) {
      this.reconciling = reconcileAccounts(this.reconcileHost()).finally(() => {
        this.reconciling = undefined;
      });
    }
    return this.reconciling;
  }

  /**
   * Wire the reference move for accounts the `'0.87.0'` migration renamed. Set
   * once the agent registry and the task database exist; until then every
   * rename keeps its marker, and the launch ladder keeps resolving `default`
   * to the renamed row.
   *
   * @param mover - How to move the references and then drop the markers.
   */
  setReferenceMover(mover: AccountReferenceMover | undefined): void {
    this.referenceMover = mover;
  }

  private reconcileHost(): ReconcileHost {
    const mover = this.referenceMover;
    return {
      ...(mover
        ? {
            moveRenamedReferences: (renames) => mover.move(renames),
            dropRenameMarkers: (ids) => mover.dropMarkers(ids),
          }
        : {}),
      dir: (runtime) => this.dir(runtime),
      readConfig: this.opts.readConfig,
      resolveDefaultRoot: this.opts.resolveDefaultRoot,
      realpath: this.realpath,
      lockOptions: this.opts.lockOptions,
      pruneMinAgeMs: this.timings.pruneMinAgeMs,
      now: () => this.now(),
      logOnce: (key, message, meta) => this.logOnce(key, message, meta),
      forgetLog: (key) => this.loggedOnce.delete(key),
      setAccounts: (accounts) => {
        this.accounts = accounts;
      },
      moveDefaultInMemory: (runtime, aliasId) => this.moveDefaultInMemory(runtime, aliasId),
      mergeWritten: (runtime, id, ledger) =>
        this.mergeFileIntoMemory(this.fileRecord(runtime, id), ledger),
      forgetUnregistered: (runtime, registered) => this.forgetUnregistered(runtime, registered),
    };
  }

  /** `default` became an alias of `aliasId`: move its in-memory readings to the row. */
  private async moveDefaultInMemory(runtime: LedgerRuntime, aliasId: string): Promise<void> {
    const memory = this.records.get(`${runtime}:${IMPLICIT_ACCOUNT_ID}`);
    if (!memory) return;
    // Let a write in flight finish first: if it fails it puts its readings back
    // and schedules a retry, so the timers are cleared only AFTER it, and the
    // record is marked retired so nothing writes `default.json` again.
    while (memory.flushing) await memory.flushing;
    memory.retired = true;
    if (memory.flushTimer) clearTimeout(memory.flushTimer);
    if (memory.broadcastTimer) clearTimeout(memory.broadcastTimer);
    memory.flushTimer = undefined;
    memory.broadcastTimer = undefined;
    this.records.delete(`${runtime}:${IMPLICIT_ACCOUNT_ID}`);
    const target = this.fileRecord(runtime, aliasId);
    const moved = [...observationsOf(memory.ledger), ...memory.pending];
    if (moved.length > 0) {
      this.record(runtime, { accountId: aliasId }, moved, {
        subscriptionType: target.subscriptionType ?? memory.subscriptionType,
      });
    }
  }

  /** Forget file-backed records whose account is no longer registered. */
  private forgetUnregistered(runtime: LedgerRuntime, registered: ReadonlySet<string>): void {
    for (const [mapKey, record] of this.records) {
      if (record.runtime !== runtime || record.ledgerId === null) continue;
      if (registered.has(record.ledgerId)) continue;
      if (record.flushTimer) clearTimeout(record.flushTimer);
      if (record.broadcastTimer) clearTimeout(record.broadcastTimer);
      this.records.delete(mapKey);
    }
  }
}
