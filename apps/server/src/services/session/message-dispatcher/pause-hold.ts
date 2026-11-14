/**
 * Holding a queued message for a paused agent instead of feeding it to a turn
 * the pause refuses (DOR-4327).
 *
 * A pause ends the agent's turn, and the turn's end releases the next queued
 * message. That message used to launch into a turn the pause backstop refused,
 * and since a row leaves the queue at `turn_start`, the row was deleted and the
 * words never ran. Now the launch checks for a pause first and, when it finds
 * one, starts nothing: the row stays on disk and this process lets go of it, so
 * nothing retries it while the pause holds.
 *
 * Lifting the pause re-arms it the way a restart does (DOR-3287): the chat-queue
 * rearm adopts rows nothing is running, after checking the chat's agent is
 * still registered and no longer paused. Adoption skips a row already armed, so
 * each held message runs exactly once, however often the rearm runs.
 *
 * Only a real queue row is held. A refusing caller's trigger and a transient one
 * have no row to keep, and a protected private message has its own receipt
 * lifecycle; those meet the pause as before.
 *
 * @module services/session/message-dispatcher/pause-hold
 */
import { agentPause, type PausedAgentRef } from '../../mesh/pause/agent-pause.js';
import { getMessageQueueStore, setQueuedWaitingOn } from '../message-queue-store.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { logger } from '../../../lib/logger.js';
import { pending } from './state.js';
import type { DispatchPlan } from './types.js';

/** How many held rows remember that their hold was already recorded. */
const RECORDED_HOLDS_MAX = 1_000;

/** Holds already written to the audit log, by row id and the pause that held it. */
const recordedHolds = new Set<string>();

/**
 * Forget which holds were recorded.
 *
 * @internal Exported for testing only, through `resetMessageDispatcher`.
 */
export function forgetRecordedHolds(): void {
  recordedHolds.clear();
}

/**
 * The paused agent a queued message is for, when its row should be held.
 *
 * @param plan - The message about to start, or whose turn just opened
 * @returns The paused agent, or `undefined` to launch as usual
 */
export function pausedAgentOfPlan(plan: DispatchPlan): PausedAgentRef | undefined {
  if (plan.whenBusy !== 'queue' || plan.transient || plan.turn.privateReceiptId !== undefined) {
    return undefined;
  }
  const pauses = agentPause();
  if (!pauses || !getMessageQueueStore()?.get(plan.messageId)) return undefined;
  const { cwd, forAgent, roomTurn } = plan.turn;
  const named = cwd !== undefined || forAgent !== undefined || roomTurn !== undefined;
  return pauses.pausedAgentOfSession(
    plan.sessionId,
    () => plan.runtime.getSessionCwd?.(plan.sessionId),
    named
      ? {
          ...(cwd !== undefined ? { cwd } : {}),
          ...(forAgent !== undefined ? { forAgent } : {}),
          ...(roomTurn !== undefined ? { roomTurn } : {}),
        }
      : undefined
  );
}

/**
 * Hold a queued message for its paused agent: keep the row, let go of it here,
 * and record the hold once per pause.
 *
 * Its sender hears nothing new: the message still reads as queued, which is
 * true. No lifecycle event fires, so a chat message riding on the row stays
 * `queued` rather than being marked failed.
 *
 * @param plan - The held message
 * @param agent - The paused agent it is for
 */
export function holdForPause(plan: DispatchPlan, agent: PausedAgentRef): void {
  pending.delete(plan.messageId);
  if (setQueuedWaitingOn(plan.messageId, undefined)) emitQueueUpdate(plan.sessionKey);
  const key = `${plan.messageId}:${agent.pausedAt ?? ''}`;
  if (recordedHolds.has(key)) return;
  if (recordedHolds.size >= RECORDED_HOLDS_MAX) recordedHolds.clear();
  recordedHolds.add(key);
  agentPause()?.recordHeld(agent, {
    via: 'message',
    sessionId: plan.sessionKey,
    runtime: plan.runtime.type,
  });
  logger.info('[MessageDispatcher] held a queued message: its agent is paused', {
    sessionId: plan.sessionKey,
    messageId: plan.messageId,
    agentId: agent.id,
  });
}
