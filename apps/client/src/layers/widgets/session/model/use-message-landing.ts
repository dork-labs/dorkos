/**
 * Landing a conversation on the one message a search hit named (DOR-1579).
 *
 * @module widgets/session/model/use-message-landing
 */
import { useCallback, useRef } from 'react';
import { messageRowKey } from '@/layers/features/chat';

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
 * **A message this transcript does not hold gets silence, not a sentence** —
 * the one place this deliberately differs from the room. A room loads its
 * trailing page and nothing pages backwards, so a hit outside that page is a
 * real limit worth naming; a conversation loads its history whole, so a miss
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

  const consumedRef = useRef<string | null>(null);
  const landOnRow = useCallback(() => {
    if (request === null || consumedRef.current === request) return undefined;
    consumedRef.current = request;
    return messageId === undefined ? undefined : messageRowKey(messageId);
  }, [request, messageId]);

  return request === null ? undefined : landOnRow;
}
