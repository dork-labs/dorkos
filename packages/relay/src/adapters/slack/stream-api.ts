/**
 * Typed wrappers for Slack's unofficial native streaming API.
 *
 * Slack's `@slack/web-api` does not include type definitions for the
 * `chat.startStream`, `chat.appendStream`, and `chat.stopStream` methods.
 * This module isolates the `as unknown` casts into a single location so
 * callers can use clean, typed functions without inline casts.
 *
 * @module relay/adapters/slack/stream-api
 */
import type { WebClient } from '@slack/web-api';

/** Shape of Slack's unofficial native streaming chat methods. */
interface SlackStreamApi {
  chat: {
    startStream: (args: { channel: string; thread_ts?: string }) => Promise<{ stream_id?: string }>;
    appendStream: (args: { stream_id: string; text: string }) => Promise<unknown>;
    stopStream: (args: { stream_id: string }) => Promise<unknown>;
  };
}

/**
 * Cast a WebClient to the unofficial streaming API surface.
 *
 * @internal Exported for testing only.
 */
function asStreamClient(client: WebClient): SlackStreamApi {
  return client as unknown as SlackStreamApi;
}

/**
 * Start a new native streaming message in a Slack channel.
 *
 * @param client - The Slack WebClient instance
 * @param channel - The Slack channel ID to stream to
 * @param threadTs - Optional thread timestamp to reply under
 * @returns The stream_id for subsequent append/stop calls (empty string if missing)
 */
export async function startStream(
  client: WebClient,
  channel: string,
  threadTs?: string,
): Promise<string> {
  const result = await asStreamClient(client).chat.startStream({ channel, thread_ts: threadTs });
  return result.stream_id ?? '';
}

/**
 * Append text to an active native streaming message.
 *
 * @param client - The Slack WebClient instance
 * @param streamId - The stream_id returned by {@link startStream}
 * @param text - The formatted text to append
 */
export async function appendStream(
  client: WebClient,
  streamId: string,
  text: string,
): Promise<void> {
  await asStreamClient(client).chat.appendStream({ stream_id: streamId, text });
}

/**
 * Finalize a native streaming message.
 *
 * @param client - The Slack WebClient instance
 * @param streamId - The stream_id returned by {@link startStream}
 */
export async function stopStream(client: WebClient, streamId: string): Promise<void> {
  await asStreamClient(client).chat.stopStream({ stream_id: streamId });
}
