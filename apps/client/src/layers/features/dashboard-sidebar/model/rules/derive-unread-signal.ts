/**
 * Two tiers of unread and no more (design-decisions §18, BC-40).
 *
 * @module features/dashboard-sidebar/model/rules/derive-unread-signal
 */
import type { SidebarUnread } from '../build-sidebar-model';

/** Nothing to say. Shared so every "no unread" answer is the same object shape. */
const NONE: SidebarUnread = { tier: 'none' };

/** What {@link deriveUnreadSignal} needs to know about one row's subject. */
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
 * What one row's unread state is.
 *
 * Tier 1 (`activity`) is a bold label and a dot: something happened in a place
 * you are in. Tier 2 (`directed`) is a numbered badge: something was aimed at
 * you. A channel with a hundred new messages is still tier 1, because volume
 * is not the same as being addressed.
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
 * @param input - What is known about the row's subject.
 */
export function deriveUnreadSignal(input: UnreadInput): SidebarUnread {
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
