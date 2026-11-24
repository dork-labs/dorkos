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
 * Two more limits. A move OFF DorkOS credits never keeps the approval: credits
 * are the owner's call, and so is what replaces them. And on the Careful preset
 * an agent's edit waits for the person whatever it changed
 * ({@link accountMovePolicy}); the automatic run fallback still works there.
 *
 * A kept move is written to the audit log and the person is told, with an
 * Undo that puts the old account back (`accountUndo`, kept server side). A move
 * nobody could be told about does not stand silently: the schedule waits for
 * the person instead, with a sentence saying why. An agent unpinning a task
 * ("This account only" off) is told too, since its runs may now move.
 *
 * @module services/tasks/approvals/account-move
 */
import { CREDITS_ACCOUNT_ID, IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { Task } from '@dorkos/shared/types';
import { logError, logger } from '../../../lib/logger.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { signinAllowsAutoPick } from '../../core/usage/account-ranking.js';
import { agentSchedulesArmWithoutAsking } from './agent-trust.js';
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

/**
 * Whether an agent's account-only move from `from` to `to` keeps the approval:
 * never off DorkOS credits, and only onto an account {@link accountMayTakeMovedWork}
 * allows.
 *
 * @param to - The account the schedule now names.
 * @param from - The account it named before.
 * @param accounts - The Claude accounts this computer knows; read live by default.
 */
export function agentMayMoveAccount(
  to: string | null,
  from: string | null,
  accounts?: readonly RuntimeAccount[]
): boolean {
  return from !== CREDITS_ACCOUNT_ID && accountMayTakeMovedWork(to, accounts);
}

/**
 * The account-move rule an agent's edit is settled with, or `undefined` (the
 * move parks like any other change) on the Careful preset or for a caller that
 * is not one of our agents.
 *
 * @param callerIsOurAgent - Whether the server identified the caller as one of
 *   this install's agents, from an unmarked turn.
 */
export function accountMovePolicy(
  callerIsOurAgent: boolean
): ((to: string | null, from: string | null) => boolean) | undefined {
  return agentSchedulesArmWithoutAsking(callerIsOurAgent) ? agentMayMoveAccount : undefined;
}

/** The sentence a schedule parks with when an account move could not be told (DOR-5097). */
export const UNTOLD_ACCOUNT_MOVE_REASON =
  'An agent moved this to another account. DorkOS couldn’t tell you, so it waits.';

/** What one kept move was: the task before and after, and the agent that made it. */
export interface AccountMove {
  before: Task;
  after: Task;
  /** The home of the agent that moved it, when DorkOS knows it. */
  agentPath?: string | null;
}

/** An account by the name a person gave it, else its id; never the raw credits id. */
export function accountName(id: string | null): string {
  if (id === null) return 'its agent’s account';
  if (id === CREDITS_ACCOUNT_ID) return 'DorkOS credits';
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
  store: Pick<TaskStore, 'approvals'>,
  move: AccountMove
): Promise<boolean> {
  const { before, after } = move;
  // The same time the server's undo record carries, so the Undo finds it.
  const at =
    store.approvals.agentModeColumnOf(after.id).accountUndo?.at ?? new Date().toISOString();
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
      accountChange: { fromId: before.account, toId: after.account, from, to, at },
    });
    if (told) return true;
  } catch (err) {
    logger.warn('[tasks] could not tell the person about an account move', logError(err));
  }
  store.approvals.parkWithReason(after.id, UNTOLD_ACCOUNT_MOVE_REASON);
  return false;
}

/**
 * Tell the person an agent turned "This account only" off on a task, so its
 * runs may now move to another account (DOR-5097). Never throws.
 *
 * @param move - The task before and after, and who changed it.
 */
export async function announceAccountUnpin(move: AccountMove): Promise<void> {
  if (move.before.accountPinned !== true || move.after.accountPinned === true) return;
  try {
    const setterId = move.agentPath ? resolveAgentIdForPath(move.agentPath) : undefined;
    const payload = await resolveScheduleArmedPayload(move.after);
    await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      accountUnpinned: { account: accountName(move.after.account), at: new Date().toISOString() },
    });
  } catch (err) {
    logger.warn('[tasks] could not tell the person about an unpinned account', logError(err));
  }
}
