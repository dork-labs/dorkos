/** Verified send orchestration; private seats never fall through to ordinary dispatch. */
import crypto from 'node:crypto';
import { logError, logger } from '../../../../lib/logger.js';
import type { ChatDelivery, ChatMessageKind } from '@dorkos/shared/chat-messages';
import type { ChatMessageRow } from '@dorkos/db';
import type {
  ChatCaller,
  ChatSendInput,
  ChatSendReceipt,
  ChatMessageServiceDeps,
} from '../chat-message-service.js';
import type { NewChatMessage } from '../chat-message-store.js';
import { ChatMessageError } from '../chat-message-error.js';
import { renderChatMessage } from '../chat-message-fence.js';
import { senderCeilingJson } from '../chat-message-ceiling.js';
import { resolveChatTarget, replyTargetOf, type ChatTarget } from '../chat-target.js';
import { resolveChatSeatTarget } from './chat-seat-target.js';
import { renderSeatMessage, seatCarryOf } from '../../../rooms/handoff/seat-message-prompt.js';
import { CHAT_SUMMARY_MAX } from './chat-message-limits.js';
import { redirectedChatReceipt } from '../chat-message-receipt.js';

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
    delivery: ChatDelivery
  ) => Promise<ChatSendReceipt>;
  markReplied: (id: string) => void;
}

/** Execute a validated send through its single selected delivery owner. */
export async function sendChatMessage(options: SendOptions): Promise<ChatSendReceipt> {
  const { deps, caller, input, delivery, kind } = options;
  const seatTarget = await resolveChatSeatTarget(deps, caller, input);
  const target: ChatTarget = seatTarget
    ? { sessionId: seatTarget.seat.sessionId }
    : await resolveChatTarget(deps, caller, input.to, input.replyTo);
  const sender = options.sender;
  const fromChatTitle = await deps.chatTitle(caller.sessionId).catch(() => null);
  const replyToId = seatTarget
    ? seatTarget.replyToId
    : (target.redirectedReplyTo ??
      replyTargetOf(deps.store, caller, target.sessionId, input.replyTo));
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
    queueMessageId: crypto.randomUUID(),
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
  const row = deps.store.insert(rowInput);

  let receipt: ChatSendReceipt;
  try {
    receipt = await options.deliver(caller, row, target, rendered.text, delivery);
  } catch (err) {
    deps.store.delete(row.id);
    if (err instanceof ChatMessageError) throw err;
    logger.warn('[chat_send] could not send a chat message', {
      from: caller.sessionId,
      to: input.to,
      ...logError(err),
    });
    throw new ChatMessageError(
      'UNAVAILABLE',
      'DorkOS could not send the message just now. Try again.'
    );
  }
  if (replyToId) options.markReplied(replyToId);
  deps.emitActivity(caller.sessionId);
  deps.emitActivity(receipt.chatId);
  if (target.redirectedReplyTo) {
    const asker = deps.store.get(target.redirectedReplyTo)?.fromAgentName ?? 'that agent';
    return redirectedChatReceipt(receipt, asker);
  }
  return receipt;
}
