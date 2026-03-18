/**
 * Telegram outbound message delivery.
 *
 * Handles deliver() implementation including message truncation for
 * Telegram's 4096-character limit, StreamEvent-aware buffering,
 * and typing signal management.
 *
 * @module relay/adapters/telegram-outbound
 */
import { randomBytes } from 'node:crypto';
import type { Bot } from 'grammy';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  truncateText,
  extractApprovalData,
  formatToolDescription,
} from '../../lib/payload-utils.js';
import type { ApprovalData } from '../../lib/payload-utils.js';
import { extractChatId, SUBJECT_PREFIX, MAX_MESSAGE_LENGTH } from './inbound.js';

/** Telegram sendChatAction type for typing indicator. */
const TELEGRAM_TYPING_ACTION = 'typing' as const;

/** Active typing intervals keyed by chatId. */
const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();

/** Refresh interval for Telegram typing indicator (expires after 5s). */
const TYPING_REFRESH_MS = 4_000;

/** Minimum interval (ms) between sendMessageDraft calls for a single chat. */
const DRAFT_UPDATE_INTERVAL_MS = 200;

/** TTL for response buffers (ms). Buffers older than this are reaped to prevent memory leaks. */
export const BUFFER_TTL_MS = 5 * 60 * 1_000;

/** Last draft update timestamp per chat (for throttling sendMessageDraft). */
const lastDraftUpdate = new Map<number, number>();

/**
 * In-memory map from short callback key to full approval IDs.
 *
 * Telegram's callback_data field is limited to 64 bytes. We store the full
 * IDs here and encode only a 12-character short key in the button payload.
 */
export const callbackIdMap = new Map<string, { toolCallId: string; sessionId: string; agentId: string }>();

/** Maximum age (ms) for callbackIdMap entries before auto-eviction. */
const CALLBACK_ID_TTL_MS = 15 * 60 * 1_000;

/** Pending approval timeouts keyed by callback short key. */
export const pendingApprovalTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** Clear a pending approval timeout when the user clicks Approve/Deny. */
export function clearApprovalTimeout(shortKey: string): void {
  const timer = pendingApprovalTimeouts.get(shortKey);
  if (timer) {
    clearTimeout(timer);
    pendingApprovalTimeouts.delete(shortKey);
  }
}

/**
 * In-flight response buffer for a single Telegram chat.
 *
 * Tracks accumulated streamed text and when buffering began so stale
 * sessions can be reaped after {@link BUFFER_TTL_MS}.
 */
export interface ResponseBuffer {
  /** Accumulated streamed text for this chat. */
  text: string;
  /** Unix timestamp (ms) when this buffer was first created. */
  startedAt: number;
}

/** Options for delivering a Relay message to Telegram. */
export interface TelegramDeliverOptions {
  adapterId: string;
  subject: string;
  envelope: RelayEnvelope;
  bot: Bot | null;
  responseBuffers: Map<number, ResponseBuffer>;
  callbacks: AdapterOutboundCallbacks;
  streaming: boolean;
  logger?: RelayLogger;
}

/**
 * Send a text message to Telegram and update outbound counter.
 *
 * @param bot - The grammy Bot instance
 * @param chatId - The Telegram chat ID
 * @param text - The message text to send
 * @param startTime - Timestamp (ms) for delivery duration calculation
 * @param callbacks - Callbacks to mutate adapter state
 */
