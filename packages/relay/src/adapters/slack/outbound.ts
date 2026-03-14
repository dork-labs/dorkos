/**
 * Slack outbound message delivery.
 *
 * Handles deliver() implementation including Slack's native streaming API
 * for real-time token-by-token responses, standard postMessage for
 * non-StreamEvent payloads, threading, and echo prevention.
 *
 * @module relay/adapters/slack-outbound
 */
import type { WebClient } from '@slack/web-api';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult } from '../../types.js';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  truncateText,
  SILENT_EVENT_TYPES,
  formatForPlatform,
} from '../../lib/payload-utils.js';
import { extractChannelId, SUBJECT_PREFIX, MAX_MESSAGE_LENGTH } from './inbound.js';

// === Types ===

/** Active stream state for a channel (keyed by channelId:threadTs). */
export interface ActiveStream {
  /** The channel ID being streamed to. */
  channelId: string;
  /** The thread_ts to reply under. */
  threadTs: string;
  /** The message ts returned by chat.postMessage (updated by streaming). */
  messageTs: string;
  /** Accumulated text content for the stream. */
  accumulatedText: string;
}

/** Options for delivering a Relay message to Slack. */
export interface SlackDeliverOptions {
  adapterId: string;
  subject: string;
  envelope: RelayEnvelope;
  client: WebClient | null;
  streamState: Map<string, ActiveStream>;
  botUserId: string;
  callbacks: AdapterOutboundCallbacks;
}

// === Helpers ===

/**
 * Build a composite key for stream state that is thread-safe.
 *
 * When replying in a thread, different threads in the same channel
 * get independent stream state.
 *
 * @param channelId - The Slack channel ID
 * @param threadTs - Optional thread timestamp
 */
function streamKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

/**
 * Resolve the thread_ts from a relay envelope for threading replies.
 *
 * Looks for platformData.threadTs (already in a thread) or platformData.ts
 * (the original message — start a new thread) from the inbound message context
 * carried through the relay envelope.
 *
 * @param envelope - The relay envelope to inspect
 */
function resolveThreadTs(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') return undefined;

  const obj = payload as Record<string, unknown>;
  const pd = obj.platformData as Record<string, unknown> | undefined;
  if (!pd) return undefined;

  // threadTs takes precedence (already in a thread)
  if (typeof pd.threadTs === 'string') return pd.threadTs;
  // ts of the original message (start a new thread)
  if (typeof pd.ts === 'string') return pd.ts;

  return undefined;
}

/**
 * Execute a Slack API call and return a DeliveryResult.
 *
 * Wraps common try/catch + duration + error recording logic shared
 * across all stream handlers.
 *
 * @param fn - The async Slack API operation to execute
 * @param callbacks - Callbacks for error recording
 * @param startTime - Timestamp (ms) for delivery duration calculation
 * @param trackDelivery - Whether to call trackOutbound on success
 */
