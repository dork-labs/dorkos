/**
 * Session-origin visual-identity registry — the single source of truth for
 * every non-user origin's icon and fallback label. Unlike the runtime
 * registry, `user` has no entry: it is never marked (calm-tech: automation
 * is marked, humans are not).
 *
 * @module entities/session/config
 */
import { MessagesSquare, CalendarClock, Globe, Hash } from 'lucide-react';
import { AGENT_GLYPH, type IdentityGlyph } from '@/layers/shared/ui';
import type { SessionOrigin } from '@dorkos/shared/types';

/** Visual identity for one non-user session origin. `user` has no entry — it is never marked (calm-tech: automation is marked, humans are not). */
export interface OriginDescriptor {
  origin: SessionOrigin;
  /** Fallback label shown when the session's own `originLabel` is absent. */
  label: string;
  /** Icon component. Renders at 12px by default in `SessionOriginMark`; pass `size` to override. */
  icon: IdentityGlyph;
}

/**
 * Descriptors for every non-user session origin. `user` is deliberately
 * absent — {@link getOriginDescriptor} returns `undefined` for it.
 */
export const ORIGIN_DESCRIPTORS: Partial<Record<SessionOrigin, OriginDescriptor>> = {
  // The Bot comes from the shared glyph registry, not from `lucide-react`: the
  // badge in an agent's own avatar corner draws the identical mark for the
  // identical reason, and the two used to import it independently.
  agent: { origin: 'agent', label: 'Agent', icon: AGENT_GLYPH },
  channel: { origin: 'channel', label: 'Connection', icon: MessagesSquare },
  // A turn an agent took in one of this machine's own rooms. `#` is the room
  // mark the whole cockpit already draws (`RoomAvatar`), so a run from
  // `#general` wears the same glyph as the place it came from — and the
  // session's own `originLabel` names that place. Deliberately NOT the
  // `MessagesSquare` a bridged chat wears: the two origins are one word apart
  // and must not be one picture apart as well.
  room: { origin: 'room', label: 'Room', icon: Hash },
  task: { origin: 'task', label: 'Scheduled task', icon: CalendarClock },
  external: { origin: 'external', label: 'External', icon: Globe },
};

/**
 * Resolve the visual identity for a session origin. Returns `undefined` for
 * `'user'` or any unrecognized origin — callers (chiefly SessionOriginMark) treat
 * `undefined` as "render nothing," matching calm-tech: unmarked means you,
 * marked means automation.
 *
 * @param origin - Session origin, or `undefined` when the session has none
 */
export function getOriginDescriptor(
  origin: SessionOrigin | undefined
): OriginDescriptor | undefined {
  if (!origin || origin === 'user') return undefined;
  return ORIGIN_DESCRIPTORS[origin];
}
