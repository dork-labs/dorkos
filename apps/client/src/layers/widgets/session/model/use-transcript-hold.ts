/**
 * How long a conversation waits to learn whether it is a DM (DOR-3074).
 *
 * A DM's rows and a session's differ in height, so drawing before the answer
 * would move the conversation when it lands. A short wait is invisible, so it
 * waits. A long one is a blank page, so past {@link TRANSCRIPT_HOLD_MS} it draws
 * as a session, the layout it uses when no answer ever comes, and accepts one
 * reflow if the answer turns out to be a DM.
 *
 * @module widgets/session/model/use-transcript-hold
 */
import { useEffect, useState } from 'react';

/** How long the conversation stays unseen while it waits, in milliseconds. */
export const TRANSCRIPT_HOLD_MS = 300;

/** What {@link useTranscriptHold} tells the transcript. */
export interface TranscriptHold {
  /** Whether to keep the conversation unseen, and hold its landing, for now. */
  held: boolean;
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
 */
export function useTranscriptHold(
  conversationId: string,
  undecided: boolean,
  isDirectMessage: boolean
): TranscriptHold {
  // Named by conversation, so a wait that ran out for one never excuses the next.
  const [waitedTooLong, setWaitedTooLong] = useState<string | null>(null);

  useEffect(() => {
    if (!undecided) return;
    const timer = setTimeout(() => setWaitedTooLong(conversationId), TRANSCRIPT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [undecided, conversationId]);

  const drawnEarly = waitedTooLong === conversationId;
  return {
    held: undecided && !drawnEarly,
    landingKey: drawnEarly && !undecided && isDirectMessage ? 'reflowed-as-dm' : undefined,
  };
}
