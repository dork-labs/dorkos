import type { Session } from '@dorkos/shared/types';
import { laterIso, type SessionTouch } from './session-touch-store.js';

/**
 * Batched lookup of when you touched these chats, injected from the
 * composition root: the stored touches, by id. Chats you never touched are
 * absent.
 */
export type ResolveTouches = (sessionIds: string[]) => Map<string, SessionTouch>;

/**
 * Overlay what you did in each chat, in place (spec `your-activity-first` D5).
 * The fourth origin step, and it must run after the room and task steps:
 *
 * - `lastTouchedByYouAt` becomes the later of when you opened it and when you
 *   wrote in it.
 * - `userLastMessageAt` becomes the later of its transcript value and when you
 *   wrote in it. For a room-, task- or agent-born chat the steps before this
 *   one have already dropped the transcript value, because a relayed room
 *   post or a task prompt reads exactly like something you typed. A recorded
 *   write is different: `session_touches` is written only by a person's own
 *   message through the app, so it is honest on any origin, and it is the one
 *   way your own message time comes back on such a chat.
 *
 * `origin`, `originLabel` and `startedBy` are left alone: how a chat started
 * stays visible; it just no longer decides whose it is. A no-op when
 * `resolveTouches` is undefined (no database).
 *
 * @param sessions - The rows to mark, mutated in place.
 * @param resolveTouches - The batched lookup.
 */
export function applyTouchedByYouOverlay(
  sessions: Session[],
  resolveTouches: ResolveTouches | undefined
): void {
  if (!resolveTouches || sessions.length === 0) return;
  const touches = resolveTouches(sessions.map((s) => s.id));
  if (touches.size === 0) return;
  for (const session of sessions) {
    const touch = touches.get(session.id);
    if (!touch) continue;
    const touchedAt = laterIso(touch.openedAt, touch.wroteAt);
    if (touchedAt) session.lastTouchedByYouAt = touchedAt;
    if (touch.wroteAt) {
      const wrote = laterIso(session.userLastMessageAt, touch.wroteAt);
      if (wrote) session.userLastMessageAt = wrote;
    }
  }
}
