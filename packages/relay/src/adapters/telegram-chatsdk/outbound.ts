/**
 * Outbound message delivery for the Chat SDK Telegram adapter.
 *
 * Handles posting text messages and tool approval prompts to Telegram
 * via the Chat SDK TelegramAdapter's postMessage API.
 *
 * @module relay/adapters/telegram-chatsdk/outbound
 */
import type { TelegramAdapter } from '@chat-adapter/telegram';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';
import {
  extractPayloadContent,
  extractApprovalData,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  truncateText,
  formatToolDescription,
  formatForPlatform,
} from '../../lib/payload-utils.js';
import { MAX_MESSAGE_LENGTH } from './inbound.js';
import { ChatSdkTelegramThreadIdCodec } from '../../lib/thread-id.js';

/** TTL for response buffers (ms). Buffers older than this are reaped to prevent memory leaks. */
export const BUFFER_TTL_MS = 5 * 60 * 1_000;

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

/**
 * Deliver a relay envelope to a Telegram thread via the Chat SDK adapter.
 *
 * Handles StreamEvent payloads (text_delta, done, error, approval_required)
 * with per-chat buffering, and falls back to plain text delivery for
 * non-StreamEvent payloads.
 *
 * @param subject - The relay subject (e.g., relay.human.telegram-chatsdk.123456)
 * @param envelope - The relay envelope to deliver
 * @param telegramAdapter - The Chat SDK TelegramAdapter instance
 * @param responseBuffers - Per-chat response buffer map for StreamEvent accumulation
 * @param callbacks - Callbacks to track outbound counts and errors
 * @param logger - Logger for debug/warn output
 * @param codec - ThreadIdCodec for subject decoding
 */
