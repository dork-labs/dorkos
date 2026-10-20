/**
 * The history line for accounts kept out of automatic moves (Re-seat P0,
 * Security's review).
 *
 * When a room seat's account runs out, DorkOS moves the seat to another
 * account on its own. A Claude account whose `noAutoMove` flag is on is never
 * picked for such a move (`reseat-accounts.ts`), though a person may still
 * move a seat to it by naming it. The `'0.124.1'` config migration turns the
 * flag on for one account. That is a change to what agents may spend, so it
 * owes the person a line in the permission history with an Undo, the way the
 * one-time raise of existing chats does (`existing-chats-raise.ts`).
 *
 * ## Why the line follows the change
 *
 * Config migrations run before the Activity service exists, so the migration
 * cannot write the line itself. This runs once, at startup, and records every
 * account whose stored flag is on, as ONE `permission.changed` event. The flag
 * did not exist before the migration and no Settings control sets it yet, so
 * on the first boot after the migration every account with the flag on is one
 * the migration flipped (short of a hand edit made before that boot).
 *
 * ## Once
 *
 * The history event is written first, then a done file in DorkOS's own data
 * directory. Either one marks the step as done, so a later boot never records
 * a flag a person set since. A boot with nothing to record still writes the
 * done file. A failed history write leaves no done file, and the next boot
 * tries again.
 *
 * ## Undo
 *
 * The Undo turns the flag back off, so agents may move there on their own
 * again; the Undo of that Undo turns it back on. An account that is no longer
 * registered is reported as skipped, never a reason to fail the rest.
 *
 * @module services/core/permissions/kept-from-auto-moves
 */
import fs from 'node:fs';
import path from 'node:path';

import { readClaudeAccountSettings } from '@dorkos/shared/config-schema';
import {
  KEPT_FROM_AUTO_MOVES,
  type PermissionChange,
  type PermissionUndoSkip,
} from '@dorkos/shared/permissions';
import type { Logger } from '@dorkos/shared/logger';

import type { ActivityService } from '../../activity/activity-service.js';
import { writeNoAutoMove, type RuntimesStore } from '../usage/account-eligibility-writes.js';
import { UPGRADE_WRITER, recordPermissionChange } from './permission-history.js';

/** The note the history shows beside the line. */
export const KEPT_FROM_AUTO_MOVES_NOTE =
  'DorkOS won’t move agents to this account on its own. You can still move one yourself.';

/** Reads and writes the `noAutoMove` flag on the registered Claude accounts. */
export interface AutoMoveFlagPort {
  /** `'on'` when the account is kept out, `null` when not, `'gone'` when no account has the id. */
  flagOf: (accountId: string) => typeof KEPT_FROM_AUTO_MOVES | null | 'gone';
  /** Turn the flag on or off. False when no account has the id. */
  setFlag: (accountId: string, on: boolean) => boolean;
  /** Every registered account whose stored flag is on, with its name. */
  flagged: () => Array<{ id: string; name: string }>;
}

/**
 * The flag port over the stored Claude account registry, read by the same rules
 * every reader uses (`readClaudeAccountSettings`), so an account the history
 * names is one Settings lists.
 *
 * @param store - The config, or a test double.
 */
export function configAutoMoveFlagPort(store: RuntimesStore): AutoMoveFlagPort {
  const accounts = () => {
    const runtimes = store.get('runtimes') as { claudeCode?: unknown } | undefined;
    return readClaudeAccountSettings(runtimes?.claudeCode).accounts;
  };
  return {
    flagOf: (accountId) => {
      const row = accounts().find((a) => a.id === accountId);
      if (!row) return 'gone';
      return row.noAutoMove === true ? KEPT_FROM_AUTO_MOVES : null;
    },
    setFlag: (accountId, on) => writeNoAutoMove(store, accountId, on),
    flagged: () =>
      accounts()
        .filter((a) => a.noAutoMove === true)
        .map((a) => ({ id: a.id, name: a.label ?? a.id })),
  };
}

