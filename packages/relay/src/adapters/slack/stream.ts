/**
 * Slack streaming delivery handlers.
 *
 * Manages real-time token-by-token streaming via Slack's chat.update
 * (legacy) and chat.startStream/appendStream/stopStream (native) APIs.
 * Handles text_delta, done, and error StreamEvents, along with the
 * stream buffer flush used before approval card interrupts.
 *
 * Also owns the typing indicator helpers (add/remove reaction) since
 * they are exclusively used in streaming lifecycle events.
 *
 * @module relay/adapters/slack/stream
 */
import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import type { AdapterOutboundCallbacks, DeliveryResult } from '../../types.js';
import { formatForPlatform, truncateText } from '../../lib/payload-utils.js';
import { MAX_MESSAGE_LENGTH } from './inbound.js';
import {
  startStream as nativeStartStream,
  appendStream as nativeAppendStream,
  stopStream as nativeStopStream,
} from './stream-api.js';

/** Minimum interval (ms) between chat.update calls for a single stream. */
const STREAM_UPDATE_INTERVAL_MS = 1_000;
/** Maximum age (ms) before an orphaned stream entry is reaped. */
export const STREAM_TTL_MS = 5 * 60 * 1_000;

/**
 * FIFO queue of message timestamps with pending :hourglass_flowing_sand: reactions.
 *
 * Keyed by channelId. Values are arrays of message `ts` values in arrival order.
 * The inbound handler pushes on message receipt; the outbound handler shifts on
 * done/error to remove the reaction from the correct message.
 */
export type PendingReactions = Map<string, string[]>;

/** Active stream state for a channel (keyed by channelId:streamKeyTs). */
export interface ActiveStream {
  /** The channel ID being streamed to. */
  channelId: string;
  /** The thread_ts to reply under. */
  threadTs: string;
  /** The message ts returned by chat.postMessage (updated by streaming). */
  messageTs: string;
  /** Accumulated raw Markdown text content for the stream. */
  accumulatedText: string;
  /** Timestamp (ms) of the last chat.update call — used for throttling. */
  lastUpdateAt: number;
  /** Timestamp (ms) when the stream was created — used for TTL reaping. */
  startedAt: number;
  /** Unique ID for this stream. */
  streamId: string;
  /** Slack native streaming API stream_id (only set when nativeStreaming is true). */
  nativeStreamId?: string;
}

/** Shared context passed to all stream event handlers. */
export interface StreamContext {
  channelId: string;
  threadTs: string | undefined;
  client: WebClient;
  streamState: Map<string, ActiveStream>;
  callbacks: AdapterOutboundCallbacks;
  startTime: number;
  typingIndicator: 'none' | 'reaction';
  streamKeyTs: string;
  pendingReactions: PendingReactions;
  logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

/**
 * Execute a Slack API call and return a DeliveryResult.
 *
 * @param fn - The async Slack API operation to execute
 * @param callbacks - Callbacks for error recording and tracking
 * @param startTime - Timestamp (ms) for duration calculation
 * @param trackDelivery - Whether to call trackOutbound on success
 */
export async function wrapSlackCall(
  fn: () => Promise<unknown>,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
  trackDelivery = false
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

/**
 * Build a composite key for stream state.
 *
 * Different agents or threads in the same channel get independent stream state.
 *
 * @param channelId - The Slack channel ID
 * @param streamKeyTs - Correlation key (threadTs, correlationId, or envelope.from)
 */
export function buildStreamKey(channelId: string, streamKeyTs?: string): string {
  return streamKeyTs ? `${channelId}:${streamKeyTs}` : channelId;
}

/** Add :hourglass_flowing_sand: reaction — fire-and-forget with logged failures. */
export function addTypingReaction(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  typingIndicator: 'none' | 'reaction',
  logger?: { warn: (...args: unknown[]) => void }
): void {
  if (typingIndicator !== 'reaction' || !threadTs) return;
  void client.reactions
    .add({ channel: channelId, name: 'hourglass_flowing_sand', timestamp: threadTs })
    .catch((err) => {
      // already_reacted is expected when inbound already added the reaction
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already_reacted')) {
        logger?.warn(`stream: failed to add typing reaction to ${channelId}:${threadTs}: ${msg}`);
      }
    });
}

/** Remove :hourglass_flowing_sand: reaction — fire-and-forget with logged failures. */
export function removeTypingReaction(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  typingIndicator: 'none' | 'reaction',
  logger?: { warn: (...args: unknown[]) => void }
): void {
  if (typingIndicator !== 'reaction' || !threadTs) return;
  void client.reactions
    .remove({ channel: channelId, name: 'hourglass_flowing_sand', timestamp: threadTs })
    .catch((err) => {
      // no_reaction is expected if the reaction was already removed or never added
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no_reaction')) {
        logger?.warn(
          `stream: failed to remove typing reaction from ${channelId}:${threadTs}: ${msg}`
        );
      }
    });
}

