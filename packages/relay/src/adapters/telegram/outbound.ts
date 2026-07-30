/**
 * Telegram outbound message delivery.
 *
 * Handles deliver() implementation including message splitting for
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
  formatToolDescriptionHtml,
  escapeHtml,
  extractAgentIdFromEnvelope,
  extractSessionIdFromEnvelope,
  splitTelegramHtml,
} from '../../lib/payload-utils.js';
import type { ApprovalData } from '../../lib/payload-utils.js';
import { isBlockingInteractionEventType } from '@dorkos/shared/session-stream';
import { extractChatId } from './inbound.js';
import type { TelegramThreadIdCodec } from '../../lib/thread-id.js';
import { sendMessageDraft } from './stream-api.js';

/** Telegram sendChatAction type for typing indicator. */
const TELEGRAM_TYPING_ACTION = 'typing' as const;

/** Refresh interval for Telegram typing indicator (expires after 5s). */
export const TYPING_REFRESH_MS = 4_000;

/**
 * How long a chat's stream may go silent before the typing loop stops itself.
 *
 * This is **not** the 60-second blind cap that used to run from the moment a
 * message arrived. That one was keyed to work — it cut a turn that was still
 * running and typed for turns that never started. This one is keyed to
 * observation, and every event restates it: a turn that reports in is never
 * cut, however long it takes. Only a stream that has gone dark is.
 *
 * It is needed because a terminal is not guaranteed. The `done` publish
 * upstream is best-effort (a failed publish only warns), and a stalled stream
 * may never reach the code that emits one — so without this, one lost terminal
 * types at a chat forever. The response buffer in this same file already
 * carries a bound for the same reason ({@link BUFFER_TTL_MS}); the indicator a
 * person actually sees should not be the one thing left unbounded.
 *
 * 60s is the forgiving end of the band. The cost is honest and small: a turn
 * that emits nothing at all for a full minute — a long silent tool call —
 * stops showing typing, and starts again on its next event.
 */
export const TYPING_INACTIVITY_MS = 60_000;

/** Minimum interval (ms) between sendMessageDraft calls for a single chat. */
const DRAFT_UPDATE_INTERVAL_MS = 200;

/** TTL for response buffers (ms). Buffers older than this are reaped to prevent memory leaks. */
export const BUFFER_TTL_MS = 5 * 60 * 1_000;

/** Maximum age (ms) for callbackIdMap entries before auto-eviction. */
const CALLBACK_ID_TTL_MS = 15 * 60 * 1_000;

/**
 * Mutable state for Telegram outbound delivery, scoped to a single adapter instance.
 *
 * Isolating state per-instance prevents cross-adapter information leakage when
 * `multiInstance: true` is set on the adapter manifest, and ensures state is
 * fully reset on adapter stop/start cycles.
 */
export interface TelegramOutboundState {
  /** Active typing loops keyed by chatId — one per chat with a live turn. */
  typingIntervals: Map<number, ReturnType<typeof setInterval>>;
  /**
   * When this chat's stream last said anything, keyed by chatId.
   *
   * The typing loop reads it to notice a stream that has gone dark
   * ({@link TYPING_INACTIVITY_MS}); every event restates it.
   */
  lastEventAt: Map<number, number>;
  /** Last sendMessageDraft timestamp per chat (for throttling). */
  lastDraftUpdate: Map<number, number>;
  /**
   * In-memory map from short callback key to full approval IDs.
   *
   * Telegram's callback_data field is limited to 64 bytes. We store the full
   * IDs here and encode only a 12-character short key in the button payload.
   */
  callbackIdMap: Map<string, { toolCallId: string; sessionId: string; agentId: string }>;
  /** Pending approval timeouts keyed by callback short key. */
  pendingApprovalTimeouts: Map<string, ReturnType<typeof setTimeout>>;
}

/** Create a fresh outbound state container for a new adapter instance. */
export function createTelegramOutboundState(): TelegramOutboundState {
  return {
    typingIntervals: new Map(),
    lastEventAt: new Map(),
    lastDraftUpdate: new Map(),
    callbackIdMap: new Map(),
    pendingApprovalTimeouts: new Map(),
  };
}

