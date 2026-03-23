/**
 * Slack outbound message delivery.
 *
 * Entry point for delivering Relay envelopes to Slack channels.
 * Routes StreamEvent payloads to the streaming sub-module (stream.ts)
 * or the approval sub-module (approval.ts), and handles standard
 * (non-streaming) payloads directly.
 *
 * @module relay/adapters/slack/outbound
 */
import type { WebClient } from '@slack/web-api';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  extractApprovalData,
  formatForPlatform,
  splitMessage,
  SLACK_MAX_LENGTH,
} from '../../lib/payload-utils.js';
import { extractChannelId, isGroupChannel } from './inbound.js';
import type { SlackThreadIdCodec } from '../../lib/thread-id.js';
import type { ThreadParticipationTracker } from './thread-tracker.js';
import {
  handleTextDelta,
  handleDone,
  handleError,
  flushStreamBuffer,
  wrapSlackCall,
  removePendingReaction,
  STREAM_TTL_MS,
} from './stream.js';
import type { StreamContext } from './stream.js';
import { handleApprovalRequired } from './approval.js';
import type { SlackOutboundState } from './approval.js';

// Re-export types so existing imports from outbound.ts continue to work
export type { ActiveStream, PendingReactions } from './stream.js';
// Re-export approval state types and helpers so the adapter facade can use them
export {
  clearApprovalTimeout,
  createSlackOutboundState,
  clearAllApprovalTimeouts,
} from './approval.js';
export type { SlackOutboundState } from './approval.js';

// === Types ===

/** Options for delivering a Relay message to Slack. */
export interface SlackDeliverOptions {
  adapterId: string;
  subject: string;
  envelope: RelayEnvelope;
  client: WebClient | null;
  streamState: Map<string, import('./stream.js').ActiveStream>;
  pendingReactions: import('./stream.js').PendingReactions;
  botUserId: string;
  callbacks: AdapterOutboundCallbacks;
  streaming: boolean;
  nativeStreaming: boolean;
  typingIndicator: 'none' | 'reaction';
  approvalState: SlackOutboundState;
  /** Instance-scoped codec for subject encoding/decoding. */
  codec: SlackThreadIdCodec;
  /** Thread participation tracker for marking threads the bot has replied to. */
  threadTracker?: ThreadParticipationTracker;
  logger?: RelayLogger;
}

// === Internal helpers ===

/**
 * Resolve the thread_ts from a relay envelope for threading replies.
 *
 * Looks for platformData.threadTs (already in a thread) or platformData.ts
 * (the original message — start a new thread).
 *
 * @param envelope - The relay envelope to inspect
 */
function resolveThreadTs(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  const pd = obj.platformData as Record<string, unknown> | undefined;
  if (!pd) return undefined;
  if (typeof pd.threadTs === 'string' && pd.threadTs) return pd.threadTs;
  if (typeof pd.ts === 'string' && pd.ts) return pd.ts;
  return undefined;
}

// === Public API ===

/**
 * Deliver a Relay message to the Slack channel identified by the subject.
 *
 * For StreamEvent payloads:
 * - `text_delta`: Starts or updates a streaming message.
 * - `done`: Finalizes the stream.
 * - `error`: Appends error text and finalizes.
 * - `approval_required`: Flushes buffered text then renders a Block Kit card.
 * - Silent events: Skipped (whitelist model).
 *
 * For standard payloads, extracts content and sends via `chat.postMessage`.
 *
 * @param opts - Delivery options
 */
