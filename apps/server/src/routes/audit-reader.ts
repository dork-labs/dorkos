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
import type { AccountIds } from '../services/audit/account-ids.js';
import { auditTrail } from '../services/audit/audit-trail.js';
import { OWNER_READER, type AuditReader } from '../services/audit/visibility.js';
import { readableSessionIds } from '../services/audit/session-visibility.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody } from '../lib/route-utils.js';
import type { RequestFacts } from '../http/request-facts.js';

/** What {@link readerOfRequest} reads: the raw agent header and the resolved identity. */
type ReaderFacts = Pick<RequestFacts, 'headers' | 'agentIdentity'>;

/**
 * Who is reading, from the request.
 *
 * @param facts - The request's facts (`http/request-facts.ts`), for the raw
 *   agent header and the resolved identity. A WebSocket upgrade passes
 *   `upgradeCaller(headers, locals)`.
 * @param accounts - Names an agent as a stable account id; defaults to the
 *   process-wide audit trail's.
 */
export function readerOfRequest(
  facts: ReaderFacts,
  accounts: Pick<AccountIds, 'forAgentIdentity'> | undefined = auditTrail()?.accounts
): AuditReader {
  if (!presentsAgentIdentity(facts)) return OWNER_READER;
  const identity = facts.agentIdentity;
  const accountId =
    identity && accounts ? accounts.forAgentIdentity(identity).accountId : 'unidentified';
  return { kind: 'agent', accountId };
}

/**
 * Whether this caller may read the session. A route that may not answers
 * `c.json(SESSION_NOT_FOUND_BODY, 404)`.
 *
 * @param request - The request's facts (`http/request-facts.ts`).
 * @param sessionId - The session asked for.
 */
export function canReadSession(request: ReaderFacts, sessionId: string): boolean {
  return readableSessionIds(readerOfRequest(request), [sessionId]).has(sessionId);
}

/** The 404 a caller gets for a session it may not read. */
export const SESSION_NOT_FOUND_BODY = errorBody('Session not found', 'SESSION_NOT_FOUND');

/**
 * The sessions in a list this caller may read, in order.
 *
 * @param request - The request's facts (`http/request-facts.ts`).
 * @param sessions - The list.
 */
export function readableSessions<T extends { id: string }>(
  request: ReaderFacts,
  sessions: T[]
): T[] {
  const reader = readerOfRequest(request);
  if (reader.kind === 'owner') return sessions;
  const readable = readableSessionIds(
    reader,
    sessions.map((session) => session.id)
  );
  return sessions.filter((session) => readable.has(session.id));
}