/**
 * Clear a pending approval timeout when the user clicks Approve/Deny.
 *
 * @param state - The adapter's outbound state container
 * @param shortKey - The short callback key to clear
 */
export function clearApprovalTimeout(state: TelegramOutboundState, shortKey: string): void {
  const timer = state.pendingApprovalTimeouts.get(shortKey);
  if (timer) {
    clearTimeout(timer);
    state.pendingApprovalTimeouts.delete(shortKey);
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
  /** Instance-scoped mutable state for this adapter. */
  state: TelegramOutboundState;
  callbacks: AdapterOutboundCallbacks;
  streaming: boolean;
  /** Instance-scoped codec for subject encoding/decoding. */
  codec: TelegramThreadIdCodec;
  logger?: RelayLogger;
}

/**
 * Format, split, and send a text message to Telegram.
 *
 * Splits the raw Markdown into chunks first, then converts each chunk to
 * Telegram HTML — splitting after conversion would produce chunks with
 * unbalanced tags that Telegram rejects, failing the entire delivery.
 * Every sent chunk fits within Telegram's 4096-character limit.
 *
 * @param bot - The grammy Bot instance
 * @param chatId - The Telegram chat ID
 * @param text - The message text to send (Markdown)
 * @param startTime - Timestamp (ms) for delivery duration calculation
 * @param callbacks - Callbacks to mutate adapter state
 */
async function sendAndTrack(
  bot: Bot,
  chatId: number,
  text: string,
  startTime: number,
  callbacks: AdapterOutboundCallbacks
): Promise<DeliveryResult> {
  try {
    const chunks = splitTelegramHtml(text);

    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' } as Parameters<
        typeof bot.api.sendMessage
      >[2]);
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

/**
 * Is this delivery an event from a turn that is still running?
 *
 * True for any runtime stream event that is not a terminal. A non-stream
 * payload is a finished message, not a turn in progress, so it is false.
 *
 * The terminals are `done`, an `error` — classified on the event type, never
 * on whether a message could be extracted from it, so a malformed error still
 * ends the turn — and the three interactions that block on a person, which
 * come from `BLOCKING_INTERACTION_EVENT_TYPES` in `@dorkos/shared` so this
 * list cannot drift from the session projector's `blocked` lifecycle. Those
 * three matter twice over here: `deliverMessage`'s whitelist drops question
 * and elicitation prompts, so typing through one would show a chat that
 * somebody is working when the turn is actually stalled on a question that
 * chat never received.
 *
 * @param eventType - The detected StreamEvent type, or null for a plain payload
 */
function isTurnRunning(eventType: string | null): boolean {
  if (!eventType) return false;
  if (eventType === 'done' || eventType === 'error') return false;
  return !isBlockingInteractionEventType(eventType);
}

/**
 * Deliver a Relay message to the Telegram chat identified by the subject.
 *
 * Extracts the chat ID from the subject, reads the payload content, and
 * sends it via the Telegram Bot API. Messages exceeding Telegram's
 * 4096-character limit are split at newline boundaries into multiple
 * messages. StreamEvent payloads are buffered per-chat and flushed on
 * 'done' or 'error' events.
 *
 * @param opts - Delivery options
 */
export async function deliverMessage(opts: TelegramDeliverOptions): Promise<DeliveryResult> {
  const {
    adapterId,
    subject,
    envelope,
    bot,
    responseBuffers,
    state,
    callbacks,
    streaming,
    codec,
    logger = noopLogger,
  } = opts;
  const startTime = Date.now();

  // Guard: skip messages that originated from this adapter to prevent echo.
  // Inbound messages are published with `from: <prefix>.bot`,
  // which starts with our subject prefix. Without this guard the publish
  // pipeline routes the message right back to deliver(), creating a loop.
  if (envelope.from.startsWith(codec.prefix)) {
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

  const chatId = extractChatId(codec, subject);
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
      state.lastDraftUpdate.delete(id);
      logger.warn(
        `buffer: reaped stale buffer for chat ${id} (age: ${Math.round((now - buf.startedAt) / 1000)}s)`
      );
    }
  }

  // --- StreamEvent-aware delivery ---
  const eventType = detectStreamEventType(envelope.payload);

  // The turn's lifecycle, as this adapter can observe it. A runtime event for
  // this chat is evidence a turn is really running; `done`, an error, an
  // interaction waiting on a person, and a plain finished reply all end that
  // span. The message merely arriving proves nothing and drives nothing —
  // that was the fake E16 forbids.
  if (isTurnRunning(eventType)) {
    state.lastEventAt.set(chatId, Date.now());
    startTypingLoop(bot, chatId, state);
  } else {
    clearTypingInterval(state, chatId);
  }

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
        const lastUpdate = state.lastDraftUpdate.get(chatId) ?? 0;
        if (Date.now() - lastUpdate >= DRAFT_UPDATE_INTERVAL_MS) {
          state.lastDraftUpdate.set(chatId, Date.now());
          logger.debug(
            `stream: sendMessageDraft to chat ${chatId} (${responseBuffers.get(chatId)!.text.length} chars)`
          );
          try {
            await sendMessageDraft(bot, chatId, responseBuffers.get(chatId)!.text);
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
      state.lastDraftUpdate.delete(chatId);
      const text = buffered ? `${buffered}\n\n[Error: ${errorMsg}]` : `[Error: ${errorMsg}]`;
      return sendAndTrack(bot, chatId, text, startTime, callbacks);
    }

    // done: flush accumulated buffer as a single message
    if (eventType === 'done') {
      const buffered = responseBuffers.get(chatId);
      logger.debug(
        `deliver: done for chat ${chatId} (buffered: ${buffered ? `${buffered.text.length} chars` : 'empty'})`
      );
      responseBuffers.delete(chatId);
      state.lastDraftUpdate.delete(chatId);
      if (buffered) {
        return sendAndTrack(bot, chatId, buffered.text, startTime, callbacks);
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
          state.lastDraftUpdate.delete(chatId);
          await sendAndTrack(bot, chatId, buffered.text, startTime, callbacks);
        }

        return handleApprovalRequired({
          bot,
          chatId,
          data,
          envelope,
          state,
          callbacks,
          startTime,
          logger,
        });
      }
    }

    // All other StreamEvent types: silently drop (whitelist model).
    // Only text_delta, error, done, and approval_required warrant delivery actions.
    logger.debug(`deliver: dropping stream event '${eventType}' (whitelist)`);
    return { success: true, durationMs: Date.now() - startTime };
  }

  // --- Standard payload (non-StreamEvent) ---
  const content = extractPayloadContent(envelope.payload);
  logger.debug(`deliver: standard payload to chat ${chatId} (${content.length} chars)`);
  return sendAndTrack(bot, chatId, content, startTime, callbacks);
}

