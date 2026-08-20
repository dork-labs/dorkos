/**
 * Turns session lifecycle transitions into notifications.
 *
 * Two things ride the one seam the projector already fans out
 * (`onProjectorStatusChange`), because both are answers to "what changed about
 * this session":
 *
 * - **A turn finished** — `streaming` settled to `idle`. An Activity row.
 * - **An error cleared** — a session that was stopped on an error is not stopped
 *   any more. A standing condition ending, so this is where its one history row
 *   is written. Nothing is written when the error STARTS: while it stands, the
 *   session's own lifecycle is the truth and the attention surfaces derive it.
 *
 * The projector announces a status, never a transition, so this keeps the last
 * lifecycle it saw per session. That map is the only state here, and it is
 * bounded by the number of live sessions.
 *
 * @module services/notifications/emitters/session-lifecycle
 */
import path from 'node:path';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { onProjectorStatusChange } from '../../session/session-state-projector.js';
import { notify, resolveStanding } from '../notification-service.js';

/**
 * What to call a session in a sentence.
 *
 * The working directory's last segment, which is the identity fallback every
 * other session surface uses. A notification title has to stand on its own in a
 * desktop banner or a chat message, so it cannot be an id.
 *
 * @param cwd - The session's working directory, when the projector knew one.
 */
export function sessionLabelFor(cwd: string | undefined): string {
  if (!cwd) return 'A session';
  return path.basename(cwd) || 'A session';
}

/**
 * Watch every session's lifecycle and raise what it implies.
 *
 * @returns An unsubscribe function.
 */
export function watchSessionLifecycle(): () => void {
  const previous = new Map<string, SessionLifecycle>();

  return onProjectorStatusChange(({ sessionId, cwd, retiredSessionId, status }) => {
    // A rekey re-announce carries the id this projector streamed under before
    // its canonical id resolved. Retiring it keeps the map from holding a
    // lifecycle nothing will ever move again.
    if (retiredSessionId) previous.delete(retiredSessionId);

    const before = previous.get(sessionId);
    previous.set(sessionId, status.lifecycle);
    if (before === status.lifecycle) return;

    if (before === 'streaming' && status.lifecycle === 'idle') {
      // Deliberately raised for every finished turn, including one the operator
      // started by typing here. The seam carries no principal — a turn can be
      // started from the composer, a room, a bridge or a schedule, and the
      // projector knows none of them — so an own-action drop here would be a
      // guess. Presence filtering (spec task 4.1) is what will keep this quiet
      // for somebody watching the session it happened in.
      void notify('turn.completed', {
        sessionId,
        sessionLabel: sessionLabelFor(cwd),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    if (before === 'error' && status.lifecycle !== 'error') {
      void resolveStanding(
        'session.error',
        { sessionId, sessionLabel: sessionLabelFor(cwd) },
        { outcome: 'cleared' }
      );
    }
  });
}
