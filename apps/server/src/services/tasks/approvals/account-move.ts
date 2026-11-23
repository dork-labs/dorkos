/**
 * An agent moving an approved schedule to another Claude account, without
 * sending it back for approval (DOR-5097).
 *
 * Who pays for a run is not what the run does, so an edit that changes only
 * `account` keeps the approval (`TaskApprovals.settleApprovedWorkChange`), as
 * long as the new account is one a person left open to agent work. It is not
 * when it is DorkOS credits (money, the owner's call), the main sign-in (never
 * picked for agent work on its own, spec `claude-account-fleet` D5), an account
 * a person kept out of automatic moves, one whose sign-in is not confirmed or
 * was last seen signed out, an account this computer does not know, or no
 * account at all (back to the agent's, which may be any of those). Then the
 * schedule waits for the person, as before.
 *
 * A kept move is written to the audit log and the person is told, with an
 * Undo that puts the old account back. A move nobody could be told about does
 * not stand silently: the schedule waits for the person instead.
 *
 * @module services/tasks/approvals/account-move
 */
import { CREDITS_ACCOUNT_ID, IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { Task } from '@dorkos/shared/types';
import { logError, logger } from '../../../lib/logger.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { signinAllowsAutoPick } from '../../core/usage/account-ranking.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { RuntimeAccount } from '../../core/usage/runtime-accounts.js';
import { resolveAgentIdForPath, resolveAgentNameForId } from '../../mesh/agent-path-lookup.js';
import {
  postScheduleArmed,
  resolveScheduleArmedPayload,
} from '../../notifications/emitters/schedule-armed.js';
import { UNNAMED_PROPOSER } from '../../notifications/emitters/schedule-park.js';
import type { TaskStore } from '../task-store.js';

/** The audit action for a move that kept its approval. */
export const TASK_ACCOUNT_MOVE_ACTION = 'tasks.account_moved';

/**
 * Whether an agent's account-only change to this account keeps the
 * schedule's approval. See the module TSDoc for what is restricted.
 *
 * @param accountId - The account the schedule now names, or `null` for none.
 * @param accounts - The Claude accounts this computer knows; read live by default.
 */
export function accountMayTakeMovedWork(
  accountId: string | null,
  accounts: readonly RuntimeAccount[] = getAccountUsageStore()?.listAccounts('claude-code') ?? []
): boolean {
  if (accountId === null || accountId === CREDITS_ACCOUNT_ID || accountId === IMPLICIT_ACCOUNT_ID) {
    return false;
  }
  const row = accounts.find((account) => account.id === accountId);
  if (!row || !row.routable || row.isDefault || row.noAutoMove) return false;
  return signinAllowsAutoPick(row);
}

/** What one kept move was: the task before and after, and the agent that made it. */
export interface AccountMove {
  before: Task;
  after: Task;
  /** The home of the agent that moved it, when DorkOS knows it. */
  agentPath?: string | null;
}

/** An account by the name a person gave it, else its id. */
function accountName(id: string | null): string {
  if (id === null) return 'its agent’s account';
  const row = getAccountUsageStore()
    ?.listAccounts('claude-code')
    .find((account) => account.id === id);
  return row?.label ?? id;
}

/**
 * Write a kept move to the audit log and tell the person, with an Undo. Never
 * throws. When the person could not be told, the schedule waits for them
 * instead, so a move never stands unseen.
 *
 * @param store - Where the schedule is parked when the notice fails.
 * @param move - The task before and after, and who moved it.
 * @returns Whether the move stands.
 */
export async function announceAccountMove(
  store: Pick<TaskStore, 'updateTask'>,
  move: AccountMove
): Promise<boolean> {
  const { before, after } = move;
  const taskName = after.displayName ?? after.name;
  const from = accountName(before.account);
  const to = accountName(after.account);
  try {
    recordAudit({
      action: TASK_ACCOUNT_MOVE_ACTION,
      operation: 'modify',
      target: { type: 'task', id: after.id, name: taskName },
      outcome: 'ok',
      change: [
        { field: 'account', before: before.account, after: after.account },
        { field: 'approval', after: 'kept' },
      ],
      summary: `Moved ${taskName} from ${from} to ${to}; it stays approved`,
    });
    const setterId = move.agentPath ? resolveAgentIdForPath(move.agentPath) : undefined;
    const payload = await resolveScheduleArmedPayload(after);
    const told = await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      accountChange: {
        fromId: before.account,
        toId: after.account,
        from,
        to,
        at: new Date().toISOString(),
      },
    });
    if (told) return true;
  } catch (err) {
    logger.warn('[tasks] could not tell the person about an account move', logError(err));
  }
  store.updateTask(after.id, { status: 'pending_approval' });
  return false;
}