/**
 * Start (or keep) the typing loop for a chat whose turn is running.
 *
 * Sends `sendChatAction('typing')` immediately and refreshes it every
 * {@link TYPING_REFRESH_MS} — under Telegram's 5-second expiry, so the
 * indicator stays continuous for as long as the turn does.
 *
 * Idempotent by keeping, not by restarting: a turn emits many events, and
 * restarting the loop on each one would fire a chat action per streamed chunk
 * and keep resetting the cadence. The loop is per **chat**, not per turn — two
 * turns racing into one chat share it, and the first terminal silences the
 * other for one event's worth of time before its next event restarts the loop.
 * That conflation is inherited (the whole outbound path is keyed by chat, down
 * to the response buffer) and is documented rather than fixed here.
 *
 * The loop ends on a terminal, or — if the terminal never comes — after
 * {@link TYPING_INACTIVITY_MS} of silence from the stream.
 *
 * @param bot - The grammy Bot instance, or null if not started
 * @param chatId - The Telegram chat ID to show typing in
 * @param state - The adapter's instance-scoped outbound state
 */
function startTypingLoop(bot: Bot | null, chatId: number, state: TelegramOutboundState): void {
  if (!bot) return;
  if (state.typingIntervals.has(chatId)) return;

  bot.api.sendChatAction(chatId, TELEGRAM_TYPING_ACTION).catch(() => {
    // Best-effort: a chat action nobody can see is not worth failing a turn over.
  });

  const intervalId = setInterval(() => {
    if (Date.now() - (state.lastEventAt.get(chatId) ?? 0) > TYPING_INACTIVITY_MS) {
      clearTypingInterval(state, chatId);
      return;
    }
    bot.api.sendChatAction(chatId, TELEGRAM_TYPING_ACTION).catch(() => {
      clearTypingInterval(state, chatId);
    });
  }, TYPING_REFRESH_MS);
  state.typingIntervals.set(chatId, intervalId);
}

