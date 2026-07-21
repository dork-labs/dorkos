import type { Session } from '@dorkos/shared/types';

/** Batched Pulse task-origin lookup, injected from the composition root. */
export type ResolveTaskOrigins = (sessionIds: string[]) => Map<string, { taskName: string }>;

/**
 * Overlay Pulse task origin onto listed sessions, in place. Sessions with a
 * matching Pulse run get `origin: 'task'` and `originLabel: 'Scheduled task
 * · <taskName>'`, overwriting any origin the transcript-head classifier
 * already assigned. Sessions with no matching run pass through untouched.
 * A no-op when `resolveTaskOrigins` is undefined (Tasks subsystem disabled).
 */
export function applyTaskOriginOverlay(
  sessions: Session[],
  resolveTaskOrigins: ResolveTaskOrigins | undefined
): void {
  if (!resolveTaskOrigins || sessions.length === 0) return;
  const origins = resolveTaskOrigins(sessions.map((s) => s.id));
  if (origins.size === 0) return;
  for (const session of sessions) {
    const match = origins.get(session.id);
    if (match) {
      session.origin = 'task';
      session.originLabel = `Scheduled task · ${match.taskName}`;
    }
  }
}