async function wrapSlackCall(
  fn: () => Promise<unknown>,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
  trackDelivery = false,
): Promise<DeliveryResult> {
  try {
    await fn();
    if (trackDelivery) callbacks.trackOutbound();
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

// === Stream handlers ===

/**
 * Handle a text_delta StreamEvent — start or append to a streaming message.
 *
 * On the first delta for a channel+thread, posts a new message via chat.postMessage
 * and stores the returned ts in streamState. On subsequent deltas, appends
 * the mrkdwn chunk to the accumulated text and updates the message via
 * chat.update (live editing effect).
 *
 * @param channelId - The Slack channel ID
 * @param textChunk - The raw text chunk to append
 * @param threadTs - Optional thread_ts to reply under
 * @param client - Slack WebClient instance
 * @param streamState - Per-channel active stream state map
 * @param callbacks - Callbacks to track delivery metrics
 * @param startTime - Timestamp (ms) for delivery duration calculation
 */
async function handleTextDelta(
  channelId: string,
  textChunk: string,
  threadTs: string | undefined,
  client: WebClient,
  streamState: Map<string, ActiveStream>,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  const mrkdwnChunk = formatForPlatform(textChunk, 'slack');
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);

  if (existing) {
    // Append to existing stream — update the message in place
    existing.accumulatedText += mrkdwnChunk;
    return wrapSlackCall(
      () => client.chat.update({
        channel: channelId,
        ts: existing.messageTs,
        text: truncateText(existing.accumulatedText, MAX_MESSAGE_LENGTH),
      }),
      callbacks,
      startTime,
    );
  }

  // Start new stream — post initial message
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: truncateText(mrkdwnChunk, MAX_MESSAGE_LENGTH),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    streamState.set(key, {
      channelId,
      threadTs: threadTs ?? '',
      messageTs: (result as { ts?: string }).ts ?? '',
      accumulatedText: mrkdwnChunk,
    });

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
 * Handle a done StreamEvent — finalize the streaming message.
 *
 * Performs a final chat.update to ensure the message has the complete
 * accumulated text, then removes the channel from streamState.
 *
 * @param channelId - The Slack channel ID
 * @param threadTs - Optional thread_ts for stream key lookup
 * @param client - Slack WebClient instance
 * @param streamState - Per-channel active stream state map
 * @param callbacks - Callbacks to track delivery metrics
 * @param startTime - Timestamp (ms) for delivery duration calculation
 */
async function handleDone(
  channelId: string,
  threadTs: string | undefined,
  client: WebClient,
  streamState: Map<string, ActiveStream>,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);
  streamState.delete(key);

  if (!existing) {
    // No active stream — nothing to finalize
    return { success: true, durationMs: Date.now() - startTime };
  }

  return wrapSlackCall(
    () => client.chat.update({
      channel: channelId,
      ts: existing.messageTs,
      text: truncateText(existing.accumulatedText, MAX_MESSAGE_LENGTH),
    }),
    callbacks,
    startTime,
    true,
  );
}

/**
 * Handle an error StreamEvent — append error text and finalize.
 *
 * If a stream is active, appends the error message to the accumulated text
 * and updates the message. Otherwise, posts a standalone error message.
 *
 * @param channelId - The Slack channel ID
 * @param errorMsg - The error message to display
 * @param threadTs - Optional thread_ts for stream key lookup and standalone posting
 * @param client - Slack WebClient instance
 * @param streamState - Per-channel active stream state map
 * @param callbacks - Callbacks to track delivery metrics
 * @param startTime - Timestamp (ms) for delivery duration calculation
 */
async function handleError(
  channelId: string,
  errorMsg: string,
  threadTs: string | undefined,
  client: WebClient,
  streamState: Map<string, ActiveStream>,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);
  streamState.delete(key);

  if (existing) {
    // Append error to accumulated text and update the message
    const finalText = truncateText(
      `${existing.accumulatedText}\n\n[Error: ${errorMsg}]`,
      MAX_MESSAGE_LENGTH,
    );
    return wrapSlackCall(
      () => client.chat.update({
        channel: channelId,
        ts: existing.messageTs,
        text: finalText,
      }),
      callbacks,
      startTime,
      true,
    );
  }

  // No active stream — post standalone error message
  const text = truncateText(`[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH);
  return wrapSlackCall(
    () => client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
    callbacks,
    startTime,
    true,
  );
}

// === Public API ===

/**
 * Deliver a Relay message to the Slack channel identified by the subject.
 *
 * For StreamEvent payloads:
 * - `text_delta`: Starts a new streaming message (via `chat.postMessage`) on the
 *   first chunk, then updates it (via `chat.update`) on subsequent chunks.
 *   Text is converted from Markdown to mrkdwn using `formatForPlatform()`.
 * - `done`: Finalizes the stream with a final `chat.update`.
 * - `error`: Appends error text and finalizes.
 * - Silent events: Skipped.
 *
 * For standard payloads:
 * - Extracts content, converts to mrkdwn, sends via `chat.postMessage` with `thread_ts`.
 *
 * All bot responses are threaded under the original inbound message using
 * `platformData.ts` as the `thread_ts`.
 *
 * @param opts - Delivery options
 */
export async function deliverMessage(opts: SlackDeliverOptions): Promise<DeliveryResult> {
  const { adapterId, subject, envelope, client, streamState, callbacks } = opts;
  const startTime = Date.now();

  // Echo prevention: skip messages originating from this adapter.
  if (envelope.from.startsWith(SUBJECT_PREFIX)) {
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (!client) {
    return {
      success: false,
      error: `SlackAdapter(${adapterId}): not started`,
      durationMs: Date.now() - startTime,
    };
  }

  const channelId = extractChannelId(subject);
  if (!channelId) {
    return {
      success: false,
      error: `SlackAdapter(${adapterId}): cannot extract channel ID from subject '${subject}'`,
      durationMs: Date.now() - startTime,
    };
  }

  // Resolve thread_ts from the original inbound message's platformData
  const threadTs = resolveThreadTs(envelope);

  // --- StreamEvent-aware delivery ---
  const eventType = detectStreamEventType(envelope.payload);

  if (eventType) {
    // text_delta: start or update streaming message
    const textChunk = extractTextDelta(envelope.payload);
    if (textChunk) {
      return handleTextDelta(channelId, textChunk, threadTs, client, streamState, callbacks, startTime);
    }

    // error: append error text and finalize
    const errorMsg = extractErrorMessage(envelope.payload);
    if (errorMsg) {
      return handleError(channelId, errorMsg, threadTs, client, streamState, callbacks, startTime);
    }

    // done: finalize the stream
    if (eventType === 'done') {
      return handleDone(channelId, threadTs, client, streamState, callbacks, startTime);
    }

    // Silent events: skip without sending anything
    if (SILENT_EVENT_TYPES.has(eventType)) {
      return { success: true, durationMs: Date.now() - startTime };
    }
  }

  // --- Standard payload (non-StreamEvent) ---
  const content = extractPayloadContent(envelope.payload);
  const mrkdwn = formatForPlatform(content, 'slack');
  const text = truncateText(mrkdwn, MAX_MESSAGE_LENGTH);

  return wrapSlackCall(
    () => client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
    callbacks,
    startTime,
    true,
  );
}
