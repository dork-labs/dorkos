/**
 * Audit log routes (spec `audit-trail`).
 *
 * `GET /verify` walks the hash chain and reports whether it is intact. The same
 * check is the `audit.verify` capability (`audit_verify` over MCP, `dorkos call
 * audit.verify`), whose input and output schemas this route shares.
 *
 * @module routes/audit
 */
import { Router } from 'express';
import { AuditVerifyQuerySchema } from '@dorkos/shared/audit-schemas';
import { parseBody } from '../lib/route-utils.js';
import type { AuditLog } from '../services/audit/audit-log.js';

/**
 * Create the audit router.
 *
 * @param log - The audit log.
 */
export function createAuditRouter(log: Pick<AuditLog, 'verify'>): Router {
  const router = Router();

  router.get('/verify', (req, res) => {
    const query = parseBody(AuditVerifyQuerySchema, req.query, res);
    if (!query) return;
    return res.json(log.verify(query));
  });

  return router;
}
