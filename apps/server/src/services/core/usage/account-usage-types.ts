/**
 * The types the account usage store is built from and records into, and the
 * flush retry schedule. Split from `account-usage-store.ts` to keep that file
 * about behavior.
 *
 * @module services/core/usage/account-usage-types
 */
import type {
  AccountUsage,
  LedgerCredits,
  LedgerObservation,
  LedgerPlan,
  LedgerRuntime,
  LedgerSpend,
  UsageLedger,
} from '@dorkos/shared/account-usage';
import type { AccountRename } from './account-reference-move.js';
import type { LedgerLockOptions } from './ledger-file.js';
import type { DefaultFolderResolver, RealpathLookup } from './runtime-accounts.js';

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
  /** The wait after a first failed write; it doubles with each further one. Default 1 s. */
  retryBaseMs?: number;
  /** The longest wait between failed writes. Default 60 s. */
  retryMaxMs?: number;
}

/**
 * How long to wait before writing again after `failures` writes in a row
 * failed: `baseMs`, doubling each time, capped at `maxMs`.
 *
 * @param failures - Consecutive failed writes (at least 1).
 * @param baseMs - The first wait.
 * @param maxMs - The cap.
 */
export function flushRetryDelayMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

/** What an `AccountUsageStore` is built from. */
export interface AccountUsageStoreOptions {
  /** The DorkOS data directory; ledgers live under `runtimes/<runtime>/usage/`. */
  dorkHome: string;
  /**
   * Read `<dorkHome>/config.json` from disk, in full, on every call (never a
   * cached copy): `null` when the file is missing, `CONFIG_UNREADABLE` (`account-usage-reconcile.ts`)
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

/** One account's in-memory record (internal to the store). */
export interface UsageRecord {
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
  /** Writes that failed in a row; the next one waits {@link flushRetryDelayMs}. */
  failures: number;
  /** Set when the record was folded into another (its account became an alias): never written again. */
  retired?: boolean;
}

/** How the store moves the references to a renamed account, and drops its marker. */
export interface AccountReferenceMover {
  /** Move every reference; true when all moved. */
  move(renames: readonly AccountRename[]): Promise<boolean>;
  /** Drop the `renamedFrom` marker from these Claude Code registry rows. */
  dropMarkers(ids: readonly string[]): Promise<void>;
}
