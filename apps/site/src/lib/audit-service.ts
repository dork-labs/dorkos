/**
 * Append-only audit logging for privileged account actions
 * (cloud-account-management, DOR-187).
 *
 * Every admin action (ban/unban, impersonate, set-role, set-password,
 * remove-user) and every self-serve account deletion writes one row here, so
 * "who did what to whom, when, and why" survives even a hard (GDPR) erasure of
 * the target account (`audit_log` has no FK to `user` — see `db/audit-schema.ts`).
 *
 * Like {@link module:lib/instance-service}, all I/O goes through Better Auth's
 * database adapter (`auth.$context.adapter`) so the same code path runs against
 * production Postgres and the in-memory adapter in tests. **Never pass a secret**
 * (password, token, API-key value) in `reason` or `metadata`.
 *
 * @module lib/audit-service
 */
import type { Auth } from '@/lib/auth';
import { AUDIT_MODEL } from '@/lib/audit-registry-plugin';

/**
 * Known audit action names. A closed union keeps call sites honest and the log
 * queryable; extend it when a new privileged action is added rather than passing
 * free-form strings.
 */
export type AuditAction =
  | 'admin.create_user'
  | 'admin.update_user'
  | 'admin.set_role'
  | 'admin.ban_user'
  | 'admin.unban_user'
  | 'admin.impersonate_user'
  | 'admin.stop_impersonating'
  | 'admin.revoke_user_session'
  | 'admin.revoke_user_sessions'
  | 'admin.set_user_password'
  | 'admin.remove_user'
  | 'account.self_delete.requested'
  | 'account.self_delete.completed';

/** A record to append to the audit log. */
export interface AuditEntryInput {
  /** The account that performed the action (an admin id, or the user's own id for self-serve). */
  actorUserId: string;
  /** What happened. */
  action: AuditAction;
  /** The affected account, when the action targets one. */
  targetUserId?: string | null;
  /** Free-text justification (e.g. a ban reason). Never a secret. */
  reason?: string | null;
  /** Extra structured context (serialized to JSON). Never a secret. */
  metadata?: Record<string, unknown> | null;
}

/** An audit row as returned by {@link listAudit}. */
export interface AuditEntryView {
  id: string;
  actorUserId: string;
  action: string;
  targetUserId: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** The stored shape of an audit row (adapter-returned). */
interface AuditRecord {
  id: string;
  actorUserId: string;
  action: string;
  targetUserId: string | null;
  reason: string | null;
  metadata: string | null;
  createdAt: Date | string;
}

/** Resolve the Better Auth database adapter for the given instance. */
async function getAdapter(auth: Auth) {
  return (await auth.$context).adapter;
}

/** Coerce a stored timestamp (Date or ISO string) to an ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Parse stored metadata JSON, tolerating null/malformed values. */
function readMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Append one row to the audit log. Best-effort by contract at the call sites
 * that wrap a completed privileged action (the action already happened; a failed
 * audit write must never throw back through the action), but this function does
 * not swallow errors itself — callers decide. Never persists a secret.
 *
 * @param auth - The Better Auth instance.
 * @param entry - The action to record.
 */
export async function recordAudit(auth: Auth, entry: AuditEntryInput): Promise<void> {
  const adapter = await getAdapter(auth);
  await adapter.create({
    model: AUDIT_MODEL,
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      reason: entry.reason ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      createdAt: new Date(),
    },
  });
}

/**
 * List audit rows, newest first. With `targetUserId`, returns only the actions
 * taken against that account (used by the self-serve data export so a user can
 * see the record kept about them).
 *
 * @param auth - The Better Auth instance.
 * @param args.targetUserId - Restrict to actions against this account.
 * @param args.limit - Max rows (default 100).
 * @param args.offset - Rows to skip (default 0).
 */
export async function listAudit(
  auth: Auth,
  args: { targetUserId?: string; limit?: number; offset?: number } = {}
): Promise<AuditEntryView[]> {
  const adapter = await getAdapter(auth);
  const rows = (await adapter.findMany({
    model: AUDIT_MODEL,
    ...(args.targetUserId ? { where: [{ field: 'targetUserId', value: args.targetUserId }] } : {}),
    limit: args.limit ?? 100,
    offset: args.offset ?? 0,
    sortBy: { field: 'createdAt', direction: 'desc' },
  })) as AuditRecord[];
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    targetUserId: row.targetUserId,
    reason: row.reason,
    metadata: readMetadata(row.metadata),
    createdAt: toIso(row.createdAt),
  }));
}