/**
 * Remove the oldest pending reaction for a channel (FIFO).
 *
 * Called by handleDone/handleError to clean up the hourglass reaction
 * that was added on the inbound side. Uses the FIFO queue to correlate
 * with the correct user message even when multiple messages are queued.
 */
export function removePendingReaction(
  client: WebClient,
  channelId: string,
  typingIndicator: 'none' | 'reaction',
  pendingReactions: PendingReactions,
  logger?: { debug?: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
): void {
  if (typingIndicator !== 'reaction') return;
  const queue = pendingReactions.get(channelId);
  if (!queue || queue.length === 0) return;
  const messageTs = queue.shift()!;
  if (queue.length === 0) pendingReactions.delete(channelId);

  void client.reactions
    .remove({ channel: channelId, name: 'hourglass_flowing_sand', timestamp: messageTs })
    .then(() => {
      logger?.debug?.(`stream: removed pending typing reaction from ${channelId}:${messageTs}`);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no_reaction')) {
        logger?.warn(
          `stream: failed to remove pending typing reaction from ${channelId}:${messageTs}: ${msg}`
        );
      }
    });
}

/**
 * Handle a text_delta StreamEvent — start or append to a streaming message.
 *
 * First delta: opens a new stream (native via `chat.startStream` or legacy via
 * `chat.postMessage`). Subsequent deltas: append/update with throttling.
 * Buffered mode: accumulates text without posting until `done`.
 *
 * @param textChunk - The raw text chunk to append
 * @param streaming - True to post/update in real time; false to buffer
 * @param nativeStreaming - True to use Slack's native streaming API
 * @param ctx - Shared stream handler context
 */
