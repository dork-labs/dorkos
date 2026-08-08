/**
 * Presence strip — who on this team is working, right now, and a way to watch
 * without touching (spec `team-room-home` D3.3).
 *
 * The bottom line of the home surface's pinned header. Its whole contract is
 * honesty: an agent it cannot name does not appear, work it cannot place says
 * only who is doing it, and nobody working draws nothing at all rather than a
 * line saying so.
 *
 * Hosts want one of two things. A surface with a slot to fill calls
 * {@link usePresenceStrip}, which answers with the strip AND whether it will
 * draw — the question a bare node cannot be asked. A surface holding rows of
 * its own (the dev playground) renders {@link PresenceStrip} directly.
 *
 * @module features/presence-strip
 */
export { PresenceStrip } from './ui/PresenceStrip';
export type { PresenceStripProps } from './ui/PresenceStrip';
export { usePresenceStrip } from './model/use-presence-strip';
export type { PresenceSlot } from './model/use-presence-strip';
export type { PresenceFollowTarget, PresenceRow } from './lib/presence-rows';
