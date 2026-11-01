/**
 * Two tiers of unread and no more (design-decisions §18, BC-40).
 *
 * Shared because every surface that says a room has unread messages has to say
 * it the same way: the sidebar row, the room's tab and the window title cannot
 * disagree about whether a busy channel earns a number. It imports nothing, so
 * the sidebar model can deep-import it without pulling in this barrel.
 *
 * @module shared/lib/unread-signal
 */

/** How much of the operator's attention a room's unread state is asking for. */
export interface UnreadSignal {
  /**
   * `'activity'` = bold label and nothing else; `'directed'` = bold and a
   * numbered count pill; `'none'` = nothing. Two tiers and no more.
   *
   * **`'activity'` draws no dot.** A dot would be a third weight in a system
   * that deliberately has two, and the avatar corner already owns dots for
   * agent lifecycle.
   */
  tier: 'none' | 'activity' | 'directed';
  /** How many. Carried by `'directed'` only — the only tier that renders a mark. */
  count?: number;
}

/** Nothing to say. Shared so every "no unread" answer is the same object shape. */
const NONE: UnreadSignal = { tier: 'none' };

/** What {@link deriveUnreadSignal} needs to know about one room. */
export interface UnreadInput {
  /** Messages above the reader's cursor. `null` when they are not a member. */
  unreadCount: number | null | undefined;
  /** Whether this place is directed at the operator by nature — a DM. */
  directed: boolean;
  /** How many times they are @mentioned above their cursor. */
  mentionCount?: number;
  /** Whether they muted this target. */
  muted: boolean;
}

/**
 * What one room's unread state is.
 *
 * Tier 1 (`activity`) is a bold label and nothing else: something happened in a
 * place you are in. Tier 2 (`directed`) adds a numbered count pill: something
 * was aimed at you — an @mention of you, or any new message in a direct
 * message, which is addressed to you by nature. A channel with a hundred new
 * messages is still tier 1, because volume is not the same as being addressed.
 *
 * Tier 1 draws **no dot** (design-decisions §18: "Bold label only. No badge, no
 * dot."). A dot would be a third weight in a two-weight system, and the avatar
 * corner already owns dots for agent lifecycle.
 *
 * **Mute kills both — and an @mention pierces it.** That single exception is
 * the whole reason `mentionCount` is carried separately from `unreadCount`:
 * muting a room means "stop pulling me back into this", and being named by
 * hand is the one thing that is not the room pulling.
 *
 * When a DM is both directed by nature and holds mentions, the larger number
 * wins — a badge that undercounts is worse than one that rounds toward the
 * thing the reader will find when they open it.
 *
 * @param input - What is known about the room.
 */
export function deriveUnreadSignal(input: UnreadInput): UnreadSignal {
  const mentions = input.mentionCount ?? 0;
  if (input.muted) {
    return mentions > 0 ? { tier: 'directed', count: mentions } : NONE;
  }
  const unread = input.unreadCount ?? 0;
  if (input.directed && unread > 0) {
    return { tier: 'directed', count: Math.max(unread, mentions) };
  }
  if (mentions > 0) return { tier: 'directed', count: mentions };
  if (unread > 0) return { tier: 'activity' };
  return NONE;
}
