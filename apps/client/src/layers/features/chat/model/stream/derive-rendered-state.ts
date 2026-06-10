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
    stream.inProgressTurn.length > 0
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
  return projectSessionMessages(stream.messages, stream.inProgressTurn, stream.pendingInteractions);
}

/**
 * Map the server-projected lifecycle onto the renderer's coarse {@link ChatStatus},
 * falling back to the legacy status when the stream store has not hydrated.
 *
 * `streaming` → `streaming`; `error` → `error`; `idle`/`blocked`/`interrupted`
 * collapse to `idle` (the renderer expresses blocked/interrupted via pending
 * interactions and the interrupted-turn chip, not the coarse status).
 *
 * @param stream - The per-session durable-stream projection.
 * @param legacyStatus - The legacy send-path status (transitional fallback).
 */
export function selectRenderedStatus(
  stream: SessionStreamState,
  legacyStatus: ChatStatus
): ChatStatus {
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
