/** Verified send orchestration; private seats never fall through to ordinary dispatch. */
import crypto from 'node:crypto';
import { ulid } from 'ulidx';
import { logError, logger } from '../../../../lib/logger.js';
import type { ChatDelivery, ChatMessageKind } from '@dorkos/shared/chat-messages';
import type { ChatMessageRow } from '@dorkos/db';
import type {
  ChatCaller,
  ChatSendInput,
  ChatSendReceipt,
  ChatMessageServiceDeps,
} from '../chat-message-service.js';
import type { FreshDmBirth } from './chat-message-birth.js';
import type { NewChatMessage } from '../chat-message-store.js';
import { ChatMessageError } from '../chat-message-error.js';
import { renderChatMessage } from '../chat-message-fence.js';
import { senderCeilingJson } from '../chat-message-ceiling.js';
import { resolveChatTarget, replyTargetOf, type ChatTarget } from '../chat-target.js';
import { resolveChatSeatTarget } from './chat-seat-target.js';
import { renderSeatMessage, seatCarryOf } from '../../../rooms/handoff/seat-message-prompt.js';
import { CHAT_SUMMARY_MAX } from './chat-message-limits.js';
import { redirectedChatReceipt } from '../chat-message-receipt.js';
import { assertChatUsageAvailable } from './chat-usage-recovery.js';

interface SendOptions {
  deps: ChatMessageServiceDeps;
  caller: ChatCaller;
  input: ChatSendInput;
  delivery: ChatDelivery;
  kind: Extract<ChatMessageKind, 'message' | 'report'>;
  sender: { agentId: string | null; agentName: string };
  deliver: (
    caller: ChatCaller,
    row: ChatMessageRow,
    target: ChatTarget,
    content: string,
    delivery: ChatDelivery,
    birth?: FreshDmBirth,
    onAccepted?: () => void
  ) => Promise<ChatSendReceipt>;
}

/**
 * Run one send, and count an accepted deliberate message as the sender's room
 * turn's answer, so the room does not say the agent "did not reply" (DOR-4670).
 *
 * The sender's turn is held from the moment the send is entered, ahead of every
 * await (the per-agent lock included), so a send that outlives its turn after
 * that answers nothing. Before that moment is a known gap: a call that waited on
 * an approval card while its turn ended can be read as a newer turn's answer
 * (see `RoomTriggerDispatcher.privateAnswerMark`).
 * Only a `message` counts: a `report` is the server's own send. A refusal
 * throws past the mark, and a receipt already `failed` delivered nothing.
 *
 * @param deps - The service's dependencies; the room route holds the turn.
 * @param caller - The calling chat, from the verified turn.
 * @param kind - What is being sent.
 * @param send - The send itself.
 * @returns The send's receipt, unchanged.
 */
export async function answeringRoomTurn(
  deps: ChatMessageServiceDeps,
  caller: ChatCaller,
  kind: SendOptions['kind'],
  send: () => Promise<ChatSendReceipt>
): Promise<ChatSendReceipt> {
  const answered =
    kind === 'message'
      ? deps.seatMessages?.()?.privateAnswerMark(caller.sessionId, caller.agentPath)
      : undefined;
  const receipt = await send();
  if (receipt.status !== 'failed') answered?.();
  return receipt;
}