/**
 * Handle a `typing` signal from the Relay and forward it to Telegram.
 *
 * This is the seam for lifecycles the adapter cannot observe in its own
 * outbound stream. Today nothing on the relay bus emits `typing` signals, so
 * the live driver is the turn itself (see {@link deliverMessage}); a Telegram
 * chat bridged to a **room** would arrive here instead, mapping the room's
 * `working`/`done` presence onto the same single loop rather than a second
 * one. No such bridge exists yet: room presence is published to the room's
 * own event stream (`RoomService.publishSignal`) and reaches the cockpit, not
 * a relay adapter.
 *
 * @param bot - The grammy Bot instance, or null if not started
 * @param subject - The Relay subject the typing signal was emitted on
 * @param outboundState - The adapter's instance-scoped outbound state
 * @param signalState - The signal state ('active' | 'stopped' or other values)
 * @param codec - The adapter's instance-scoped subject codec
 */
export function handleTypingSignal(
  bot: Bot | null,
  subject: string,
  outboundState: TelegramOutboundState,
  signalState: string,
  codec: TelegramThreadIdCodec
): void {
  if (!bot) return;

  const chatId = extractChatId(codec, subject);
  if (chatId === null) return;

  if (signalState === 'active') {
    // A signal is an observation like any other, so it restates the
    // inactivity bound: a producer that keeps signalling keeps the indicator,
    // and one that stops being heard from loses it.
    outboundState.lastEventAt.set(chatId, Date.now());
    startTypingLoop(bot, chatId, outboundState);
  } else {
    clearTypingInterval(outboundState, chatId);
  }
}

/**
 * Clear the typing refresh interval for a specific chat.
 *
 * @param state - The adapter's outbound state container
 * @param chatId - The Telegram chat ID to clear the interval for
 */
function clearTypingInterval(state: TelegramOutboundState, chatId: number): void {
  const existing = state.typingIntervals.get(chatId);
  if (existing !== undefined) {
    clearInterval(existing);
    state.typingIntervals.delete(chatId);
  }
  state.lastEventAt.delete(chatId);
}

/**
 * Clear all active typing intervals and draft update state.
 *
 * Call on adapter stop to prevent leaked intervals and stale throttle state.
 *
 * @param state - The adapter's outbound state container
 */
export function clearAllTypingIntervals(state: TelegramOutboundState): void {
  for (const interval of state.typingIntervals.values()) clearInterval(interval);
  state.typingIntervals.clear();
  state.lastEventAt.clear();
  state.lastDraftUpdate.clear();
}

// === Approval handling ===

/** Maximum characters of raw tool input shown in the approval card. */
const APPROVAL_INPUT_PREVIEW_LENGTH = 400;

/**
 * Build the HTML body of a Telegram tool-approval card.
 *
 * All tool-controlled text (tool name, input preview) is HTML-escaped — the
 * card is sent with `parse_mode: 'HTML'`, and a single unescaped `<`/`>`/`&`
 * makes Telegram reject the whole message with a 400, swallowing the approval
 * card and leaving the tool call hanging until timeout.
 *
 * Exported as a pure function so the adapter compliance suite's
 * `approvalInputSafety` check exercises this REAL assembly — a mirror copy in
 * the test would stay green if escaping regressed here.
 *
 * @param toolName - The tool requesting approval (tool-controlled text)
 * @param input - The raw tool input (tool-controlled text)
 */