export async function deliverMessage(opts: SlackDeliverOptions): Promise<DeliveryResult> {
  const {
    adapterId,
    subject,
    envelope,
    client,
    streamState,
    pendingReactions,
    callbacks,
    logger = noopLogger,
  } = opts;
  const startTime = Date.now();

  // Reap orphaned streams that never received a done/error event
  for (const [key, stream] of streamState) {
    if (startTime - stream.startedAt > STREAM_TTL_MS) {
      streamState.delete(key);
      // Clean up the pending hourglass reaction that would otherwise linger forever
      if (client) {
        removePendingReaction(
          client,
          stream.channelId,
          opts.typingIndicator,
          pendingReactions,
          logger
        );
      }
      logger.warn(
        `stream: reaped orphaned stream for ${key} (age: ${Math.round((startTime - stream.startedAt) / 1000)}s)`
      );
    }
  }

  // Echo prevention: skip messages originating from this adapter
  if (envelope.from.startsWith(opts.codec.prefix)) {
    logger.debug('deliver: echo prevention — skipping self-originated message');
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (!client) {
    return {
      success: false,
      error: `SlackAdapter(${adapterId}): not started`,
      durationMs: Date.now() - startTime,
    };
  }

  const channelId = extractChannelId(opts.codec, subject);
  if (!channelId) {
    return {
      success: false,
      error: `SlackAdapter(${adapterId}): cannot extract channel ID from subject '${subject}'`,
      durationMs: Date.now() - startTime,
    };
  }

  const threadTs = resolveThreadTs(envelope);

  // Safety warning: channel messages without threadTs may post to the main channel
  if (isGroupChannel(channelId) && !threadTs) {
    logger.warn(`outbound: no threadTs for channel message in ${channelId}`);
  }

  // For stream key differentiation, use a value consistent across all events
  // in a single agent response stream. Priority:
  // 1. threadTs — real Slack timestamp (always present for messages from Slack users)
  // 2. correlationId — shared across events from the same request
  // 3. envelope.from — agent session ID, consistent across all stream events
  const payloadObj =
    envelope.payload && typeof envelope.payload === 'object'
      ? (envelope.payload as Record<string, unknown>)
      : undefined;
  const streamKeyTs =
    threadTs ?? (payloadObj?.correlationId as string | undefined) ?? envelope.from;

  const ctx: StreamContext = {
    channelId,
    threadTs,
    client,
    streamState,
    callbacks,
    startTime,
    typingIndicator: opts.typingIndicator,
    streamKeyTs,
    pendingReactions,
    threadTracker: opts.threadTracker,
    logger,
  };

  // --- StreamEvent-aware delivery ---
  const eventType = detectStreamEventType(envelope.payload);

  if (eventType) {
    const textChunk = extractTextDelta(envelope.payload);
    if (textChunk) {
      logger.debug(
        `deliver: text_delta to ${channelId} (${textChunk.length} chars, streaming=${opts.streaming ? (opts.nativeStreaming ? 'native' : 'legacy') : 'buffered'})`
      );
      return handleTextDelta(textChunk, opts.streaming, opts.nativeStreaming, ctx);
    }

    const errorMsg = extractErrorMessage(envelope.payload);
    if (errorMsg) {
      logger.debug(`deliver: error to ${channelId}: "${errorMsg.slice(0, 100)}"`);
      return handleError(errorMsg, ctx);
    }

    if (eventType === 'done') {
      logger.debug(`deliver: done for ${channelId}`);
      return handleDone(ctx);
    }

    if (eventType === 'approval_required') {
      const approvalData = extractApprovalData(envelope.payload);
      if (approvalData) {
        logger.debug(
          `deliver: approval_required for tool '${approvalData.toolName}' to ${channelId}`
        );
        // Flush accumulated text before posting the approval card so partial
        // responses aren't lost when the stream pauses for approval.
        await flushStreamBuffer(ctx);
        return handleApprovalRequired(
          channelId,
          threadTs,
          approvalData,
          envelope,
          client,
          callbacks,
          startTime,
          opts.approvalState,
          opts.threadTracker
        );
      }
    }

    // All other StreamEvent types: silently drop (whitelist model)
    logger.debug(`deliver: dropping stream event '${eventType}' (whitelist)`);
    return { success: true, durationMs: Date.now() - startTime };
  }

  // --- Standard payload (non-StreamEvent) ---
  const formatted = formatForPlatform(extractPayloadContent(envelope.payload), 'slack');
  const chunks = splitMessage(formatted, SLACK_MAX_LENGTH);
  logger.debug(
    `deliver: standard payload to ${channelId} (${formatted.length} chars, ${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`
  );

  let lastResult: DeliveryResult = { success: true, durationMs: 0 };
  for (let i = 0; i < chunks.length; i++) {
    lastResult = await wrapSlackCall(
      () =>
        client.chat.postMessage({
          channel: channelId,
          text: chunks[i],
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      callbacks,
      startTime,
      i === chunks.length - 1
    );
    if (!lastResult.success) return lastResult;

    // Mark thread participation after the first successful post
    if (i === 0 && opts.threadTracker && threadTs) {
      opts.threadTracker.markParticipating(channelId, threadTs);
    }

    // Rate-limit between chunks to avoid Slack API throttling
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
  }
  return lastResult;
}
