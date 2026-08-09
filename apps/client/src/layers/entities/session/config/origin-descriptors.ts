/**
 * Session-origin visual-identity registry — the single source of truth for
 * every non-user origin's icon and fallback label. Unlike the runtime
 * registry, `user` has no entry: it is never marked (calm-tech: automation
 * is marked, humans are not).
 *
 * @module entities/session/config
 */
import { ORIGIN_GLYPH, type IdentityGlyph } from '@/layers/shared/ui';
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
  // Every glyph comes from the shared `ORIGIN_GLYPH` registry, never from
  // `lucide-react` directly. Today's rows, the session switcher, "+N automated",
  // ⌘K and Activity all draw origins, and the marks used to be chosen here for
  // the sidebar and re-chosen wherever else an origin appeared — so this file
  // now pairs each origin with its LABEL, and the registry owns its picture
  // (BC-26).
  agent: { origin: 'agent', label: 'Agent', icon: ORIGIN_GLYPH.agent },
  channel: { origin: 'channel', label: 'Connection', icon: ORIGIN_GLYPH.channel },
  // A turn an agent took in one of this machine's own rooms — the session's own
  // `originLabel` names which one.
  room: { origin: 'room', label: 'Room', icon: ORIGIN_GLYPH.room },
  task: { origin: 'task', label: 'Scheduled task', icon: ORIGIN_GLYPH.task },
  external: { origin: 'external', label: 'External', icon: ORIGIN_GLYPH.external },
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
