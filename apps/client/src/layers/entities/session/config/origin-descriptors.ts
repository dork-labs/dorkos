/**
 * Session-origin visual-identity registry — the single source of truth for
 * every non-user origin's icon, fallback label, and accent color. Unlike the
 * runtime registry, `user` has no entry: it is never marked (calm-tech —
 * automation is marked, humans are not).
 *
 * @module entities/session/config
 */
import type { ComponentType } from 'react';
import { Bot, MessagesSquare, CalendarClock, Globe } from 'lucide-react';
import type { SessionOrigin } from '@dorkos/shared/types';

/** Visual identity for one non-user session origin. `user` has no entry — it is never marked (calm-tech: automation is marked, humans are not). */
export interface OriginDescriptor {
  origin: SessionOrigin;
  /** Fallback label shown when the session's own `originLabel` is absent. */
  label: string;
  /** Icon component. Renders at 12px by default in `OriginMark`; pass `size` to override. */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Accent color as a CSS color value (theme `--color-*` variable). */
  accent: string;
}

/**
 * Descriptors for every non-user session origin. `user` is deliberately
 * absent — {@link getOriginDescriptor} returns `undefined` for it.
 */
export const ORIGIN_DESCRIPTORS: Partial<Record<SessionOrigin, OriginDescriptor>> = {
  agent: { origin: 'agent', label: 'Agent', icon: Bot, accent: 'var(--color-violet-500)' },
  channel: {
    origin: 'channel',
    label: 'Channel',
    icon: MessagesSquare,
    accent: 'var(--color-sky-500)',
  },
  task: {
    origin: 'task',
    label: 'Scheduled task',
    icon: CalendarClock,
    accent: 'var(--color-amber-500)',
  },
  external: { origin: 'external', label: 'External', icon: Globe, accent: 'var(--color-teal-500)' },
};

/**
 * Resolve the visual identity for a session origin. Returns `undefined` for
 * `'user'` or any unrecognized origin — callers (chiefly OriginMark) treat
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
