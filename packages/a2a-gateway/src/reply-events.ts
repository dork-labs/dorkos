/**
 * Parsing for reply-subject payloads published by Relay agent adapters.
 *
 * The Claude Code adapter streams one envelope per runtime StreamEvent to
 * `envelope.replyTo` — shape `{ type, data, correlationId? }`, see
 * `packages/relay/src/adapters/claude-code/publish.ts` — terminated by a
 * `done` event. Inbox-style flows aggregate into a single
 * `{ type: 'agent_result', text, done: true }` payload instead. This module
 * validates both shapes with Zod and normalizes them into a small
 * discriminated union the executor folds into A2A task state.
 *
 * @module a2a-gateway/reply-events
 */
import { z } from 'zod';
import { TextDeltaSchema, ErrorEventSchema } from '@dorkos/shared/schemas';
import { RelayAgentResultPayloadSchema } from '@dorkos/shared/relay-schemas';

/** A `text_delta` StreamEvent as published to the reply subject. */
const TextDeltaReplySchema = z.object({
  type: z.literal('text_delta'),
  data: TextDeltaSchema,
});

/** An `error` StreamEvent as published to the reply subject. */
const StreamErrorReplySchema = z.object({
  type: z.literal('error'),
  data: ErrorEventSchema,
});

/**
 * The terminal `done` StreamEvent. The adapter always publishes one — either
 * streamed through from the runtime or synthesized in its `finally` block —
 * so its `data` payload is deliberately not validated here.
 */
const DoneReplySchema = z.object({
  type: z.literal('done'),
});

/** Normalized reply event the executor folds into task state. */
export type ReplyEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'stream_error'; message: string }
  | { kind: 'agent_result'; text: string }
  | { kind: 'done' }
  | { kind: 'ignored' };

/**
 * Parse a reply-subject envelope payload into a normalized {@link ReplyEvent}.
 *
 * Unknown or malformed payloads normalize to `{ kind: 'ignored' }` — tool
 * lifecycle events, session status, and other stream chatter carry no
 * response text and must not affect task state.
 *
 * @param payload - The raw `envelope.payload` received on the reply subject
 */
export function parseReplyEvent(payload: unknown): ReplyEvent {
  const textDelta = TextDeltaReplySchema.safeParse(payload);
  if (textDelta.success) {
    return { kind: 'text_delta', text: textDelta.data.data.text };
  }

  const agentResult = RelayAgentResultPayloadSchema.safeParse(payload);
  if (agentResult.success) {
    return { kind: 'agent_result', text: agentResult.data.text };
  }

  const streamError = StreamErrorReplySchema.safeParse(payload);
  if (streamError.success) {
    return { kind: 'stream_error', message: streamError.data.data.message };
  }

  if (DoneReplySchema.safeParse(payload).success) {
    return { kind: 'done' };
  }

  return { kind: 'ignored' };
}
