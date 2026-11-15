/**
 * What a person can do with a message another chat left waiting in this
 * chat's queue (DOR-3060): send it now, into the running turn, or not deliver
 * it at all.
 *
 * Neither changes what the model reads. Send now steers the stored row, which
 * is the fenced envelope, so the words still arrive as another chat's and never
 * as the person's own. And it joins the running turn only when every sender on
 * the row may (`mayChatSteer`: the turn already runs no looser than the
 * sender and carries its marks); otherwise the row moves to the front and runs
 * next, at the sender's own level.
 *
 * @module services/session/chat-messages/queued/queued-chat-actions
 */
import type { ChatMessageRow } from '@dorkos/db';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { SteerQueuedChatMessageResponse } from '@dorkos/shared/schemas';
import { holdForSteer, releaseSteerHold } from '../../message-dispatcher/pump.js';
import { isQueuedMessageLaunching } from '../../message-dispatcher/state.js';
import { getMessageQueueStore } from '../../message-queue-store.js';
import { cancelQueuedMessage } from '../../queued-message-edits.js';
import { queueKeyOf } from '../../resolution/session-key-registry.js';
import { isChatClientId } from '../chat-client-id.js';
import { mayChatSteer } from '../chat-message-ceiling.js';
import type { ChatMessageStore } from '../chat-message-store.js';
import { noteSteeredInto } from '../chat-started-turns.js';
import { moveToHead } from '../chat-queue-standing.js';

/** What Send now did, or why it could not act. */
export type QueuedChatSteerResult =
  { outcome: 'not-found' | 'not-chat-row' | 'launching' } | SteerQueuedChatMessageResponse;

/** What queued chat actions need from the chat-messaging composition root. */
export interface QueuedChatActionsDeps {
  /** The chat-message records behind durable queue rows. */
  store: ChatMessageStore;
  /** Whether the receiving chat currently has a running turn. */
  isBusy: (sessionId: string) => Promise<boolean>;
  /** The level a chat's current turn hands on, or unknown. */
  turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined;
  /** Deliver a fenced row into a running turn; true when it landed. */
  steerInto: (sessionId: string, content: string, messageId: string) => Promise<boolean>;
  /** Tell one chat's windows its messaging changed. */
  emitActivity: (sessionId: string) => void;
  /** The person's display name, or null when none is set. */
  operatorName: () => string | null;
}

let current: QueuedChatActionsDeps | undefined;

/**
 * Wire queued chat actions at boot, or clear them for test isolation.
 *
 * @param deps - The live chat services, or `undefined` to clear them.
 */
export function setQueuedChatActionsDeps(deps: QueuedChatActionsDeps | undefined): void {
  current = deps;
}

/** The queue row another chat sent, or why there is none. */
function chatRowOf(
  sessionId: string,
  queueRowId: string
): { outcome: 'not-found' | 'not-chat-row' } | { content: string } {
  const row = getMessageQueueStore()
    ?.list(queueKeyOf(sessionId))
    .find((candidate) => candidate.id === queueRowId);
  if (!row) return { outcome: 'not-found' };
  if (!isChatClientId(row.enqueuedBy)) return { outcome: 'not-chat-row' };
  return { content: row.content };
}

/**
 * Send a queued message from another chat into the receiving chat's running
 * turn, or put it first when it may not join that turn.
 *
 * The row is held off the pump while the steer is in flight, so its words
 * reach the model once: steered, or as a turn of their own.
 *
 * @param sessionId - The receiving chat.
 * @param queueRowId - The durable queue row.
 */
export async function steerQueuedChatMessage(
  sessionId: string,
  queueRowId: string
): Promise<QueuedChatSteerResult> {
  const deps = current;
  if (!deps) return { outcome: 'not-found' };
  const row = chatRowOf(sessionId, queueRowId);
  if ('outcome' in row) return row;
  const records = deps.store.listByQueueMessage(queueRowId);
  const heldToDefault = getMessageQueueStore()?.get(queueRowId)?.heldToDefault === true;
  const busy = await deps.isBusy(sessionId).catch(() => false);
  const moveInstead = (reason: 'no-running-turn' | 'steer-not-allowed' | 'steer-did-not-land') => {
    moveToHead(sessionId, queueRowId);
    return { outcome: 'moved-to-front' as const, reason };
  };
  if (!busy) return moveInstead('no-running-turn');
  // No sender on record is never permission to join a live turn, and every
  // sender on the row has to pass on its own: one marked sender keeps the
  // whole row out of an unmarked or looser turn.
  if (
    heldToDefault ||
    records.length === 0 ||
    !records.every((record) => mayChatSteer(deps, record.fromSessionId, sessionId))
  ) {
    return moveInstead('steer-not-allowed');
  }
  if (!holdForSteer(queueRowId)) return { outcome: 'launching' };
  let landed = false;
  try {
    landed = await deps.steerInto(sessionId, row.content, queueRowId).catch(() => false);
  } finally {
    if (!landed) releaseSteerHold(sessionId, queueRowId);
  }
  if (!landed) return moveInstead('steer-did-not-land');

  const senders = [...new Set(records.map((record) => record.fromSessionId))];
  noteSteeredInto(sessionId, senders);
  // Marked before the row leaves, so the drop the removal reports finds no
  // waiting record to call "taken off the queue".
  for (const record of records) {
    deps.store.update(record.id, { status: 'steered', queueMessageId: null });
  }
  cancelQueuedMessage(sessionId, queueRowId);
  releaseSteerHold(sessionId, queueRowId);
  for (const sender of senders) deps.emitActivity(sender);
  deps.emitActivity(sessionId);
  return { outcome: 'steered' };
}

/**
 * The chat messages a queue row carries, read before a person removes it, so
 * {@link noteRemovedByPerson} can name who removed them once it is gone.
 *
 * @param sessionId - The receiving chat.
 * @param queueRowId - The row about to be removed.
 * @returns The records, or an empty list for a row the person wrote, or one
 *   already starting: removing that one does not stop its turn.
 */
export function queuedChatRecordsOf(sessionId: string, queueRowId: string): ChatMessageRow[] {
  const deps = current;
  if (!deps || isQueuedMessageLaunching(queueRowId)) return [];
  const row = chatRowOf(sessionId, queueRowId);
  if ('outcome' in row) return [];
  return deps.store.listByQueueMessage(queueRowId);
}

/**
 * Tell each sender that the person took its message off the queue: its
 * record says so by name, which is what its Sent card and `chat_read` show.
 *
 * Called after the removal succeeded, so a row that started running in the
 * meantime is never called undelivered.
 *
 * @param records - What {@link queuedChatRecordsOf} read before the removal.
 */
export function noteRemovedByPerson(records: readonly ChatMessageRow[]): void {
  const deps = current;
  if (!deps || records.length === 0) return;
  const name = deps.operatorName() ?? 'Someone';
  for (const record of records) {
    deps.store.update(record.id, {
      status: 'failed',
      failureReason: `${name} removed it before it was delivered.`,
    });
    deps.emitActivity(record.fromSessionId);
  }
}
