/**
 * How long a conversation waits to learn whether it is a DM (DOR-3074).
 *
 * A DM's rows and a session's differ in height, so drawing before the answer
 * would move the conversation when it lands. A short wait is invisible, so it
 * waits. A long one is a blank page, so past {@link TRANSCRIPT_HOLD_MS} it draws
 * as a session, the layout it uses when no answer ever comes, and accepts one
 * reflow if the answer turns out to be a DM. That needs a name to draw it under:
 * with none, the identity hold keeps it back, up to its own, longer limit. If the landing still lacks what it
 * needs at {@link TRANSCRIPT_LOADING_MS}, the list says it is loading rather than
 * stay blank or show the oldest message. Only the list waits: the bar and the
 * composer never do.
 *
 * @module widgets/session/model/use-transcript-hold
 */
import { useEffect, useState } from 'react';
import { AGENT_IDENTITY_LIMIT_MS, useWaitedPast } from '@/layers/shared/lib';

/** How long the conversation stays unseen while it waits, in milliseconds. */
export const TRANSCRIPT_HOLD_MS = 300;

/** How long a held list may stay blank before it says it is loading, in milliseconds. */
export const TRANSCRIPT_LOADING_MS = 600;

/**
 * How many frames the conversation stays unseen after it is let go.
 *
 * The landing runs when the hold ends, once it has what it needs, and it takes
 * the list a couple of frames to arrive. Shown any sooner, the oldest message
 * sits on screen first (QA, frame by frame).
 */
const REVEAL_FRAMES = 3;

/** What {@link useTranscriptHold} tells the transcript. */
export interface TranscriptHold {
  /** Whether the landing still waits for the answer. */
  held: boolean;
  /** Whether to keep the conversation unseen: while held, and while it lands. */
  hidden: boolean;
  /** Whether to show the loading state: unseen too long, with the landing not ready. */
  showLoading: boolean;
  /**
   * Set once a late answer reflowed a conversation already on screen, so the
   * timeline lands again: the rows it landed on have changed height.
   */
  landingKey: string | undefined;
}

/**
 * Hold a conversation while it waits for the answer, up to the limit.
 *
 * @param conversationId - The conversation on screen; each one gets its own wait.
 * @param undecided - Whether the answer is still out.
 * @param isDirectMessage - Whether the answer, once in, drew it as a DM.
 * @param readyToLand - Whether all the landing is waiting for now is this hold.
 * @param identityPending - Whether the agent's name and face are still on their
 *   way. The first limit doesn't let the list go without them, because a reply
 *   under the wrong name is worse than a wait: past {@link TRANSCRIPT_LOADING_MS} it
 *   says it is loading, and at {@link AGENT_IDENTITY_LIMIT_MS} it shows anyway,
 *   for the caller to draw under a name that claims nothing.
 */
export function useTranscriptHold(
  conversationId: string,
  undecided: boolean,
  isDirectMessage: boolean,
  readyToLand: boolean,
  identityPending: boolean
): TranscriptHold {
  // Named by conversation, so a wait that ran out for one never excuses the next.
  const [waitedTooLong, setWaitedTooLong] = useState<string | null>(null);

  useEffect(() => {
    if (!undecided) return;
    const timer = setTimeout(() => setWaitedTooLong(conversationId), TRANSCRIPT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [undecided, conversationId]);

  const drawnEarly = waitedTooLong === conversationId;
  const gaveUpOnIdentity = useWaitedPast(identityPending, conversationId, AGENT_IDENTITY_LIMIT_MS);
  const held = (undecided && !drawnEarly) || (identityPending && !gaveUpOnIdentity);

  // Stays true for a few frames after the hold ends. A chat that was never held
  // never starts hidden, so it gains nothing here.
  const [landing, setLanding] = useState(held);
  useEffect(() => {
    if (held) {
      setLanding(true);
      return;
    }
    if (!landing || !readyToLand) return;
    let frames = REVEAL_FRAMES;
    let handle = requestAnimationFrame(function next() {
      frames -= 1;
      if (frames === 0) setLanding(false);
      else handle = requestAnimationFrame(next);
    });
    return () => cancelAnimationFrame(handle);
  }, [held, landing, readyToLand]);

  const hidden = held || landing;
  const blankTooLong = useLoadingTooLong(hidden, conversationId);

  return {
    held,
    hidden,
    showLoading: hidden && (!readyToLand || identityPending) && blankTooLong,
    landingKey: drawnEarly && !undecided && isDirectMessage ? 'reflowed-as-dm' : undefined,
  };
}

/**
 * Whether a wait has gone on long enough to say so. A shorter wait stays quiet,
 * because a loading line that shows for a few frames reads as a flicker.
 *
 * @param waiting - Whether the conversation is waiting now.
 * @param conversationId - The conversation on screen; each one gets its own wait.
 */
export function useLoadingTooLong(waiting: boolean, conversationId: string): boolean {
  return useWaitedPast(waiting, conversationId, TRANSCRIPT_LOADING_MS);
}
