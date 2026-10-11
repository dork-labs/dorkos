/**
 * Who is reading, for an HTTP request, and the session read check every
 * transcript route applies (spec `audit-trail` §3.4).
 *
 * A request that presented an agent token reads as that agent, or as
 * `unidentified` when the token resolved to nobody: a revoked token still says
 * a machine is calling. Anything else is the owner of this one-person install,
 * who reads everything. The rule itself is `canRead` (`services/audit/visibility.ts`);
 * this file only names the reader and answers in HTTP.
 *
 * A private session reads as **404, not 403**, to an agent, so its existence is
 * not confirmed: an unknown id is private too, and answers the same.
 *
 * @module routes/audit-reader
 */
import type { Request, Response } from 'express';
import type { AccountIds } from '../services/audit/account-ids.js';
import { auditTrail } from '../services/audit/audit-trail.js';
import { OWNER_READER, type AuditReader } from '../services/audit/visibility.js';
import { readableSessionIds } from '../services/audit/session-visibility.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
import { sendError } from '../lib/route-utils.js';

/**
 * Who is reading, from the request.
 *
 * @param req - The request, for the raw agent header.
 * @param res - The response carrying the resolved identity.
 * @param accounts - Names an agent as a stable account id; defaults to the
 *   process-wide audit trail's.
 */
export function readerOfRequest(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>,
  accounts: Pick<AccountIds, 'forAgentIdentity'> | undefined = auditTrail()?.accounts
): AuditReader {
  if (!presentsAgentIdentity(req, res)) return OWNER_READER;
  const identity = getRequestAgentIdentity(res);
  const accountId =
    identity && accounts ? accounts.forAgentIdentity(identity).accountId : 'unidentified';
  return { kind: 'agent', accountId };
}

/**
 * Answer 404 when this caller may not read the session, and say so.
 *
 * @param req - The request.
 * @param res - The response; written to on a refusal.
 * @param sessionId - The session asked for.
 * @returns `true` when the request was refused and answered.
 */
export function refuseUnreadableSession(
  req: Pick<Request, 'headers'>,
  res: Response,
  sessionId: string
): boolean {
  const reader = readerOfRequest(req, res);
  if (readableSessionIds(reader, [sessionId]).has(sessionId)) return false;
  sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  return true;
}

/**
 * The sessions in a list this caller may read, in order.
 *
 * @param req - The request.
 * @param res - The response carrying the resolved identity.
 * @param sessions - The list.
 */
export function readableSessions<T extends { id: string }>(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>,
  sessions: T[]
): T[] {
  const reader = readerOfRequest(req, res);
  if (reader.kind === 'owner') return sessions;
  const readable = readableSessionIds(
    reader,
    sessions.map((session) => session.id)
  );
  return sessions.filter((session) => readable.has(session.id));
}