/** Execute a validated send through its single selected delivery owner. */
export async function sendChatMessage(options: SendOptions): Promise<ChatSendReceipt> {
  const { deps, caller, input, delivery, kind } = options;
  const seatTarget = await resolveChatSeatTarget(deps, caller, input);
  const target: ChatTarget = seatTarget
    ? { sessionId: seatTarget.seat.sessionId }
    : await resolveChatTarget(deps, caller, input.to, input.replyTo, kind);
  const sender = options.sender;
  const fromChatTitle = await deps.chatTitle(caller.sessionId).catch(() => null);
  const replyToId = seatTarget
    ? seatTarget.replyToId
    : (target.redirectedReplyTo ??
      replyTargetOf(deps.store, caller, target.sessionId, input.replyTo));
  if (!seatTarget) await assertChatUsageAvailable(deps, target);
  const messageId = crypto.randomUUID();
  const words = input.message.trim();
  const rendered = renderChatMessage(
    {
      messageId,
      agentName: sender.agentName,
      agentId: sender.agentId,
      chatId: caller.sessionId,
      chatTitle: fromChatTitle,
    },
    kind,
    words,
    deps.nonce?.()
  );
  const ceilingJson = senderCeilingJson(deps, caller);
  // A new DM chat's id is minted here, before the row, so a window already
  // watching it can match the message to its sender from the first event.
  if (target.sessionId === null) target.newSessionId = crypto.randomUUID();
  const rowInput: NewChatMessage = {
    id: messageId,
    toSessionId: target.sessionId ?? target.newSessionId ?? '',
    fromSessionId: caller.sessionId,
    fromAgentPath: caller.agentPath,
    fromAgentId: sender.agentId,
    fromAgentName: sender.agentName,
    fromChatTitle,
    kind,
    text: words,
    summary: input.summary?.trim() ? input.summary.trim().slice(0, CHAT_SUMMARY_MAX) : null,
    nonce: rendered.nonce,
    delivery,
    status: 'queued',
    // The run's id too (a ULID): the turn port names the run, its queue row and its reservation by it.
    queueMessageId: ulid(),
    ceilingJson,
    replyToId,
  };
  if (seatTarget) {
    let receipt: ChatSendReceipt;
    try {
      receipt = seatTarget.port.admit({
        target: seatTarget.seat,
        row: rowInput,
        rendered: renderSeatMessage(rowInput),
        carried: seatCarryOf(rowInput),
        askAnswered: seatTarget.askAnswered,
      });
    } catch (error) {
      if (error instanceof ChatMessageError) throw error;
      // Storage errors may embed SQL parameters: private body text must not reach logs.
      logger.warn('[chat_send] private seat admission failed', {
        from: caller.sessionId,
        to: input.to,
      });
      throw new ChatMessageError('UNAVAILABLE', 'The seat could not take the message. Try again.');
    }
    return receipt;
  }
  let admitted: { row: ChatMessageRow; birth?: FreshDmBirth };
  if (target.sessionId === null) {
    if (!target.agent)
      throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not reserve this chat.');
    try {
      admitted = deps.store.insertFreshDm(rowInput, target.agent);
    } catch (error) {
      if (error instanceof ChatMessageError) throw error;
      // A failed SQLite statement may include the private receipt body.
      logger.warn('[chat_send] could not reserve a new DM');
      throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not reserve this chat.');
    }
  } else admitted = { row: deps.store.insert(rowInput) };
  const { row, birth } = admitted;

  let receipt: ChatSendReceipt;
  let accepted = false;
  try {
    receipt = await options.deliver(caller, row, target, rendered.text, delivery, birth, () => {
      accepted = true;
    });
  } catch (err) {
    if (birth && !accepted) {
      try {
        deps.store.deleteRejectedFreshDm(row, birth);
      } catch {
        // Keep the original refusal; the atomic receipt and allocation remain available.
        logger.warn('[chat_send] could not retire a refused DM reservation');
      }
    } else if (!birth) deps.store.delete(row.id);
    if (err instanceof ChatMessageError) throw err;
    logger.warn('[chat_send] could not send a chat message', {
      from: caller.sessionId,
      to: input.to,
      ...(birth ? {} : logError(err)),
    });
    throw new ChatMessageError(
      'UNAVAILABLE',
      'DorkOS could not send the message just now. Try again.'
    );
  }
  if (replyToId) {
    const answered = deps.store.update(replyToId, { status: 'replied' });
    if (answered) deps.emitActivity(answered.fromSessionId);
  }
  deps.emitActivity(caller.sessionId);
  deps.emitActivity(receipt.chatId);
  if (target.redirectedReplyTo) {
    const asker = deps.store.get(target.redirectedReplyTo)?.fromAgentName ?? 'that agent';
    return redirectedChatReceipt(receipt, asker);
  }
  return receipt;
}