export async function handleTextDelta(
  textChunk: string,
  streaming: boolean,
  nativeStreaming: boolean,
  ctx: StreamContext
): Promise<DeliveryResult> {
  const {
    channelId,
    threadTs,
    client,
    streamState,
    callbacks,
    startTime,
    typingIndicator,
    streamKeyTs,
    logger,
  } = ctx;
  const key = buildStreamKey(channelId, streamKeyTs);
  const existing = streamState.get(key);

  // Buffered mode: accumulate without posting
  if (!streaming) {
    if (existing) {
      existing.accumulatedText += textChunk;
    } else {
      streamState.set(key, {
        channelId,
        threadTs: threadTs ?? '',
        messageTs: '',
        accumulatedText: textChunk,
        lastUpdateAt: 0,
        startedAt: Date.now(),
        streamId: randomUUID(),
      });
      addTypingReaction(client, channelId, threadTs, typingIndicator, logger);
    }
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (existing) {
    existing.accumulatedText += textChunk;

    // Native streaming: append each chunk directly — no throttling needed
    if (existing.nativeStreamId) {
      return wrapSlackCall(
        () =>
          nativeAppendStream(
            client,
            existing.nativeStreamId!,
            formatForPlatform(textChunk, 'slack')
          ),
        callbacks,
        startTime
      );
    }

    // Throttle: skip chat.update if within the update interval.
    // The done handler always sends a final update, so no text is lost.
    const now = Date.now();
    if (now - existing.lastUpdateAt < STREAM_UPDATE_INTERVAL_MS) {
      return { success: true, durationMs: now - startTime };
    }
    existing.lastUpdateAt = now;

    // Collapse consecutive newlines on intermediate updates to work around
    // slackify-markdown inserting \n\n paragraph separation (Issue #40).
    const formatted = formatForPlatform(existing.accumulatedText, 'slack');
    return wrapSlackCall(
      () =>
        client.chat.update({
          channel: channelId,
          ts: existing.messageTs,
          text: truncateText(formatted.replace(/\n{2,}/g, '\n'), MAX_MESSAGE_LENGTH),
        }),
      callbacks,
      startTime
    );
  }

  // Start new stream via native API when enabled and a thread is available
  if (nativeStreaming && threadTs) {
    try {
      const nativeStreamId = await nativeStartStream(client, channelId, threadTs);
      const now = Date.now();
      streamState.set(key, {
        channelId,
        threadTs,
        messageTs: '',
        accumulatedText: textChunk,
        lastUpdateAt: now,
        startedAt: now,
        streamId: randomUUID(),
        nativeStreamId,
      });
      await nativeAppendStream(client, nativeStreamId, formatForPlatform(textChunk, 'slack'));
      addTypingReaction(client, channelId, threadTs, typingIndicator, logger);
      return { success: true, durationMs: Date.now() - startTime };
    } catch (err) {
      // Fallback to chat.postMessage (e.g., missing scope, API not available)
      callbacks.recordError(err);
    }
  }

  // Start new stream — post initial message (legacy approach)
  try {
    const now = Date.now();
    const result = await client.chat.postMessage({
      channel: channelId,
      text: truncateText(formatForPlatform(textChunk, 'slack'), MAX_MESSAGE_LENGTH),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    streamState.set(key, {
      channelId,
      threadTs: threadTs ?? '',
      messageTs: (result as { ts?: string }).ts ?? '',
      accumulatedText: textChunk,
      lastUpdateAt: now,
      startedAt: now,
      streamId: randomUUID(),
    });
    addTypingReaction(client, channelId, threadTs, typingIndicator, logger);
    return { success: true, durationMs: now - startTime };
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
 * Flush accumulated stream buffer to Slack without finalizing the stream.
 *
 * Used before posting interrupting events (e.g. approval cards) so
 * buffered text isn't lost. Does NOT delete the stream state.
 *
 * @param ctx - Shared stream handler context
 */
export async function flushStreamBuffer(ctx: StreamContext): Promise<void> {
  const { channelId, threadTs, client, streamState, callbacks, streamKeyTs } = ctx;
  const key = buildStreamKey(channelId, streamKeyTs);
  const existing = streamState.get(key);
  if (!existing || !existing.accumulatedText) return;

  // Native streaming: stop stream so text is finalized.
  // A new stream will start when text_delta events resume after approval.
  if (existing.nativeStreamId) {
    try {
      await nativeStopStream(client, existing.nativeStreamId);
    } catch {
      /* best-effort */
    }
    existing.nativeStreamId = undefined;
    return;
  }

  // Buffered mode (no messageTs): post accumulated text as a new message
  if (!existing.messageTs) {
    try {
      const result = await client.chat.postMessage({
        channel: channelId,
        text: truncateText(
          formatForPlatform(existing.accumulatedText, 'slack'),
          MAX_MESSAGE_LENGTH
        ),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      existing.messageTs = (result as { ts?: string }).ts ?? '';
      existing.lastUpdateAt = Date.now();
    } catch (err) {
      callbacks.recordError(err);
    }
    return;
  }

  // Streaming mode (has messageTs): update the existing message
  try {
    await client.chat.update({
      channel: channelId,
      ts: existing.messageTs,
      text: truncateText(formatForPlatform(existing.accumulatedText, 'slack'), MAX_MESSAGE_LENGTH),
    });
    existing.lastUpdateAt = Date.now();
  } catch (err) {
    callbacks.recordError(err);
  }
}

/**
 * Handle a done StreamEvent — finalize the streaming message.
 *
 * Performs a final update/post with the complete accumulated text,
 * removes the channel from streamState, and clears the typing indicator.
 *
 * @param ctx - Shared stream handler context
 */
export async function handleDone(ctx: StreamContext): Promise<DeliveryResult> {
  const {
    channelId,
    threadTs,
    client,
    streamState,
    callbacks,
    startTime,
    typingIndicator,
    streamKeyTs,
    pendingReactions,
    logger,
  } = ctx;
  const key = buildStreamKey(channelId, streamKeyTs);
  const existing = streamState.get(key);
  streamState.delete(key);

  // Remove the inbound-side hourglass reaction (FIFO queue)
  removePendingReaction(client, channelId, typingIndicator, pendingReactions, logger);

  // Also attempt outbound-side removal as fallback (for threaded messages where threadTs is known)
  if (existing?.threadTs) {
    removeTypingReaction(client, channelId, existing.threadTs, typingIndicator, logger);
  }

  if (!existing) {
    // Stream completed with zero text_delta events — the user's message produced no visible response.
    logger?.warn(
      `stream: done received for ${channelId} with no active stream (empty response — user may see no output)`
    );
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (existing.nativeStreamId) {
    return wrapSlackCall(
      () => nativeStopStream(client, existing.nativeStreamId!),
      callbacks,
      startTime,
      true
    );
  }

  if (!existing.messageTs) {
    return wrapSlackCall(
      () =>
        client.chat.postMessage({
          channel: channelId,
          text: truncateText(
            formatForPlatform(existing.accumulatedText, 'slack'),
            MAX_MESSAGE_LENGTH
          ),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      callbacks,
      startTime,
      true
    );
  }

  return wrapSlackCall(
    () =>
      client.chat.update({
        channel: channelId,
        ts: existing.messageTs,
        text: truncateText(
          formatForPlatform(existing.accumulatedText, 'slack'),
          MAX_MESSAGE_LENGTH
        ),
      }),
    callbacks,
    startTime,
    true
  );
}

/**
 * Handle an error StreamEvent — append error text and finalize.
 *
 * Appends the error to accumulated text and updates/posts, or posts a
 * standalone error message if no stream is active.
 *
 * @param errorMsg - The error message to display
 * @param ctx - Shared stream handler context
 */
export async function handleError(errorMsg: string, ctx: StreamContext): Promise<DeliveryResult> {
  const {
    channelId,
    threadTs,
    client,
    streamState,
    callbacks,
    startTime,
    typingIndicator,
    streamKeyTs,
    pendingReactions,
    logger,
  } = ctx;
  const key = buildStreamKey(channelId, streamKeyTs);
  const existing = streamState.get(key);
  streamState.delete(key);

  // Remove the inbound-side hourglass reaction (FIFO queue)
  removePendingReaction(client, channelId, typingIndicator, pendingReactions, logger);

  // Also attempt outbound-side removal as fallback
  if (existing?.threadTs) {
    removeTypingReaction(client, channelId, existing.threadTs, typingIndicator, logger);
  }

  if (existing) {
    if (existing.nativeStreamId) {
      try {
        await nativeAppendStream(
          client,
          existing.nativeStreamId,
          formatForPlatform(`\n\n[Error: ${errorMsg}]`, 'slack')
        );
      } catch {
        /* best-effort append */
      }
      return wrapSlackCall(
        () => nativeStopStream(client, existing.nativeStreamId!),
        callbacks,
        startTime,
        true
      );
    }

    const finalText = truncateText(
      `${formatForPlatform(existing.accumulatedText, 'slack')}\n\n[Error: ${errorMsg}]`,
      MAX_MESSAGE_LENGTH
    );

    if (!existing.messageTs) {
      return wrapSlackCall(
        () =>
          client.chat.postMessage({
            channel: channelId,
            text: finalText,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          }),
        callbacks,
        startTime,
        true
      );
    }

    return wrapSlackCall(
      () => client.chat.update({ channel: channelId, ts: existing.messageTs, text: finalText }),
      callbacks,
      startTime,
      true
    );
  }

  return wrapSlackCall(
    () =>
      client.chat.postMessage({
        channel: channelId,
        text: truncateText(`[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    callbacks,
    startTime,
    true
  );
}
