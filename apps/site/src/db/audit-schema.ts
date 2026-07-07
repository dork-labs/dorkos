/**
 * `audit_log` — append-only record of privileged account actions on the
 * **DorkOS account** cloud identity core (cloud-account-management, DOR-187).
 *
 * One row per admin action (ban/unban, impersonate, set-role, set-password,
 * remove-user) and per self-serve account deletion. It answers "who did what to
 * whom, when, and why" for support, abuse response, and compliance forensics.
 *
 * ## No foreign key to `user` (deliberate)
 *
 * `actorUserId` and `targetUserId` are stored as **plain text ids, not foreign
 * keys**. A hard-deleted (GDPR-erased) user cascades away its sessions,
 * accounts, API keys, and instances — but the audit trail of actions taken
 * against that account MUST survive the erasure, so it can never be a cascade
 * target. The audit log is therefore intentionally outside the `onDelete:
 * cascade` cluster: it references account ids only as opaque strings.
 *
 * ## Telemetry isolation (privacy contract)
 *
 * Hard-isolated from `marketplaceInstallEvents` (`./schema.ts`): no foreign key,
 * join column, or shared identifier crosses the account ↔ telemetry boundary
 * (enforced by `__tests__/schema.test.ts`). Never write a secret here — actions
 * are recorded by name, never with a password, token, or API-key value.
 *
 * @module db/audit-schema
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `audit_log` — append-only privileged-action log. Insert-only; rows are never
 * updated or deleted in normal operation.
 *
 * `id` is a random uuid (adapter-generated, mirroring the `instance` registry)
 * so the log is written through Better Auth's database adapter — the same code
 * path runs against production Postgres and the in-memory adapter in tests.
 * Chronology comes from `createdAt`, not the id.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    /** Random uuid primary key (adapter-generated). */
    id: uuid('id').primaryKey().defaultRandom(),
    /** The account that performed the action (an admin, or the user for self-serve). Opaque id, not an FK. */
    actorUserId: text('actor_user_id').notNull(),
    /** Dotted action name, e.g. `admin.ban_user`, `admin.impersonate`, `account.self_delete.completed`. */
    action: text('action').notNull(),
    /** The affected account, when the action targets one. Opaque id, not an FK; null for non-user-scoped actions. */
    targetUserId: text('target_user_id'),
    /** Free-text justification (e.g. the ban reason). Never a secret. */
    reason: text('reason'),
    /** JSON string of extra context (e.g. `{ "banExpiresIn": 604800 }`). Never a secret. */
    metadata: text('metadata'),
    /** Server-side receive timestamp. Trust this, never a client clock. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_audit_log_target_created').on(t.targetUserId, t.createdAt.desc())]
);

/** A row read from `audit_log`. */
export type AuditLogEntry = typeof auditLog.$inferSelect;

/** A row insertable into `audit_log`. */
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
