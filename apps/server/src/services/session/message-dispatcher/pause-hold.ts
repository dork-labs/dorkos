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
 * rearm adopts rows other chats sent that nothing is running, after checking the
 * chat's agent is still registered and no longer paused. Adoption skips a row
 * already armed, so each held message runs exactly once, however often the
 * rearm runs. A person's own held row waits in their composer until they send.
 *
 * A resume rebuilds the turn from the row alone. The row keeps the limits a plan
 * carried in memory (an outsider mark, a ceiling, an unattended turn, DOR-4350),
 * so the resumed turn carries the same ones. A limit the row cannot keep (a
 * continuation's hold) has the row held to the runtime's default before it is
 * let go: stricter, never looser.
 *
 * A pause can also land after the turn started (its row already off the queue)
 * but before the agent read the message (DOR-4353). That turn is stopped like
 * any running one, so the row is put back in its old place and held the same
 * way, and its sender hears `held` rather than a failure.
 *
 * Only a real queue row is held. A refusing caller's trigger and a transient one
 * have no row to keep, and a protected private message has its own receipt
 * lifecycle; those meet the pause as before.
 *
 * @module services/session/message-dispatcher/pause-hold
 */
import { randomUUID } from 'node:crypto';
import { agentPause, type PausedAgentRef } from '../../mesh/pause/agent-pause.js';
import {
  getMessageQueueStore,
  setQueuedWaitingOn,
  type QueuedMessageRecord,
} from '../message-queue-store.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';
import { isPersonWindowClientId } from '../person-window-client-id.js';
import { emitLifecycle, pending } from './state.js';
import type { DispatchPlan } from './types.js';

/** How many held rows remember that their hold was already recorded. */
const RECORDED_HOLDS_MAX = 1_000;

/** Holds already written to the audit log, by row id and the pause that held it. */
const recordedHolds = new Set<string>();

/** How many person-window rows a pause held this process remembers. */
const HELD_FOR_PERSON_MAX = 1_000;

/**
 * Person-window rows a pause held in this process (DOR-4348). After a resume,
 * the person's window puts such a row back in their composer, so it waits for
 * their Send: no heartbeat, to-do, task or extension dispatch may adopt it.
 * Every other person row is adopted as usual, so words queued behind a busy
 * turn still run after a restart. The person's Send removes the row, and ids
 * are never reused, so an id left here is inert. Memory only on purpose: a
 * restart has no window holding the words, so the row runs like any other
 * leftover (and a pause still in force holds it again at launch).
 */
const heldForPerson = new Set<string>();

/**
 * Whether a queue row is a person's words a pause held, waiting for their Send.
 *
 * @param rowId - The queue row.
 */
export function awaitsPersonSend(rowId: string): boolean {
  return heldForPerson.has(rowId);
}

/**
 * A fresh runtime message id for each row a pause cut after its turn started
 * (DOR-4353, QA's W1). The cut runtime may already hold the message in its
 * transcript under the id it was sent with, and Claude Code runs nothing for
 * an id it already holds, so the rerun goes out under a new one. The row keeps
 * its own id: its chat record, its marks and its place in line are keyed to it.
 */
const rerunIds = new Map<string, string>();

/**
 * The id a row's turn is sent to the runtime under: the row's own, or a fresh
 * one after a pause cut it.
 *
 * @param rowId - The queue row.
 */
export function runtimeMessageIdFor(rowId: string): string {
  return rerunIds.get(rowId) ?? rowId;
}

/**
 * Forget a row's fresh runtime id once its turn has started.
 *
 * @param rowId - The queue row.
 */
export function forgetRuntimeMessageId(rowId: string): void {
  rerunIds.delete(rowId);
}

/**
 * Forget which holds were recorded.
 *
 * @internal Exported for testing only, through `resetMessageDispatcher`.
 */
export function forgetRecordedHolds(): void {
  recordedHolds.clear();
  rerunIds.clear();
  heldForPerson.clear();
}

/**
 * The paused agent a queued message is for, when its row should be held.
 *
 * @param plan - The message about to start, or whose turn just opened
 * @returns The paused agent, or `undefined` to launch as usual
 */
export function pausedAgentOfPlan(plan: DispatchPlan): PausedAgentRef | undefined {
  if (!holdable(plan) || !getMessageQueueStore()?.get(plan.messageId)) return undefined;
  return pausedAgentOf(plan);
}

/** Whether a message is the kind a pause holds: one with a real queue row. */
function holdable(plan: DispatchPlan): boolean {
  return plan.whenBusy === 'queue' && !plan.transient && plan.turn.privateReceiptId === undefined;
}

/** The paused agent a message is for, or `undefined`. */
function pausedAgentOf(plan: DispatchPlan): PausedAgentRef | undefined {
  const pauses = agentPause();
  if (!pauses) return undefined;
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
 * Whether a plan carries limits its queue row does not keep: an outsider mark,
 * a ceiling, an unattended turn or a continuation's hold. Each lives only in
 * memory (an agent's HTTP post, a heartbeat), so a turn rebuilt from the row
 * would run without it. A chat-sent row's own limits are re-read from its chat
 * message at launch and need none of these.
 *
 * @param plan - The message being held
 */
function carriesPlanOnlyLimits(plan: DispatchPlan): boolean {
  const { turn } = plan;
  return (
    turn.carriedMarks?.outsider === true ||
    turn.permissionCeiling !== undefined ||
    turn.unattended === true ||
    turn.continuationHold === true
  );
}

/**
 * Whether a row keeps every limit its plan carried, so a resume rebuilds the same turn: the mark,
 * the very ceiling and the unattended answer. A continuation's hold is never kept on a row.
 *
 * @param row - The queued row.
 * @param plan - The message being held.
 */
function rowKeepsLimits(row: QueuedMessageRecord, plan: DispatchPlan): boolean {
  const { turn } = plan;
  const kept = row.carriedLimits;
  if (turn.continuationHold === true) return false;
  if (turn.carriedMarks?.outsider === true && kept?.outsider !== true) return false;
  if (turn.unattended === true && kept?.unattended !== true) return false;
  return (
    turn.permissionCeiling === undefined ||
    JSON.stringify(turn.permissionCeiling) === JSON.stringify(kept?.ceiling)
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
  // Fail closed (Security M1): the row is all a resume rebuilds the turn from. It keeps the
  // turn's mark, ceiling and unattended answer (DOR-4350); a limit it does not keep (a
  // continuation's hold) would be lost, so that turn is held to the default.
  const store = getMessageQueueStore();
  const row = store?.get(plan.messageId);
  if (row && !row.heldToDefault && carriesPlanOnlyLimits(plan) && !rowKeepsLimits(row, plan)) {
    store?.updateContent(plan.messageId, row.content, { holdToDefault: true });
  }
  if (row && isPersonWindowClientId(row.enqueuedBy) && !heldForPerson.has(row.id)) {
    // Drop the oldest first; a Set iterates in insertion order.
    const oldest = heldForPerson.values().next().value;
    if (heldForPerson.size >= HELD_FOR_PERSON_MAX && oldest !== undefined) {
      heldForPerson.delete(oldest);
    }
    heldForPerson.add(row.id);
  }
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

/**
 * Hold a message whose turn started and was then stopped by a pause before the
 * agent read it (DOR-4353). Its row left the queue at `turn_start`, so the pause
 * used to stop it like any running turn and the words were gone. Now the row
 * goes back in its old place and is held as {@link holdForPause} holds one, and
 * its sender hears `held` in place of `settled`.
 *
 * @param plan - The message whose turn was cut
 * @param row - Its row, as the turn's start took it off the queue
 * @returns Whether it was held; when not, the turn settles as usual
 */
export function holdStartedForPause(plan: DispatchPlan, row: QueuedMessageRecord): boolean {
  const agent = holdable(plan) ? pausedAgentOf(plan) : undefined;
  const store = getMessageQueueStore();
  if (!agent || !store) return false;
  store.restore(queueKeyOf(plan.sessionKey), row);
  rerunIds.set(row.id, randomUUID());
  emitQueueUpdate(plan.sessionKey);
  holdForPause(plan, agent);
  emitLifecycle({ phase: 'held', messageId: plan.messageId, sessionId: plan.sessionKey });
  return true;
}
