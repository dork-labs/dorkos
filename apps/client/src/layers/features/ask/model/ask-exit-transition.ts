/**
 * How long an answered card holds its receipt before it melts away, in
 * seconds.
 *
 * The confirmation has to survive the round trip: the mutation settles, the
 * list is re-read, and the approval disappears from the data — often inside a
 * single frame on a local server. Without the hold the checkmark is a flicker,
 * and a person is left unsure whether their answer landed.
 */
export const RESOLVE_HOLD_S = 0.4;

/** How long the melt itself takes, in seconds. */
export const MELT_S = 0.2;

/** What decides how a card leaves. */
export interface AskExitTransitionInput {
  /** True when the person answered this card, rather than it expiring or being answered elsewhere. */
  decided: boolean;
  /** True when the reader asked for less motion. */
  reducedMotion: boolean;
}

/**
 * The exit transition for one card — an Ask, or a capability approval.
 *
 * Two independent things: the **hold** is feedback and the **melt** is
 * decoration. Reduced motion removes the melt — the card simply stops being
 * there — but keeps the hold, because a checkmark nobody had time to read is
 * not a calmer interface, it is a missing one.
 *
 * A card that leaves for any other reason (it expired, or somebody answered it
 * in another window) has no checkmark to hold, so it goes straight away.
 *
 * @param input - Whether this card was {@link AskExitTransitionInput.decided} here, and the reader's motion preference.
 * @returns The `delay` and `duration`, in seconds, for the card's exit.
 */
export function askExitTransition({ decided, reducedMotion }: AskExitTransitionInput): {
  delay: number;
  duration: number;
} {
  return {
    delay: decided ? RESOLVE_HOLD_S : 0,
    duration: reducedMotion ? 0 : MELT_S,
  };
}
