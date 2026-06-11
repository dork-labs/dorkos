/**
 * Bridge selectors that pick the authoritative render source for a chat session
 * during the Phase-3 transition (spec chat-stream-reconnection).
 *
 * The durable `/events` stream (new {@link SessionStreamState}) is the canonical
 * source for the rendered message list, the chat status, and the recoverable
 * pending interactions. The legacy send-path store still feeds these during a
 * turn it triggers (until task #13 rewrites the POST-202 path), so these helpers
 * fall back to the legacy values whenever the stream store has not yet hydrated
 * the session. Task #10 removes the legacy fallback once the send path no longer
 * writes render state.
 *
 * @module features/chat/model/stream/derive-rendered-state
 */
import type { SessionStreamState } from '@/layers/entities/session';
import type { ChatMessage, ChatStatus } from '../chat-types';
import { projectSessionMessages } from './project-session-turn';

/** Whether the stream store holds hydrated server state for this session. */
export function hasStreamState(stream: SessionStreamState): boolean {
  return (
    stream.streamReadyCursor !== null ||
    stream.messages.length > 0 ||
    stream.inProgressTurn.length > 0 ||
    // A brand-new session whose only content (so far) is the optimistic user
    // message must render from the stream store, not the empty legacy fallback —
    // otherwise the user's own just-sent message would not appear until the
    // first /events frame or the turn_end history reload arrives.
    stream.optimisticUserMessage !== null
  );
}

/**
 * Pick the rendered message list: the projected stream-store messages once the
 * session has hydrated, else the legacy send-path messages.
 *
 * @param stream - The per-session durable-stream projection.
 * @param legacyMessages - The legacy send-path message list (transitional fallback).
 */
export function selectRenderedMessages(
  stream: SessionStreamState,
  legacyMessages: ChatMessage[]
): ChatMessage[] {
  if (!hasStreamState(stream)) return legacyMessages;
  return projectSessionMessages(
    stream.messages,
    stream.inProgressTurn,
    stream.pendingInteractions,
    stream.optimisticUserMessage
  );
}

/**
 * Map the server-projected lifecycle onto the renderer's coarse {@link ChatStatus},
 * falling back to the legacy status when the stream store has not hydrated.
 *
 * `streaming` → `streaming`; `error` → `error`; `idle`/`blocked`/`interrupted`
 * collapse to `idle` (the renderer expresses blocked/interrupted via pending
 * interactions and the interrupted-turn chip, not the coarse status).
 *
 * A pending trigger reads as `streaming` (CLI-B7): the POST is a 202 trigger,
 * so between Enter and the server's `turn_start` the lifecycle still says
 * `idle` — without this the composer would accept a second Enter as a
 * duplicate send instead of queueing it.
 *
 * @param stream - The per-session durable-stream projection.
 * @param legacyStatus - The legacy send-path status (transitional fallback).
 */
export function selectRenderedStatus(
  stream: SessionStreamState,
  legacyStatus: ChatStatus
): ChatStatus {
  if (stream.triggerPending) return 'streaming';
  const lifecycle = stream.status?.lifecycle;
  if (lifecycle === undefined) return legacyStatus;
  switch (lifecycle) {
    case 'streaming':
      return 'streaming';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}
