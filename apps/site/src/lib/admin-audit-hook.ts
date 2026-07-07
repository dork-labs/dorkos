/**
 * Admin-action audit + ban side effects for the cloud identity core
 * (cloud-account-management, DOR-187).
 *
 * The Better Auth `admin` plugin serves its endpoints directly (the client calls
 * `authClient.admin.*` → `/api/auth/admin/*`), so our only server seam to observe
 * them is the top-level `hooks.after` middleware in `lib/auth.ts`. This module
 * owns that seam's admin branch:
 *
 * 1. **Audit every mutating admin action** — who (the acting admin), what (the
 *    endpoint), whom (`body.userId`), and why (`body.banReason`) — into `audit_log`.
 * 2. **Close the ban→heartbeat gap** — Better Auth's `banUser` revokes the
 *    target's *sessions* but not its *API keys*, so a banned account's linked
 *    instances would keep authenticating heartbeats. On ban we disable the
 *    target's API keys (`enabled: false`) so `verifyApiKey` rejects the next
 *    heartbeat with 401 and the instance self-unlinks.
 *
 * Both effects are best-effort: the admin action has already committed, so a
 * failed audit or key-disable must never throw back through the response.
 *
 * @module lib/admin-audit-hook
 */
import type { Auth } from '@/lib/auth';
import { type AuditAction, recordAudit } from '@/lib/audit-service';

/** Map each mutating admin endpoint path to its audit action name. */
const ADMIN_ACTION_BY_PATH: Readonly<Record<string, AuditAction>> = {
  '/admin/create-user': 'admin.create_user',
  '/admin/set-role': 'admin.set_role',
  '/admin/ban-user': 'admin.ban_user',
  '/admin/unban-user': 'admin.unban_user',
  '/admin/impersonate-user': 'admin.impersonate_user',
  '/admin/stop-impersonating': 'admin.stop_impersonating',
  '/admin/revoke-user-session': 'admin.revoke_user_session',
  '/admin/revoke-user-sessions': 'admin.revoke_user_sessions',
  '/admin/set-user-password': 'admin.set_user_password',
  '/admin/remove-user': 'admin.remove_user',
};

/** The subset of the Better Auth after-hook context this handler reads. */
interface AdminAfterContext {
  path: string;
  body?: unknown;
  context?: {
    /** The endpoint's response body — present only on a successful response. */
    returned?: unknown;
    /** The acting session, resolved by the admin endpoint's `adminMiddleware`. */
    session?: { user?: { id?: string } } | null;
  };
}

/** The admin action body fields this handler reads (all optional/defensive). */
interface AdminActionBody {
  userId?: unknown;
  banReason?: unknown;
  banExpiresIn?: unknown;
  role?: unknown;
}

/** A stored API-key row (only the fields this handler touches). */
interface ApiKeyRow {
  id: string;
  enabled?: boolean | null;
}

/**
 * Handle the admin branch of the `hooks.after` middleware: audit the action and,
 * for a ban, disable the target's API keys. A no-op for non-admin paths and for
 * unsuccessful responses. Never throws.
 *
 * @param ctx - The Better Auth after-hook context.
 * @param auth - The built Better Auth instance (for the adapter + audit writer).
 */
export async function handleAdminAfter(ctx: AdminAfterContext, auth: Auth): Promise<void> {
  const action = ADMIN_ACTION_BY_PATH[ctx.path];
  if (!action) return;
  // Only audit a committed action: the after-hook can fire without a success
  // body on some error paths; `returned` is the success signal (as the
  // /device/token hook also keys on).
  if (!ctx.context?.returned) return;

  const actorUserId = ctx.context?.session?.user?.id ?? 'unknown';
  const body = (ctx.body ?? {}) as AdminActionBody;
  const targetUserId = typeof body.userId === 'string' ? body.userId : null;
  const reason =
    action === 'admin.ban_user' && typeof body.banReason === 'string' ? body.banReason : null;
  const metadata = buildMetadata(action, body);

  // Audit first (best-effort), then the ban side effect (best-effort) — one
  // failing must not skip the other, and neither may throw into the response.
  try {
    await recordAudit(auth, { actorUserId, action, targetUserId, reason, metadata });
  } catch {
    /* audit is best-effort; the action already committed */
  }

  if (action === 'admin.ban_user' && targetUserId) {
    try {
      await disableUserApiKeys(auth, targetUserId);
    } catch {
      /* key-disable is best-effort; a stale key still fails other checks */
    }
  }
}

/** Build the structured metadata payload for actions that carry extra context. */
function buildMetadata(action: AuditAction, body: AdminActionBody): Record<string, unknown> | null {
  if (action === 'admin.ban_user' && typeof body.banExpiresIn === 'number') {
    return { banExpiresIn: body.banExpiresIn };
  }
  if (action === 'admin.set_role' && body.role !== undefined) {
    return { role: body.role };
  }
  return null;
}

/**
 * Disable every API key owned by the given account so a banned user's linked
 * instances 401 on their next heartbeat. Disabling (not deleting) is reversible
 * and mirrors how the apiKey plugin gates verification on `enabled`.
 *
 * @param auth - The Better Auth instance.
 * @param userId - The banned account whose keys to disable.
 */
async function disableUserApiKeys(auth: Auth, userId: string): Promise<void> {
  const adapter = (await auth.$context).adapter;
  const keys = (await adapter.findMany({
    model: 'apikey',
    where: [{ field: 'referenceId', value: userId }],
  })) as ApiKeyRow[];
  for (const key of keys) {
    if (key.enabled === false) continue;
    await adapter.update({
      model: 'apikey',
      where: [{ field: 'id', value: key.id }],
      update: { enabled: false },
    });
  }
}
