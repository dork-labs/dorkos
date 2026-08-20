import log from 'electron-log';
import type { GetServerPort } from '../event-stream';

/**
 * Act on an Ask from the Electron shell — the same three routes the cockpit's
 * own Allow/Deny/Reply buttons call (`POST /api/sessions/:id/{approve,deny,
 * submit-answers}`), reached over localhost from the main process rather than
 * through a renderer (spec `notification-system`, Desktop section).
 *
 * These calls carry no credentials. That is correct when remote login is off —
 * `readCallerPrincipal` reads an uncredentialed local caller as the operator —
 * and it is the one case that needs a fallback: with remote login on, the
 * server answers `401`/`403` because the shell holds no cookie for it. Every
 * function here reports that back as `unauthorized` rather than throwing, so
 * `notifications/index.ts` can fall back to focus-and-deep-link instead of
 * pretending the click did nothing.
 *
 * @module main/notifications/answer
 */

/** What happened when the shell tried to answer an Ask on the operator's behalf. */
export type AnswerOutcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * `no-server` — nothing is listening yet. `unauthorized` — remote login is
       * on and the shell has no credential (the expected degradation).
       * `refused` — the server understood the request and said no (already
       * resolved, bad id). `network` — the request never completed.
       */
      reason: 'no-server' | 'unauthorized' | 'refused' | 'network';
    };

/** Whether the last `unauthorized` outcome was already logged — once per outage, not once per click. */
let unauthorizedLogged = false;

async function postAnswer(
  getPort: GetServerPort,
  path: string,
  body: unknown
): Promise<AnswerOutcome> {
  const port = getPort();
  if (port === null) return { ok: false, reason: 'no-server' };

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.warn('[notifications] Could not reach the server to answer an Ask.', err);
    return { ok: false, reason: 'network' };
  }

  if (response.status === 401 || response.status === 403) {
    if (!unauthorizedLogged) {
      unauthorizedLogged = true;
      log.warn(
        '[notifications] The server refused to answer an Ask from the shell (remote login is on, ' +
          'and the shell holds no credential for it). Falling back to opening the window.'
      );
    }
    return { ok: false, reason: 'unauthorized' };
  }
  unauthorizedLogged = false;
  if (!response.ok) return { ok: false, reason: 'refused' };
  return { ok: true };
}

/**
 * `POST /api/sessions/:id/approve` — Allow.
 *
 * @param getPort - Point-in-time accessor for the server's port.
 * @param sessionId - The session the tool call is parked on.
 * @param toolCallId - The interaction id (`PendingInteractionDTO.id` for the `approval` member).
 */
export function approveTool(
  getPort: GetServerPort,
  sessionId: string,
  toolCallId: string
): Promise<AnswerOutcome> {
  return postAnswer(getPort, `/api/sessions/${encodeURIComponent(sessionId)}/approve`, {
    toolCallId,
  });
}

/**
 * `POST /api/sessions/:id/deny` — Deny. Carries no reason: a notification
 * banner has no field to write one in.
 *
 * @param getPort - Point-in-time accessor for the server's port.
 * @param sessionId - The session the tool call is parked on.
 * @param toolCallId - The interaction id.
 */
export function denyTool(
  getPort: GetServerPort,
  sessionId: string,
  toolCallId: string
): Promise<AnswerOutcome> {
  return postAnswer(getPort, `/api/sessions/${encodeURIComponent(sessionId)}/deny`, { toolCallId });
}

/**
 * `POST /api/sessions/:id/submit-answers` — the notification's Reply text,
 * answering a single-question Ask.
 *
 * @param getPort - Point-in-time accessor for the server's port.
 * @param sessionId - The session the question is parked on.
 * @param toolCallId - The interaction id.
 * @param answer - The reply text, recorded as the answer to question `0` — the
 *   only question a reply-eligible Ask has. See `notifications/index.ts` for
 *   why a multi-question Ask never offers a reply.
 */
export function submitReplyAnswer(
  getPort: GetServerPort,
  sessionId: string,
  toolCallId: string,
  answer: string
): Promise<AnswerOutcome> {
  return postAnswer(getPort, `/api/sessions/${encodeURIComponent(sessionId)}/submit-answers`, {
    toolCallId,
    answers: { '0': answer },
  });
}

/**
 * Reset the once-per-outage log guard.
 *
 * @internal Exported for testing only.
 */
export function resetAnswerLogGuard(): void {
  unauthorizedLogged = false;
}
