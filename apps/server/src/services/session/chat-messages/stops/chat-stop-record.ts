/**
 * One chat stopping another's running turn, and the record that says it was
 * that chat (DOR-4668): `chat_stop`, and a message sent with
 * `delivery: 'interrupt'`.
 *
 * The runtime writes any interrupt in a person's voice (Claude Code:
 * `[Request interrupted by user]`), and an agent that reads it holds its work
 * for a person who did nothing. So a stop by a chat leaves three things:
 *
 * - a `stop` row, which the stopped chat shows as "Stopped by <agent> · <chat>"
 *   and its reopened history puts in place of the runtime's line;
 * - an audit entry;
 * - a one-time note on the stopped chat's next turn (`turn-cutoff.ts`), owed
 *   BEFORE the interrupt, because the turn ending can start the next one at once.
 *
 * @module services/session/chat-messages/stops/chat-stop-record
 */
import crypto from 'node:crypto';
import type { ChatMessageRow } from '@dorkos/db';
import type { ChatStopCutoff } from '@dorkos/shared/additional-context';
import { logError, logger } from '../../../../lib/logger.js';
import { recordAudit } from '../../../audit/audit-trail.js';
import {
  noteTurnCutoff,
  restoreTurnCutoff,
  takeTurnCutoff,
  withdrawTurnCutoff,
} from '../../turn-cutoff/turn-cutoff.js';
import type { ChatMessageStore } from '../chat-message-store.js';

/**
 * The words a stopped chat shows for a stop: "Stopped by <agent> · <chat>".
 *
 * @param agentName - The stopping agent's name.
 * @param chatTitle - The stopping chat's title, when it has one.
 */
export function chatStopByLine(agentName: string, chatTitle: string | null): string {
  return `Stopped by ${agentName}${chatTitle ? ` · ${chatTitle}` : ''}`;
}

/** Who is stopping the turn, as the sending chat's rows already name it. */
export type ChatStopSender = Pick<
  ChatMessageRow,
  'fromSessionId' | 'fromAgentPath' | 'fromAgentId' | 'fromAgentName' | 'fromChatTitle'
>;

/** What {@link stopChatTurn} needs. */
export interface ChatStopDeps {
  /** The chat-message store. */
  store: Pick<ChatMessageStore, 'insert'>;
  /** Stop a chat's running turn. True when one was running and was asked to stop. */
  interruptTurn: (sessionId: string) => Promise<boolean>;
  /** A chat's title, or null. */
  chatTitle: (sessionId: string) => Promise<string | null>;
}

/**
 * Stop a chat's running turn for another chat, and record that it did.
 *
 * A `chat_stop` is recorded either way, as `failed` when nothing was running.
 * An interrupt that found nothing running is no stop at all, so it leaves no row,
 * no audit entry and no note.
 *
 * Never throws: a failed interrupt is a stop that did not happen.
 *
 * @param deps - What it needs.
 * @param input - The chat to stop, who is stopping it, how, and why.
 * @returns Whether a turn was running and was asked to stop.
 */
export async function stopChatTurn(
  deps: ChatStopDeps,
  input: {
    chatId: string;
    sender: ChatStopSender;
    via: ChatStopCutoff['via'];
    reason?: string | null;
  }
): Promise<boolean> {
  const { chatId, sender, via } = input;
  const reason = input.reason ?? null;
  const owed: ChatStopCutoff = { stoppedBy: 'chat', via };
  // A note still owed (a stall cutoff) comes back if this stop stops nothing.
  const earlier = takeTurnCutoff(chatId);
  noteTurnCutoff(chatId, owed);
  const stopped = await deps.interruptTurn(chatId).catch((err: unknown) => {
    logger.warn('[chat_stop] could not stop a chat', { chat: chatId, via, ...logError(err) });
    return false;
  });
  if (!stopped) {
    withdrawTurnCutoff(chatId, owed);
    if (earlier !== null) restoreTurnCutoff(chatId, earlier);
  }
  if (!stopped && via === 'interrupt') return false;
  try {
    await recordStop(deps, chatId, sender, via, reason, stopped);
  } catch (err) {
    // The stop happened; only its line is lost. A send must not fail for it.
    logger.warn('[chat_stop] could not record a stop', { chat: chatId, via, ...logError(err) });
  }
  return stopped;
}

/** Write the stop's row and its audit entry. */
async function recordStop(
  deps: ChatStopDeps,
  chatId: string,
  sender: ChatStopSender,
  via: ChatStopCutoff['via'],
  reason: string | null,
  stopped: boolean
): Promise<void> {
  deps.store.insert({
    id: crypto.randomUUID(),
    toSessionId: chatId,
    // Field by field: the sender is often a whole sent row, whose id must not ride along.
    fromSessionId: sender.fromSessionId,
    fromAgentPath: sender.fromAgentPath,
    fromAgentId: sender.fromAgentId,
    fromAgentName: sender.fromAgentName,
    fromChatTitle: sender.fromChatTitle,
    kind: 'stop',
    text: reason ?? '',
    summary: null,
    nonce: null,
    delivery: 'interrupt',
    status: stopped ? 'delivered' : 'failed',
    queueMessageId: null,
    ceilingJson: JSON.stringify('runtime-default'),
    replyToId: null,
  });
  const byLine = chatStopByLine(sender.fromAgentName, sender.fromChatTitle);
  const why = via === 'interrupt' ? ', to send it a message' : reason ? `: ${reason}` : '';
  recordAudit({
    action: 'chat.stopped',
    operation: 'execute',
    target: {
      type: 'session',
      id: chatId,
      ...(await deps.chatTitle(chatId).then(
        (name) => (name ? { name } : {}),
        () => ({})
      )),
    },
    outcome: stopped ? 'ok' : 'failed',
    ...(reason ? { reason } : {}),
    summary: stopped ? `${byLine}${why}` : 'Tried to stop a chat that was not running',
  });
}
