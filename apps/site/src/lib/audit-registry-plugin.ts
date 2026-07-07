/**
 * A schema-only Better Auth plugin registering the `audit_log` model
 * (cloud-account-management, DOR-187).
 *
 * Like the instance registry, the audit log is written and read exclusively
 * through Better Auth's database adapter (`auth.$context.adapter`) so the same
 * code path runs against the production Postgres Drizzle adapter and the
 * in-memory adapter tests use. Declaring the model here is what makes the
 * adapter aware of `audit_log` — its field names and types.
 *
 * Deliberately declares **no** `references`: the audit trail must outlive a
 * hard-deleted (GDPR-erased) account, so it is never a cascade target and holds
 * account ids only as opaque strings (see `db/audit-schema.ts`).
 *
 * It ships no endpoints — audit rows are written by the admin-action hook and
 * the self-serve delete hooks in `lib/auth.ts`, and read by `lib/account-service.ts`.
 *
 * @module lib/audit-registry-plugin
 */
import type { BetterAuthPlugin } from 'better-auth';

/** The Better Auth model name for the audit-log table. */
export const AUDIT_MODEL = 'auditLog';

/**
 * Better Auth plugin that declares the `audit_log` table schema so the database
 * adapter can create and find audit rows. Field names mirror `db/audit-schema.ts`
 * exactly. No `references` — the log stays outside the account cascade cluster.
 */
export function auditRegistry(): BetterAuthPlugin {
  return {
    id: 'audit-registry',
    schema: {
      auditLog: {
        fields: {
          actorUserId: { type: 'string', required: true },
          action: { type: 'string', required: true },
          targetUserId: { type: 'string', required: false },
          reason: { type: 'string', required: false },
          metadata: { type: 'string', required: false },
          createdAt: { type: 'date', required: true },
        },
      },
    },
  };
}
