/**
 * Landing a conversation on the one message a search hit named (DOR-1579).
 *
 * @module widgets/session/model/use-message-landing
 */
import { useCallback, useEffect, useRef } from 'react';
import { messageRowKey, transcriptIdForChatMessage } from '@/layers/features/chat';
import { useHistoryWindowStore, useSessionStreamStore } from '@/layers/entities/session';

/**
 * Take a conversation to the message `?message=` names, once.
 *
 * **The conversation's half of DOR-687's room landing, and deliberately the
 * smaller half.** A room hit names a `seq`, which the room has to resolve to a
 * row — a reply lives inside a thread rather than in the flow, so the room's
 * `useEntryLanding` translates and opens a panel. A conversation has one
 * timeline and one row per message, so there is nothing to translate: the id is
 * the message's own, and the row it is drawn under is {@link messageRowKey} of
 * it. Asking that helper rather than writing the prefix here is what keeps the
 * two ends spelling the same string — a row id nothing matches opens the
 * conversation at the bottom, which looks exactly like a link that never worked.
 *
 * **The result is a GETTER handed to the timeline's landing rather than an
 * effect fired at it.** A conversation opens at its unread rule or its newest
 * message through a one-shot layout effect (`useTimelineLanding`); an effect of
 * this hook's own would run after that on a cold load and before it on a warm
 * one, so a link would land correctly or at the bottom depending on what
 * happened to be cached. Answering a question the landing asks removes the race
 * instead of usually winning it.
 *
 * **Reading it CONSUMES the request**, keyed on the conversation AND the id, so:
 *
 * - A NEW `?message=` in the conversation already on screen re-arms the landing,
 *   which is the whole of "search for something in the conversation you are
 *   already reading". The timeline's own arm guard is per conversation and an
 *   in-place search-param navigation never trips it.
 * - An ANSWERED one stops answering, so it cannot outrank the remembered
 *   position on a remount.
 *
 * **A message older than the opening window is read in first.** A long
 * conversation opens on its newest messages only (DOR-2889), so the request is
 * also handed to the history window as a SEEK: the transcript reads older pages
 * until the message is loaded, and holds its landing until then.
 *
 * **A message this transcript does not hold even then gets silence, not a
 * sentence** — the one place this deliberately differs from the room. A miss
 * here means the id no longer addresses anything (the store renumbered it, the
 * link is old) and there is nothing a reader could do about it. The
 * conversation opens where it always does.
 *
 * @param sessionId - The conversation on screen, or `null` before one resolves.
 * @param messageId - `?message=` as it arrived.
 * @returns The row getter, or `undefined` when nothing was asked for.
 */
export function useMessageLanding(
  sessionId: string | null,
  messageId: string | undefined
): (() => string | undefined) | undefined {
  /** This request's identity — what the one-shot below is keyed on. */
  const request =
    sessionId === null || messageId === undefined ? null : `${sessionId}:${messageId}`;

  // Hand a new request to the history window, so older pages are read in
  // before the landing is asked (see the TSDoc).
  const seekedRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId === null || messageId === undefined) return;
    seekedRef.current = `${sessionId}:${messageId}`;
    useHistoryWindowStore.getState().seek(sessionId, messageId);
  }, [sessionId, messageId]);

  const consumedRef = useRef<string | null>(null);
  const landOnRow = useCallback(() => {
    if (request === null || consumedRef.current === request) return undefined;
    if (messageId === undefined || sessionId === null) return undefined;
    // Not yet, and NOT consumed: the seek for this request has not started (the
    // list asks from a layout effect, before the effect above runs) or is still
    // reading pages. The list asks again once it ends. Consuming here lost the
    // request for a link followed inside the chat already open.
    const seeking = useHistoryWindowStore.getState().seeks[sessionId] === messageId;
    if (seekedRef.current !== request || seeking) return undefined;
    consumedRef.current = request;
    // A link from another chat names a chat MESSAGE (spec `spin-off-chats` §6):
    // the Sent card or the received message it is drawn in. Asked at landing
    // time, when the history is in, and falling back to the id as given.
    // Older pages the seek read in count too (DOR-2889).
    const earlier = useHistoryWindowStore.getState().sessions[sessionId]?.earlier ?? [];
    const history = useSessionStreamStore.getState().getSession(sessionId).messages;
    return messageRowKey(
      transcriptIdForChatMessage([...earlier, ...history], messageId) ?? messageId
    );
  }, [request, messageId, sessionId]);

  return request === null ? undefined : landOnRow;
}
