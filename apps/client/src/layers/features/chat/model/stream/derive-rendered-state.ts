/**
 * Bridge selectors that pick the authoritative render source for a chat session
 * (spec chat-stream-reconnection).
 *
 * The durable `/events` stream ({@link SessionStreamState}) is the canonical
 * source for the rendered message list and the recoverable pending interactions.
 * Until the session hydrates (the cold snapshot has not landed yet), these
 * helpers fall back to the legacy chat-store values so the first paint after a
 * switch is instant rather than blank.
 *
 * The matching status selector lives at the entity level
 * (`selectRenderedStatus`) because the Session readout needs the same answer.
 *
 * @module features/chat/model/stream/derive-rendered-state
 */
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { SessionStreamState } from '@/layers/entities/session';
import type { ChatMessage } from '../chat-types';
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
 * The auto-first-turn kickoff (M4) is filtered here as the client-side BACKSTOP
 * to the server's wire-boundary seam (`GET /:id/messages` + the `/events`
 * snapshot) — it covers paths that bypass HTTP routes (the in-process Direct
 * transport). Same shared filter, same narrow scope: user role only, first user
 * record only, exact fence envelope only (`@dorkos/shared/kickoff`).
 *
 * The answer is shared and reused while its inputs are unchanged: treat it as
 * read-only.
 *
 * @param stream - The per-session durable-stream projection.
 * @param legacyMessages - The legacy send-path message list (transitional fallback).
 */
export function selectRenderedMessages(
  stream: SessionStreamState,
  legacyMessages: ChatMessage[]
): ChatMessage[] {
  const hydrated = hasStreamState(stream);
  // Keyed by the array the answer is built from, so each session keeps its own
  // last answer and a dropped history takes its entry with it.
  const key = hydrated ? stream.messages : legacyMessages;
  const last = lastProjection.get(key);
  if (
    last &&
    last.hydrated === hydrated &&
    last.inProgressTurn === stream.inProgressTurn &&
    last.pendingInteractions === stream.pendingInteractions &&
    last.optimisticUserMessage === stream.optimisticUserMessage &&
    last.legacyMessages === legacyMessages
  ) {
    return last.result;
  }
  const projected = hydrated
    ? projectSessionMessages(
        stream.messages,
        stream.inProgressTurn,
        stream.pendingInteractions,
        stream.optimisticUserMessage
      )
    : legacyMessages;
  const result = filterKickoffHistory(projected);
  lastProjection.set(key, {
    hydrated,
    inProgressTurn: stream.inProgressTurn,
    pendingInteractions: stream.pendingInteractions,
    optimisticUserMessage: stream.optimisticUserMessage,
    legacyMessages,
    result,
  });
  return result;
}

/** The inputs one answer of {@link selectRenderedMessages} was built from. */
interface Projection {
  hydrated: boolean;
  inProgressTurn: SessionStreamState['inProgressTurn'];
  pendingInteractions: SessionStreamState['pendingInteractions'];
  optimisticUserMessage: SessionStreamState['optimisticUserMessage'];
  legacyMessages: ChatMessage[];
  result: ChatMessage[];
}

/**
 * The last answer per source array (DOR-2895). The chat panel and the
 * composer both ask for the same list on every event, and most events (status,
 * usage, presence) change none of its inputs: both now get the same array back
 * instead of each rebuilding a long chat, which also keeps every memo keyed on
 * it from running again.
 */
const lastProjection = new WeakMap<object, Projection>();