export async function deliverMessage(
  subject: string,
  envelope: RelayEnvelope,
  telegramAdapter: TelegramAdapter | null,
  responseBuffers: Map<string, ResponseBuffer>,
  callbacks: AdapterOutboundCallbacks,
  logger: RelayLogger = noopLogger,
  codec?: ChatSdkTelegramThreadIdCodec
): Promise<DeliveryResult> {
  if (!telegramAdapter) {
    return { success: false, error: 'TelegramAdapter not initialized' };
  }

  const resolvedCodec = codec ?? new ChatSdkTelegramThreadIdCodec();
  const decoded = resolvedCodec.decode(subject);
  if (!decoded) {
    return { success: false, error: `Subject does not match codec: ${subject}` };
  }

  const { platformId } = decoded;

  // Reap stale buffers to prevent unbounded memory growth.
  const now = Date.now();
  for (const [id, buf] of responseBuffers) {
    if (now - buf.startedAt > BUFFER_TTL_MS) {
      responseBuffers.delete(id);
      logger.warn(
        `[TelegramChatSdk] buffer: reaped stale buffer for thread ${id} (age: ${Math.round((now - buf.startedAt) / 1000)}s)`
      );
    }
  }

  try {
    // --- StreamEvent-aware delivery ---
    const eventType = detectStreamEventType(envelope.payload);

    if (eventType) {
      // text_delta: accumulate in buffer
      const textChunk = extractTextDelta(envelope.payload);
      if (textChunk) {
        logger.debug(
          `[TelegramChatSdk] deliver: text_delta to thread ${platformId} (${textChunk.length} chars)`
        );
        const existing = responseBuffers.get(platformId);
        responseBuffers.set(platformId, {
          text: (existing?.text ?? '') + textChunk,
          startedAt: existing?.startedAt ?? Date.now(),
        });
        return { success: true };
      }

      // error: flush buffer + send error
      const errorMsg = extractErrorMessage(envelope.payload);
      if (errorMsg) {
        logger.debug(
          `[TelegramChatSdk] deliver: error to thread ${platformId}: "${errorMsg.slice(0, 100)}"`
        );
        const buffered = responseBuffers.get(platformId)?.text ?? '';
        responseBuffers.delete(platformId);
        const text = buffered
          ? truncateText(`${buffered}\n\n[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH)
          : truncateText(`[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH);
        return await deliverTextContent(platformId, text, telegramAdapter, callbacks, logger);
      }

      // done: flush accumulated buffer as a single message
      if (eventType === 'done') {
        const buffered = responseBuffers.get(platformId);
        logger.debug(
          `[TelegramChatSdk] deliver: done for thread ${platformId} (buffered: ${buffered ? `${buffered.text.length} chars` : 'empty'})`
        );
        responseBuffers.delete(platformId);
        if (buffered) {
          return await deliverTextContent(
            platformId,
            truncateText(buffered.text, MAX_MESSAGE_LENGTH),
            telegramAdapter,
            callbacks,
            logger
          );
        }
        return { success: true };
      }

      // approval_required: flush buffered text, then render approval prompt
      if (eventType === 'approval_required') {
        const data = extractApprovalData(envelope.payload);
        if (data) {
          logger.debug(
            `[TelegramChatSdk] deliver: approval_required for tool '${data.toolName}' to thread ${platformId}`
          );

          // Flush accumulated text before posting the approval card
          const buffered = responseBuffers.get(platformId);
          if (buffered?.text) {
            responseBuffers.delete(platformId);
            await deliverTextContent(
              platformId,
              truncateText(buffered.text, MAX_MESSAGE_LENGTH),
              telegramAdapter,
              callbacks,
              logger
            );
          }

          return await deliverApprovalRequest(platformId, data, telegramAdapter, callbacks, logger);
        }
      }

      // All other StreamEvent types: silently drop (whitelist model).
      logger.debug(`[TelegramChatSdk] deliver: dropping stream event '${eventType}' (whitelist)`);
      return { success: true };
    }

    // --- Standard payload (non-StreamEvent) ---
    return await deliverText(platformId, envelope, telegramAdapter, callbacks, logger);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    callbacks.recordError(err);
    logger.warn(`[TelegramChatSdk] deliver failed for thread ${platformId}: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Deliver plain text to a Telegram chat via the Chat SDK adapter.
 *
 * Converts Markdown content to Telegram HTML and posts it, splitting
 * messages that exceed Telegram's 4096-character limit.
 *
 * @param threadId - The Telegram chat ID (as string)
 * @param envelope - The relay envelope with text payload
 * @param telegramAdapter - The Chat SDK TelegramAdapter instance
 * @param callbacks - Outbound tracking callbacks
 * @param logger - Logger for debug output
 */
async function deliverText(
  threadId: string,
  envelope: RelayEnvelope,
  telegramAdapter: TelegramAdapter,
  callbacks: AdapterOutboundCallbacks,
  logger: RelayLogger
): Promise<DeliveryResult> {
  const rawContent = extractPayloadContent(envelope.payload);
  const content = formatForPlatform(rawContent, 'telegram');
  const chunks = splitMessage(content, MAX_MESSAGE_LENGTH);

  for (const chunk of chunks) {
    await telegramAdapter.postMessage(threadId, { raw: chunk });
  }

  callbacks.trackOutbound();
  logger.debug(`[TelegramChatSdk] delivered text to thread ${threadId}: ${chunks.length} chunk(s)`);
  return { success: true };
}

/**
 * Deliver pre-extracted text content to a Telegram chat.
 *
 * Used by StreamEvent handlers (done, error) that have already assembled
 * the final text. Formats for Telegram and splits if needed.
 *
 * @param threadId - The Telegram chat ID (as string)
 * @param content - Pre-assembled text content (Markdown)
 * @param telegramAdapter - The Chat SDK TelegramAdapter instance
 * @param callbacks - Outbound tracking callbacks
 * @param logger - Logger for debug output
 */
async function deliverTextContent(
  threadId: string,
  content: string,
  telegramAdapter: TelegramAdapter,
  callbacks: AdapterOutboundCallbacks,
  logger: RelayLogger
): Promise<DeliveryResult> {
  const formatted = formatForPlatform(content, 'telegram');
  const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH);

  for (const chunk of chunks) {
    await telegramAdapter.postMessage(threadId, { raw: chunk });
  }

  callbacks.trackOutbound();
  logger.debug(`[TelegramChatSdk] delivered text to thread ${threadId}: ${chunks.length} chunk(s)`);
  return { success: true };
}

/**
 * Deliver a tool approval prompt to a Telegram chat via the Chat SDK adapter.
 *
 * Posts a plain text prompt since inline keyboards require native grammy
 * integration. The user responds with "approve" or "deny".
 *
 * @param threadId - The Telegram chat ID (as string)
 * @param approvalData - Parsed tool approval data
 * @param telegramAdapter - The Chat SDK TelegramAdapter instance
 * @param callbacks - Outbound tracking callbacks
 * @param logger - Logger for debug output
 */
async function deliverApprovalRequest(
  threadId: string,
  approvalData: NonNullable<ReturnType<typeof extractApprovalData>>,
  telegramAdapter: TelegramAdapter,
  callbacks: AdapterOutboundCallbacks,
  logger: RelayLogger
): Promise<DeliveryResult> {
  const description = formatToolDescription(approvalData.toolName, approvalData.input);
  const text =
    `\u{1F6A8} *Tool Approval Required*\n\n` +
    `Your agent ${description}.\n\n` +
    `Reply \`approve\` to allow or \`deny\` to block.`;

  await telegramAdapter.postMessage(threadId, { raw: text });

  callbacks.trackOutbound();
  logger.debug(
    `[TelegramChatSdk] delivered approval request to thread ${threadId}: tool=${approvalData.toolName}`
  );
  return { success: true };
}

/**
 * Deliver a streaming response to a Telegram thread via the Chat SDK adapter.
 *
 * Uses the adapter's native stream() method if available, otherwise
 * falls back to accumulating all chunks and posting the full text.
 *
 * @param subject - The relay subject to derive the Telegram thread ID from
 * @param stream - Async iterable of text chunks to deliver incrementally
 * @param telegramAdapter - The Chat SDK TelegramAdapter instance
 * @param callbacks - Outbound tracking callbacks
 * @param logger - Logger for debug output
 */
export async function deliverStream(
  subject: string,
  stream: AsyncIterable<string>,
  telegramAdapter: TelegramAdapter | null,
  callbacks: AdapterOutboundCallbacks,
  logger: RelayLogger = noopLogger,
  codec?: ChatSdkTelegramThreadIdCodec
): Promise<DeliveryResult> {
  if (!telegramAdapter) {
    return { success: false, error: 'TelegramAdapter not initialized' };
  }

  const resolvedCodec = codec ?? new ChatSdkTelegramThreadIdCodec();
  const decoded = resolvedCodec.decode(subject);
  if (!decoded) {
    return { success: false, error: `Subject does not match codec: ${subject}` };
  }

  const { platformId } = decoded;

  try {
    // Accumulate the full stream then post — TelegramAdapter has no native
    // streaming API at the adapter level (streaming is thread-level only).
    let accumulated = '';
    for await (const chunk of stream) {
      accumulated += chunk;
    }
    if (accumulated) {
      const chunks = splitMessage(formatForPlatform(accumulated, 'telegram'), MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await telegramAdapter.postMessage(platformId, { raw: chunk });
      }
    }

    callbacks.trackOutbound();
    logger.debug(`[TelegramChatSdk] delivered stream to thread ${platformId}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    callbacks.recordError(err);
    logger.warn(`[TelegramChatSdk] deliverStream failed for thread ${platformId}: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Split a message string into chunks that respect Telegram's character limit.
 *
 * Prefers splitting at newline boundaries to avoid breaking mid-sentence.
 *
 * @param text - The full message text
 * @param maxLen - Maximum characters per chunk
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Prefer splitting at a newline boundary within the limit
    const boundary = remaining.lastIndexOf('\n', maxLen);
    const splitAt = boundary > 0 ? boundary + 1 : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
