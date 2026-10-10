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
import { Router } from 'express';
import {
  AuditQuerySchema,
  AuditTimelineQuerySchema,
  AuditVerifyQuerySchema,
} from '@dorkos/shared/audit-schemas';
import { parseBody, sendError } from '../lib/route-utils.js';
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
 * Create the audit router.
 *
 * @param deps - The audit log and the account-id resolver.
 */
export function createAuditRouter(deps: AuditRouterDeps): Router {
  const router = Router();

  router.get('/verify', (req, res) => {
    const query = parseBody(AuditVerifyQuerySchema, req.query, res);
    if (!query) return;
    return res.json(deps.log.verify(query));
  });

  router.get('/', (req, res) => {
    const query = parseBody(AuditQuerySchema, req.query, res);
    if (!query) return;
    const reader = readerOfRequest(req, res, deps.accounts);
    return res.json(readAuditQuery(deps.log, query, reader, readableTo(reader)));
  });

  router.get('/accounts/:accountId/timeline', (req, res) => {
    const query = parseBody(
      AuditTimelineQuerySchema,
      { ...req.query, accountId: req.params.accountId },
      res
    );
    if (!query) return;
    const reader = readerOfRequest(req, res, deps.accounts);
    return res.json(readAuditTimeline(deps.log, query, reader, readableTo(reader)));
  });

  router.get('/:id', (req, res) => {
    const reader = readerOfRequest(req, res, deps.accounts);
    const found = readAuditEvent(deps.log, req.params.id, reader, readableTo(reader));
    if (!found) return sendError(res, 404, 'No audit event with that id.', 'NOT_FOUND');
    return res.json(found);
  });

  return router;
}
