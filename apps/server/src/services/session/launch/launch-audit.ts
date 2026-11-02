/**
 * The audit row for a chat a caller other than the person started or was
 * refused (DOR-3644). Messages themselves are conversation and stay out of the
 * log (`middleware/audit-request-fallback.ts`), but where an agent made a turn
 * run, and as whom, is an action: one row on the send that binds the chat, and
 * one on every refusal.
 *
 * Who acted comes from the caller's audit scope: the request's agent over
 * HTTP, the calling agent in session.
 *
 * @module services/session/launch/launch-audit
 */
import path from 'node:path';
import { recordAudit } from '../../audit/audit-trail.js';
import type { LaunchPlaceRefusal } from './launch-caller.js';

/** The action every launch row is recorded under. */
export const SESSION_LAUNCH_ACTION = 'session.launch';

/**
 * Record a launch the place rule refused.
 *
 * @param sessionId - The chat it was for.
 * @param refusal - Which rule refused it.
 * @param launchedBy - Who asked, as the binding would have recorded it.
 */
export function auditRefusedLaunch(
  sessionId: string,
  refusal: LaunchPlaceRefusal,
  launchedBy: string | undefined
): void {
  recordAudit({
    action: SESSION_LAUNCH_ACTION,
    operation: 'execute',
    target: { type: 'session', id: sessionId },
    outcome: 'refused',
    error: refusal.code,
    ...(launchedBy ? { change: [{ field: 'launchedBy', after: launchedBy }] } : {}),
    summary: `Refused to start or continue a chat: ${refusal.message}`,
  });
}

/**
 * Record a chat this send bound for a caller other than the person.
 *
 * @param sessionId - The chat.
 * @param cwd - Where its turn stands.
 * @param launchedBy - Who chose that.
 */
export function auditLaunched(sessionId: string, cwd: string, launchedBy: string): void {
  recordAudit({
    action: SESSION_LAUNCH_ACTION,
    operation: 'execute',
    target: { type: 'session', id: sessionId, name: path.basename(cwd) },
    outcome: 'ok',
    change: [
      { field: 'launchedBy', after: launchedBy },
      { field: 'cwd', after: cwd },
    ],
    summary: `Started a chat in ${cwd}`,
  });
}
