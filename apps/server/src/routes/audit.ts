/**
 * Audit log routes (spec `audit-trail`).
 *
 * The same reads as the `audit.*` capabilities, over HTTP, with the same
 * schemas and the same visibility rule: a request carrying an agent token
 * reads as that agent (or as `unidentified` when the token resolves to
 * nobody), anything else as the owner of this one-person install.
 *
 * | Route                                   | Capability               |
 * | --------------------------------------- | ------------------------ |
 * | `GET /verify`                           | `audit.verify`           |
 * | `GET /`                                 | `audit.query`            |
 * | `GET /accounts/:accountId/timeline`     | `audit.account_timeline` |
 * | `GET /:id`                              | `audit.get`              |
 *
 * `transcript_read` has no route here: the session routes are the HTTP
 * transcript read, under the same rule (`routes/audit-reader.ts`).
 *
 * @module routes/audit
 */
import { Hono } from 'hono';
import {
  AuditQuerySchema,
  AuditTimelineQuerySchema,
  AuditVerifyQuerySchema,
} from '@dorkos/shared/audit-schemas';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import type { AuditLog } from '../services/audit/audit-log.js';
import type { AccountIds } from '../services/audit/account-ids.js';
import { readableSessionIds } from '../services/audit/session-visibility.js';
import {
  readAuditEvent,
  readAuditQuery,
  readAuditTimeline,
  type ReadableSessions,
} from '../services/audit/audit-session-scrub.js';
import type { AuditReader } from '../services/audit/visibility.js';
import { readerOfRequest } from './audit-reader.js';

/** The sessions `reader` may read, through the process-wide lookup. */
function readableTo(reader: AuditReader): ReadableSessions {
  return (sessionIds) => readableSessionIds(reader, sessionIds);
}

/** What the routes read. */
export interface AuditRouterDeps {
  /** The audit log. */
  log: Pick<AuditLog, 'verify' | 'query' | 'getWithLinks' | 'timeline'>;
  /** Names a calling agent as a stable account id. */
  accounts: Pick<AccountIds, 'forAgentIdentity'>;
}

/**
 * The `/api/audit` routes.
 *
 * @param deps - The audit log and the account-id resolver.
 * @returns The routes, for `app.route('/api/audit', …)`.
 */
export function createAuditRoutes(deps: AuditRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/verify', (c) => {
    const query = AuditVerifyQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    return c.json(deps.log.verify(query.data));
  });

  router.get('/', (c) => {
    const query = AuditQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    const reader = readerOfRequest(honoRequestFacts(c), deps.accounts);
    return c.json(readAuditQuery(deps.log, query.data, reader, readableTo(reader)));
  });

  router.get('/accounts/:accountId/timeline', (c) => {
    const query = AuditTimelineQuerySchema.safeParse({
      ...readQuery(c),
      accountId: c.req.param('accountId'),
    });
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    const reader = readerOfRequest(honoRequestFacts(c), deps.accounts);
    return c.json(readAuditTimeline(deps.log, query.data, reader, readableTo(reader)));
  });

  router.get('/:id', (c) => {
    const reader = readerOfRequest(honoRequestFacts(c), deps.accounts);
    const found = readAuditEvent(deps.log, c.req.param('id'), reader, readableTo(reader));
    if (!found) return c.json(errorBody('No audit event with that id.', 'NOT_FOUND'), 404);
    return c.json(found);
  });

  return router;
}
