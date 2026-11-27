/**
 * The heartbeat origin overlay: beat chats read "Heartbeat" in the chat list.
 * It sits beside the room and task overlays and, like them, decides nothing
 * itself: which chats are beat chats is a lookup the space side hands in
 * (`heartbeats/heartbeat-adapters.ts`, `beatChatResolver`), absent while heartbeats are
 * not running (spec `computer-side-starts-alone` §5.12).
 *
 * @module services/session/origin/heartbeat-origin-overlay
 */
import type { Session } from '@dorkos/shared/types';
import { HEARTBEAT_ORIGIN_LABEL } from '@dorkos/shared/heartbeat-schemas';
import { dropUserLastMessageAtWithoutOperator } from './user-last-message-origin.js';

/** Which of these chats are beat chats. */
export type ResolveBeatChats = (sessionIds: string[]) => Set<string>;

/**
 * Label beat chats "Heartbeat" in the chat list. An agent started them, nobody
 * typed: like a scheduled run, a beat bumps no "last message from you".
 *
 * @param sessions - The listed chats, changed in place.
 * @param resolve - Which ids are beat chats; absent when heartbeats are off.
 */
export function applyHeartbeatOriginOverlay(
  sessions: Session[],
  resolve: ResolveBeatChats | undefined
): void {
  if (!resolve || sessions.length === 0) return;
  const beats = resolve(sessions.map((s) => s.id));
  if (beats.size === 0) return;
  for (const session of sessions) {
    if (!beats.has(session.id)) continue;
    session.origin = 'agent';
    session.originLabel = HEARTBEAT_ORIGIN_LABEL;
    delete session.originRoomId;
    dropUserLastMessageAtWithoutOperator(session);
  }
}