async function sendAndTrack(
  bot: Bot,
  chatId: number,
  text: string,
  startTime: number,
  callbacks: AdapterOutboundCallbacks,
): Promise<DeliveryResult> {
  try {
    await bot.api.sendMessage(chatId, text);
    callbacks.trackOutbound();
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    callbacks.recordError(err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Deliver a Relay message to the Telegram chat identified by the subject.
 *
 * Extracts the chat ID from the subject, reads the payload content, and
 * sends it via the Telegram Bot API. Outbound content is truncated to
 * Telegram's 4096-character message limit. StreamEvent payloads are buffered
 * per-chat and flushed on 'done' or 'error' events.
 *
 * @param opts - Delivery options
 */
export async function deliverMessage(opts: TelegramDeliverOptions): Promise<DeliveryResult> {
  const { adapterId, subject, envelope, bot, responseBuffers, callbacks, streaming, logger = noopLogger } = opts;
  const startTime = Date.now();

  // Guard: skip messages that originated from this adapter to prevent echo.
  // Inbound messages are published with `from: relay.human.telegram.bot`,
  // which starts with our subject prefix. Without this guard the publish
  // pipeline routes the message right back to deliver(), creating a loop.
  if (envelope.from.startsWith(SUBJECT_PREFIX)) {
    logger.debug('deliver: echo prevention — skipping self-originated message');
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (!bot) {
    return {
      success: false,
      error: `TelegramAdapter(${adapterId}): not started`,
      durationMs: Date.now() - startTime,
    };
  }

  const chatId = extractChatId(subject);
  if (chatId === null) {
    return {
      success: false,
      error: `TelegramAdapter(${adapterId}): cannot extract chat ID from subject '${subject}'`,
      durationMs: Date.now() - startTime,
    };
  }

  // Reap stale buffers to prevent unbounded memory growth. A buffer is
  // considered stale if no done/error event arrived within BUFFER_TTL_MS —
  // e.g. the agent crashed mid-stream or the session was abandoned.
  const now = Date.now();
  for (const [id, buf] of responseBuffers) {
    if (now - buf.startedAt > BUFFER_TTL_MS) {
      responseBuffers.delete(id);
      lastDraftUpdate.delete(id);
      logger.warn(`buffer: reaped stale buffer for chat ${id} (age: ${Math.round((now - buf.startedAt) / 1000)}s)`);
    }
  }

  // --- StreamEvent-aware delivery ---
  const eventType = detectStreamEventType(envelope.payload);

  if (eventType) {
    // text_delta: accumulate in buffer
    const textChunk = extractTextDelta(envelope.payload);
    if (textChunk) {
      logger.debug(`deliver: text_delta to chat ${chatId} (${textChunk.length} chars)`);
      const existing = responseBuffers.get(chatId);
      responseBuffers.set(chatId, {
        text: (existing?.text ?? '') + textChunk,
        startedAt: existing?.startedAt ?? Date.now(),
      });

      // Native draft streaming: DMs only (chatId > 0), streaming enabled
      if (streaming && chatId > 0) {
        const lastUpdate = lastDraftUpdate.get(chatId) ?? 0;
        if (Date.now() - lastUpdate >= DRAFT_UPDATE_INTERVAL_MS) {
          lastDraftUpdate.set(chatId, Date.now());
          logger.debug(`stream: sendMessageDraft to chat ${chatId} (${responseBuffers.get(chatId)!.text.length} chars)`);
          try {
            await (bot.api as unknown as Record<string, (chatId: number, text: string) => Promise<void>>)
              .sendMessageDraft(chatId, responseBuffers.get(chatId)!.text);
          } catch {
            // sendMessageDraft not available or failed — fall back to buffer-and-flush.
            // Don't disable streaming globally; failure may be transient.
          }
        }
      }

      return { success: true, durationMs: Date.now() - startTime };
    }

    // error: flush buffer + send error
    const errorMsg = extractErrorMessage(envelope.payload);
    if (errorMsg) {
      logger.debug(`deliver: error to chat ${chatId}: "${errorMsg.slice(0, 100)}"`);

      const buffered = responseBuffers.get(chatId)?.text ?? '';
      responseBuffers.delete(chatId);
      lastDraftUpdate.delete(chatId);
      const text = buffered
        ? truncateText(`${buffered}\n\n[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH)
        : truncateText(`[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH);
      return sendAndTrack(bot, chatId, text, startTime, callbacks);
    }

    // done: flush accumulated buffer as a single message
    if (eventType === 'done') {
      const buffered = responseBuffers.get(chatId);
      logger.debug(`deliver: done for chat ${chatId} (buffered: ${buffered ? `${buffered.text.length} chars` : 'empty'})`);
      responseBuffers.delete(chatId);
      lastDraftUpdate.delete(chatId);
      if (buffered) {
        return sendAndTrack(bot, chatId, truncateText(buffered.text, MAX_MESSAGE_LENGTH), startTime, callbacks);
      }
      return { success: true, durationMs: Date.now() - startTime };
    }

    // approval_required: flush buffered text, then render inline keyboard
    if (eventType === 'approval_required') {
      const data = extractApprovalData(envelope.payload);
      if (data) {
        logger.debug(`deliver: approval_required for tool '${data.toolName}' to chat ${chatId}`);

        // Flush accumulated text before posting the approval card so that
        // partial responses aren't lost when the stream pauses for approval.
        const buffered = responseBuffers.get(chatId);
        if (buffered?.text) {
          responseBuffers.delete(chatId);
          lastDraftUpdate.delete(chatId);
          await sendAndTrack(bot, chatId, truncateText(buffered.text, MAX_MESSAGE_LENGTH), startTime, callbacks);
        }

        return handleApprovalRequired(bot, chatId, data, envelope, callbacks, startTime);
      }
    }

    // All other StreamEvent types: silently drop (whitelist model).
    // Only text_delta, error, done, and approval_required warrant delivery actions.
    logger.debug(`deliver: dropping stream event '${eventType}' (whitelist)`);
    return { success: true, durationMs: Date.now() - startTime };
  }

  // --- Standard payload (non-StreamEvent) ---
  const content = extractPayloadContent(envelope.payload);
  const text = truncateText(content, MAX_MESSAGE_LENGTH);
  logger.debug(`deliver: standard payload to chat ${chatId} (${text.length} chars)`);
  return sendAndTrack(bot, chatId, text, startTime, callbacks);
}

/**
 * Handle a typing signal from the Relay and forward it to Telegram.
 *
 * Sends an immediate `typing` chat action and sets up an interval to
 * refresh it every 4 seconds (Telegram's indicator expires after 5s).
 * Clears the interval when the signal state changes to non-active.
 *
 * @param bot - The grammy Bot instance, or null if not started
 * @param subject - The Relay subject the typing signal was emitted on
 * @param state - The signal state ('active' | 'stopped' or other values)
 */
export async function handleTypingSignal(
  bot: Bot | null,
  subject: string,
  state: string,
): Promise<void> {
  if (!bot) return;

  const chatId = extractChatId(subject);
  if (chatId === null) return;

  if (state === 'active') {
    // Clear any existing interval (idempotent)
    clearTypingInterval(chatId);
    // Send immediately
    try {
      await bot.api.sendChatAction(chatId, TELEGRAM_TYPING_ACTION);
    } catch {
      // Typing signals are best-effort
    }
    // Refresh every 4 seconds
    const intervalId = setInterval(async () => {
      try {
        await bot.api.sendChatAction(chatId, TELEGRAM_TYPING_ACTION);
      } catch {
        clearTypingInterval(chatId);
      }
    }, TYPING_REFRESH_MS);
    typingIntervals.set(chatId, intervalId);
  } else {
    clearTypingInterval(chatId);
  }
}

/**
 * Clear the typing refresh interval for a specific chat.
 *
 * @param chatId - The Telegram chat ID to clear the interval for
 */
function clearTypingInterval(chatId: number): void {
  const existing = typingIntervals.get(chatId);
  if (existing !== undefined) {
    clearInterval(existing);
    typingIntervals.delete(chatId);
  }
}

/**
 * Clear all active typing intervals and draft update state.
 *
 * Call on adapter stop to prevent leaked intervals and stale throttle state.
 */
export function clearAllTypingIntervals(): void {
  for (const interval of typingIntervals.values()) clearInterval(interval);
  typingIntervals.clear();
  lastDraftUpdate.clear();
}

// === Approval handling ===

/**
 * Extract agentId from the enriched approval_required event payload.
 *
 * @param envelope - The relay envelope containing the approval_required event
 */
function extractAgentIdFromEnvelope(envelope: RelayEnvelope): string {
  const payload = envelope.payload as Record<string, unknown> | null;
  const data = payload?.data as Record<string, unknown> | undefined;
  return (data?.agentId as string) ?? 'unknown';
}

/**
 * Extract ccaSessionKey from the enriched approval_required event payload.
 *
 * @param envelope - The relay envelope containing the approval_required event
 */
function extractSessionIdFromEnvelope(envelope: RelayEnvelope): string {
  const payload = envelope.payload as Record<string, unknown> | null;
  const data = payload?.data as Record<string, unknown> | undefined;
  return (data?.ccaSessionKey as string) ?? 'unknown';
}

/**
 * Render a Telegram inline keyboard with Approve/Deny buttons.
 *
 * Uses a 12-character random short key stored in {@link callbackIdMap} to work
 * around Telegram's 64-byte `callback_data` limit. The short key is evicted
 * from the map after {@link CALLBACK_ID_TTL_MS} to prevent unbounded growth.
 *
 * @param bot - Grammy Bot instance
 * @param chatId - Telegram chat ID
 * @param data - Parsed approval data from the approval_required event
 * @param envelope - The relay envelope (used to extract agentId/sessionId)
 * @param callbacks - Outbound tracking callbacks
 * @param startTime - Delivery start timestamp for duration tracking
 */
async function handleApprovalRequired(
  bot: Bot,
  chatId: number,
  data: ApprovalData,
  envelope: RelayEnvelope,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  const agentId = extractAgentIdFromEnvelope(envelope);
  const sessionId = extractSessionIdFromEnvelope(envelope);

  // Generate a short lookup key (12 hex chars = 6 bytes) for the 64-byte callback_data limit.
  // The full IDs are stored in callbackIdMap and evicted after CALLBACK_ID_TTL_MS.
  const shortKey = randomBytes(6).toString('hex');
  callbackIdMap.set(shortKey, { toolCallId: data.toolCallId, sessionId, agentId });
  setTimeout(() => callbackIdMap.delete(shortKey), CALLBACK_ID_TTL_MS);

  const toolDescription = formatToolDescription(data.toolName, data.input);
  const inputPreview = truncateText(data.input, 400);
  const messageText =
    `*Tool Approval Required*\n` +
    `\`${data.toolName}\` ${toolDescription}\n\n` +
    `\`\`\`\n${inputPreview}\n\`\`\``;

  try {
    const sent = await bot.api.sendMessage(chatId, messageText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: JSON.stringify({ k: shortKey, a: 1 }) },
            { text: 'Deny', callback_data: JSON.stringify({ k: shortKey, a: 0 }) },
          ],
        ],
      },
    } as Parameters<typeof bot.api.sendMessage>[2]);

    // Register timeout to auto-expire the approval card
    if (data.timeoutMs && data.timeoutMs > 0) {
      const timer = setTimeout(async () => {
        pendingApprovalTimeouts.delete(shortKey);
        callbackIdMap.delete(shortKey);
        try {
          await bot.api.editMessageText(
            chatId,
            sent.message_id,
            `\u23F0 *Tool Approval Timed Out*\n~~\`${data.toolName}\`~~ ${toolDescription}`,
            { parse_mode: 'Markdown' },
          );
        } catch {
          // best-effort — message may have been deleted
        }
      }, data.timeoutMs);
      pendingApprovalTimeouts.set(shortKey, timer);
    }

    callbacks.trackOutbound();
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    callbacks.recordError(err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
