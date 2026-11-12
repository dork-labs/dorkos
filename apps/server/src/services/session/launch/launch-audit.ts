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
import type { LaunchPlace, LaunchPlaceRefusal } from './launch-caller.js';

/** The action every launch row is recorded under. */
const SESSION_LAUNCH_ACTION = 'session.launch';

/**
 * Record a launch (or a fork, or a queued message's edit) the place rule
 * refused, with who asked and the place they asked for. Where it came in (the
 * surface) is the caller's audit scope's to say, as on every row.
 *
 * @param sessionId - The chat it was for.
 * @param refusal - Which rule refused it.
 * @param launchedBy - Who asked, as the binding would have recorded it.
 * @param place - The folder, the named agent and the chat's agent it asked for.
 * @param action - What was refused; a launch unless said otherwise.
 */
export function auditRefusedLaunch(
  sessionId: string,
  refusal: LaunchPlaceRefusal,
  launchedBy: string | undefined,
  place: LaunchPlace = {},
  action: string = SESSION_LAUNCH_ACTION
): void {
  const change = [
    ...(launchedBy ? [{ field: 'launchedBy', after: launchedBy }] : []),
    ...(place.cwd !== undefined ? [{ field: 'cwd', after: place.cwd }] : []),
    ...(place.agentPath !== undefined ? [{ field: 'agentPath', after: place.agentPath }] : []),
    ...(place.chatAgent ? [{ field: 'chatAgent', after: place.chatAgent }] : []),
  ];
  recordAudit({
    action,
    operation: 'execute',
    target: { type: 'session', id: sessionId },
    outcome: 'refused',
    error: refusal.code,
    ...(change.length > 0 ? { change } : {}),
    summary: `Refused: ${refusal.message}`,
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