let flagPort: AutoMoveFlagPort | null = null;

/**
 * Set how the flag is read and written, for the record and its Undo. Set at
 * startup; `null` (tests) makes every account read as gone.
 *
 * @param next - The port over the account registry.
 */
export function setAutoMoveFlagPort(next: AutoMoveFlagPort | null): void {
  flagPort = next;
}

/**
 * An account's flag now, for an Undo's compare-and-set.
 *
 * @param accountId - The account.
 */
export function autoMoveFlagNow(accountId: string): typeof KEPT_FROM_AUTO_MOVES | null | 'gone' {
  return flagPort ? flagPort.flagOf(accountId) : 'gone';
}

/**
 * Set accounts back to the flag each change recorded as `before`, for an
 * Undo. Each account is written on its own; one that is gone or cannot be
 * written is reported, never thrown.
 *
 * @param changes - The `account` changes to set back, already checked by the Undo.
 * @returns What the Undo made (current → restored), and what it left.
 */
export function setAutoMoveFlagsBack(changes: readonly PermissionChange[]): {
  made: PermissionChange[];
  skipped: PermissionUndoSkip[];
} {
  const made: PermissionChange[] = [];
  const skipped: PermissionUndoSkip[] = [];
  for (const change of changes) {
    if (change.key.kind !== 'account') continue;
    try {
      const current = autoMoveFlagNow(change.key.accountId);
      if (!flagPort || current === 'gone') {
        skipped.push({ change, current: null, reason: 'gone' });
        continue;
      }
      if (!flagPort.setFlag(change.key.accountId, change.before === KEPT_FROM_AUTO_MOVES)) {
        skipped.push({ change, current: null, reason: 'gone' });
        continue;
      }
      made.push({ ...change, before: current, after: change.before });
    } catch {
      skipped.push({ change, current: null, reason: 'gone' });
    }
  }
  return { made, skipped };
}

/** Everything the record reads and writes through. */
export interface KeptFromAutoMovesDeps {
  /** The done file, inside DorkOS's data directory. */
  doneFile: string;
  /** The account registry. */
  port: AutoMoveFlagPort;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
  /** Whether the history already holds this line: done, even without the done file. */
  priorRecord: () => Promise<boolean>;
  /** Where the outcome and any failure are reported. */
  logger: Pick<Logger, 'info' | 'error'>;
}

/** Write the done file, atomically. */
function markDone(doneFile: string, recorded: number): void {
  fs.mkdirSync(path.dirname(doneFile), { recursive: true });
  const tmp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, doneAt: new Date().toISOString(), recorded }));
  fs.renameSync(tmp, doneFile);
}

/**
 * Record, once per install, every account the upgrade kept out of automatic
 * moves, as one permission-history event with an Undo.
 *
 * @param deps - The done file, account registry, Activity writer and logger.
 * @returns How many accounts the line names, or `null` when it did not run
 *   (already done, or the history write failed).
 */
export async function recordKeptFromAutoMoves(deps: KeptFromAutoMovesDeps): Promise<number | null> {
  if (fs.existsSync(deps.doneFile) || (await deps.priorRecord())) return null;
  const changes: PermissionChange[] = deps.port.flagged().map((account) => ({
    target: { kind: 'default' },
    key: { kind: 'account', accountId: account.id, accountName: account.name },
    before: null,
    after: KEPT_FROM_AUTO_MOVES,
  }));
  try {
    await recordPermissionChange(deps.activity, {
      changes,
      surface: 'upgrade',
      writer: UPGRADE_WRITER,
      note: KEPT_FROM_AUTO_MOVES_NOTE,
    });
    markDone(deps.doneFile, changes.length);
  } catch (err) {
    deps.logger.error('[Permissions] could not record the accounts kept out of automatic moves', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (changes.length > 0) {
    deps.logger.info('[Permissions] recorded accounts kept out of automatic moves', {
      accounts: changes.length,
    });
  }
  return changes.length;
}
