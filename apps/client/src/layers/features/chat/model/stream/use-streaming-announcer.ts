/**
 * The live half of the transcript: what a screen reader hears while the answer
 * is still arriving.
 *
 * @module features/chat/model/stream/use-streaming-announcer
 */
import { useEffect, useRef, useState } from 'react';
import { nextAnnouncement } from '../../lib/streaming-announcement';

/**
 * How long the words on screen must stop changing before the leftover tail —
 * the part after the last full sentence — is said.
 *
 * A time-out rather than the streaming flag, because **a pause is not an
 * ending**. `isTextStreaming` decays within half a second of the tokens
 * stopping, and they stop constantly mid-answer: to think, to call a tool, to
 * wait on a permission prompt. Treating that edge as the end of the turn is
 * what made an earlier version replay the whole answer when it resumed. Silence
 * is the honest signal: whether the turn ended or merely paused, the words
 * standing still on screen are words worth reading out.
 */
const SETTLE_MS = 1500;

/**
 * How long an announcement stays in the region before it is cleared.
 *
 * A live region only speaks when its contents CHANGE, so leaving the last
 * sentence sitting there is silent — right up until the component remounts with
 * it already in place, which most screen readers read out whole. Clearing is
 * itself silent, so the region spends its life empty and speaks only in the
 * moment it has something new.
 */
const CLEAR_MS = 4000;

/**
 * How much text a message may already carry and still be announced from its
 * beginning.
 *
 * A turn watched from the start arrives a few words at a time, so its first
 * sighting is short. A message that is already long the first time it is seen
 * was NOT watched — the stream reconnected and replayed it, or the tab was
 * asleep — and reading its backlog out is a wall of speech about something that
 * already happened. Those are picked up where they stand instead: everything
 * from here on is announced, everything before it is history.
 */
const ADOPT_FROM_START_MAX_CHARS = 400;

/** What the announcer needs to know about the transcript's tail. */
export interface StreamingAnnouncerInput {
  /** Id of the message at the end of the transcript, if there is one. */
  messageId: string | undefined;
  /** That message's text as it currently stands. */
  text: string;
  /** True while tokens are still arriving for it. */
  isStreaming: boolean;
}

/** How far one message has been read out loud. */
interface Watched {
  /** What has been announced, verbatim (see `nextAnnouncement`). */
  announced: string;
}

/**
 * The sentence to put in the transcript's `role="log"` region right now.
 *
 * **It only ever speaks about a message it watched arrive.** A conversation
 * merely opened announces nothing: its last message is not streaming, so it is
 * never watched, and its text is history a reader browses rather than news.
 *
 * **What it has said is remembered per message and never forgotten while that
 * message exists.** This is the whole lifecycle, and it is deliberately NOT
 * driven by the streaming flag: `isTextStreaming` goes false every time the
 * agent pauses to think or to run a tool, and a version of this hook that took
 * that edge for the end of the turn re-adopted the same message from zero when
 * tokens resumed and replayed the entire answer. A message is picked up once,
 * and from then on only its new text is ever spoken.
 *
 * **The tail is said when the words stop moving**, not when the flag drops — see
 * {@link SETTLE_MS}. So a turn that ends is finished off, a turn that pauses is
 * caught up to, and neither is read from the top a second time.
 */
export function useStreamingAnnouncer({
  messageId,
  text,
  isStreaming,
}: StreamingAnnouncerInput): string {
  // Keyed by message id, so a pause cannot lose the place and a second turn
  // cannot inherit the first one's. Only the tail of the transcript is ever
  // watched, so this holds one entry in practice; it is cleared when the
  // watched message is replaced.
  const watchedRef = useRef<Map<string, Watched>>(new Map());
  // The live region's contents, plus a counter — two identical sentences in a
  // row are the same DOM text, which React does not touch and no screen reader
  // announces twice. The counter alternates an invisible character so the second
  // one is a genuine change.
  const [announcement, setAnnouncement] = useState({ text: '', nonce: 0 });

  useEffect(() => {
    if (messageId === undefined) return;

    const watched = watchedRef.current.get(messageId);
    if (watched === undefined) {
      // Nothing is picked up unless it is seen arriving.
      if (!isStreaming) return;
      watchedRef.current.clear();
      watchedRef.current.set(messageId, {
        announced: text.length <= ADOPT_FROM_START_MAX_CHARS ? '' : text,
      });
    }

    const entry = watchedRef.current.get(messageId)!;
    const { chunk, announced } = nextAnnouncement(text, entry.announced, false);
    entry.announced = announced;
    if (chunk !== '') setAnnouncement((prev) => ({ text: chunk, nonce: prev.nonce + 1 }));

    // The leftover tail, once the words have stopped moving. Re-armed on every
    // change, so it fires once per lull rather than once per token.
    const settle = setTimeout(() => {
      const rest = nextAnnouncement(text, entry.announced, true);
      entry.announced = rest.announced;
      if (rest.chunk !== '')
        setAnnouncement((prev) => ({ text: rest.chunk, nonce: prev.nonce + 1 }));
    }, SETTLE_MS);
    return () => clearTimeout(settle);
  }, [messageId, text, isStreaming]);

  // Empty at rest — the state the region has to be in for a remount to be
  // silent.
  useEffect(() => {
    if (announcement.text === '') return;
    const clear = setTimeout(
      () => setAnnouncement((prev) => ({ text: '', nonce: prev.nonce })),
      CLEAR_MS
    );
    return () => clearTimeout(clear);
  }, [announcement]);

  if (announcement.text === '') return '';
  // Zero-width, so the alternation is heard by nothing and shown by nothing.
  return announcement.nonce % 2 === 0 ? announcement.text : `${announcement.text}\u200B`;
}
