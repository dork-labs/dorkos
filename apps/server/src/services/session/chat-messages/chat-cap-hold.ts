/**
 * Messages to an existing chat wait out a full launch cap instead of being
 * dropped (DOR-3375). The cap blocked "hold, the host is overloaded" at the very
 * moment it mattered, so it now stops only brand-new chats from starting.
 *
 * A held message is a `chat_messages` row at `queued` with no queue row
 * (`queueMessageId` null), a state nothing else writes. So it survives a restart
 * with no new column, and it cannot be mistaken for a send still on its way.
 * It is offered again, oldest first, whenever a turn settles and on a clock, by
 * the same delivery a new send takes: a chat that has since gone busy simply
 * queues it, and one that has stopped taking messages fails it with the reason.
 *
 * @module services/session/chat-messages/chat-cap-hold
 */
import crypto from 'node:crypto';
import type { ChatMessageRow } from '@dorkos/db';
import { logError, logger } from '../../../lib/logger.js';
import { ChatMessageError } from './chat-message-error.js';
import { renderChatMessage } from './chat-message-fence.js';
import type { ChatCaller, ChatSendReceipt } from './chat-message-service.js';
import type { ChatMessageStore } from './chat-message-store.js';
import { resolveChatTarget, type ChatTarget, type ChatTargetDeps } from './chat-target.js';

/** How often held messages are offered again when no turn settling prompts it. */
export const CAP_HOLD_RETRY_MS = 10_000;

/** What a sender is told when its message waits for a slot. */
export const CAP_HOLD_NOTE =
  'The computer is at its limit for running chats, so this starts when a slot frees.';

/** What holding a message needs. */
export interface ChatCapHoldDeps extends ChatTargetDeps {
  /** The store. */
  store: ChatMessageStore;
  /** The delivery a new send takes. */
  deliver: (
    caller: ChatCaller,
    row: ChatMessageRow,
    target: ChatTarget,
    content: string
  ) => Promise<ChatSendReceipt>;
  /** Tell a chat's windows its messaging changed. */
  emitActivity: (sessionId: string) => void;
}

/** The messages waiting for a launch slot. See the module documentation. */
export class ChatCapHold {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  /**
   * Build the hold.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: ChatCapHoldDeps) {}

  /**
   * Keep a message the cap refused, and say so to its sender.
   *
   * @param row - The message.
   * @param chatId - The chat it waits to reach.
   */
  hold(row: ChatMessageRow, chatId: string): ChatSendReceipt {
    this.deps.store.update(row.id, { queueMessageId: null });
    return { messageId: row.id, chatId, status: 'queued', note: CAP_HOLD_NOTE };
  }

  /** Start the clock, which also picks up what a previous process was holding. */
  start(): void {
    this.timer ??= setInterval(() => void this.retry(), CAP_HOLD_RETRY_MS);
    this.timer.unref?.();
  }

  /** Stop the clock, for a server shutting down. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Offer every held message again, oldest first. One pass at a time. */
  retry(): Promise<void> {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /**
   * Drop what is held for a chat that was just stopped, as a stop drops the
   * messages other chats queued there.
   *
   * @param chatId - The stopped chat.
   * @param reason - What the senders are told.
   */
  dropFor(chatId: string, reason: string): void {
    for (const row of this.deps.store.listHeldForSlot()) {
      if (row.toSessionId === chatId) this.fail(row, reason);
    }
  }

  private async drain(): Promise<void> {
    for (const row of this.deps.store.listHeldForSlot()) {
      try {
        await this.offer(row);
      } catch (err) {
        const known = err instanceof ChatMessageError;
        if (!known) logger.warn('[chat_send] a held message failed', logError(err));
        this.fail(row, known ? err.message : 'DorkOS could not send the message.');
      }
    }
  }

  private async offer(row: ChatMessageRow): Promise<void> {
    const caller = { sessionId: row.fromSessionId, agentPath: row.fromAgentPath };
    const target = await resolveChatTarget(this.deps, caller, row.toSessionId, undefined);
    const rendered = renderChatMessage(
      {
        messageId: row.id,
        agentName: row.fromAgentName,
        agentId: row.fromAgentId,
        chatId: row.fromSessionId,
        chatTitle: row.fromChatTitle,
      },
      row.kind,
      row.text,
      row.nonce ?? undefined
    );
    // A fresh id each offer: the row only has one once the launch took it.
    const offered = this.deps.store.update(row.id, { queueMessageId: crypto.randomUUID() }) ?? row;
    const receipt = await this.deps.deliver(caller, offered, target, rendered.text);
    if (receipt.note === CAP_HOLD_NOTE) return;
    this.deps.emitActivity(row.fromSessionId);
    this.deps.emitActivity(receipt.chatId);
  }

  private fail(row: ChatMessageRow, failureReason: string): void {
    this.deps.store.update(row.id, { status: 'failed', failureReason });
    this.deps.emitActivity(row.fromSessionId);
  }
}