export function buildApprovalCardHtml(toolName: string, input: string): string {
  const toolDescription = formatToolDescriptionHtml(toolName, input);
  const inputPreview = truncateText(input, APPROVAL_INPUT_PREVIEW_LENGTH);
  return (
    `<b>Tool Approval Required</b>\n` +
    `<code>${escapeHtml(toolName)}</code> ${toolDescription}\n\n` +
    `<pre>${escapeHtml(inputPreview)}</pre>`
  );
}

/** Options for rendering a Telegram approval card. */
interface ApprovalCardOptions {
  /** Grammy Bot instance. */
  bot: Bot;
  /** Telegram chat ID. */
  chatId: number;
  /** Parsed approval data from the approval_required event. */
  data: ApprovalData;
  /** The relay envelope (used to extract agentId/sessionId). */
  envelope: RelayEnvelope;
  /** The adapter's instance-scoped outbound state. */
  state: TelegramOutboundState;
  /** Outbound tracking callbacks. */
  callbacks: AdapterOutboundCallbacks;
  /** Delivery start timestamp for duration tracking. */
  startTime: number;
  /** Logger for surfacing delivery failures. */
  logger: RelayLogger;
}

/**
 * Render a Telegram inline keyboard with Approve/Deny buttons.
 *
 * The card is sent in HTML parse mode with all tool-controlled text escaped —
 * legacy Markdown mode hard-fails on unbalanced entities (backticks or
 * underscores inside tool input), which would swallow the approval card and
 * leave the tool call hanging until timeout.
 *
 * Uses a 12-character random short key stored in {@link TelegramOutboundState.callbackIdMap}
 * to work around Telegram's 64-byte `callback_data` limit. The short key is
 * evicted from the map after {@link CALLBACK_ID_TTL_MS} to prevent unbounded growth.
 *
 * @param opts - Approval card options
 */
async function handleApprovalRequired(opts: ApprovalCardOptions): Promise<DeliveryResult> {
  const { bot, chatId, data, envelope, state, callbacks, startTime, logger } = opts;
  const agentId = extractAgentIdFromEnvelope(envelope) ?? 'unknown';
  const sessionId = extractSessionIdFromEnvelope(envelope) ?? 'unknown';

  // Generate a short lookup key (12 hex chars = 6 bytes) for the 64-byte callback_data limit.
  // The full IDs are stored in state.callbackIdMap and evicted after CALLBACK_ID_TTL_MS.
  const shortKey = randomBytes(6).toString('hex');
  state.callbackIdMap.set(shortKey, { toolCallId: data.toolCallId, sessionId, agentId });
  setTimeout(() => state.callbackIdMap.delete(shortKey), CALLBACK_ID_TTL_MS);

  // toolDescription is reused by the timeout edit below.
  const toolDescription = formatToolDescriptionHtml(data.toolName, data.input);
  const messageText = buildApprovalCardHtml(data.toolName, data.input);

  try {
    const sent = await bot.api.sendMessage(chatId, messageText, {
      parse_mode: 'HTML',
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
        state.pendingApprovalTimeouts.delete(shortKey);
        state.callbackIdMap.delete(shortKey);
        try {
          await bot.api.editMessageText(
            chatId,
            sent.message_id,
            `\u23F0 <b>Tool Approval Timed Out</b>\n` +
              `<s><code>${escapeHtml(data.toolName)}</code></s> ${toolDescription}`,
            { parse_mode: 'HTML' }
          );
        } catch {
          // best-effort — message may have been deleted
        }
      }, data.timeoutMs);
      state.pendingApprovalTimeouts.set(shortKey, timer);
    }

    callbacks.trackOutbound();
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud by design: a swallowed approval card means the tool call hangs
    // until timeout with no user-visible signal anywhere.
    logger.error(
      `approval: failed to deliver approval card for tool '${data.toolName}' to chat ${chatId} — ` +
        `the tool call will hang until it times out: ${message}`
    );
    callbacks.recordError(err);
    return {
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    };
  }
}
