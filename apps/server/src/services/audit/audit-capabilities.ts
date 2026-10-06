/**
 * The audit domain of the Capability Registry (spec `audit-trail`).
 *
 * One capability today, `audit.verify`: walk the audit log's hash chain and say
 * whether it is intact, and where it first breaks if not. It is the check
 * anyone in the space can run, person or agent, so it is `observe` with no
 * permission area: it reads no content, only whether the record was tampered
 * with. Declared once here; the registry projects it onto both MCP servers
 * (`audit_verify`), `dorkos call audit.verify`, and the OpenAPI document for
 * `GET /api/audit/verify`.
 *
 * The read tools (`audit_query`, `audit_get`, `account_timeline`,
 * `transcript_read`) join this domain later (spec `audit-trail` PR4).
 *
 * @module services/audit/audit-capabilities
 */
import { AuditVerifyQuerySchema, AuditVerifyResultSchema } from '@dorkos/shared/audit-schemas';
import { defineCapability, type CapabilityDeps } from '../core/capabilities/index.js';
import type { CapabilityDomain } from '../core/capabilities/index.js';
import type { AuditLog } from './audit-log.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server keeps an audit log; gates the `audit` domain. */
    auditDeps?: {
      /** The audit log. */
      log: Pick<AuditLog, 'verify'>;
    };
  }
}

/**
 * Narrow the bag to the audit log, throwing if the registry was composed
 * without it (a wiring bug, caught at boot by `assertDeps`).
 *
 * @param deps - The capability bag.
 */
function requireAuditDeps(deps: CapabilityDeps): Pick<AuditLog, 'verify'> {
  if (!deps.auditDeps) {
    throw new Error('Audit capability invoked without auditDeps in the registry bag.');
  }
  return deps.auditDeps.log;
}

/** The audit domain. */
export const auditDomain: CapabilityDomain = {
  name: 'audit',
  assertDeps: requireAuditDeps,
  capabilities: [
    defineCapability({
      id: 'audit.verify',
      title: 'Check the audit log',
      description:
        'Check that the DorkOS audit log has not been edited: walk its hash chain and recompute ' +
        'every link. Returns ok, how many rows were checked, the last row and its hash, and — if ' +
        'the chain is broken — the first row that does not check out and why. Optional fromSeq ' +
        'and limit check a stretch instead of the whole log.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: AuditVerifyQuerySchema,
      output: AuditVerifyResultSchema,
      surfaces: {
        mcp: {
          toolName: 'audit_verify',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        http: { method: 'get', path: '/api/audit/verify' },
      },
      invoke: async (deps, input) => requireAuditDeps(deps).verify(input),
    }),
  ],
};
