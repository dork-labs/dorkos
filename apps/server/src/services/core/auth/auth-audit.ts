/**
 * Sign-ins, sign-outs, accounts and API keys in the audit log (spec
 * `audit-trail` PR2).
 *
 * Better Auth keeps the current state (a session row, a key row) and no
 * history, so these hooks write the history. Two kinds of row, split the way
 * the spec's privacy line splits them:
 *
 * | Event                                   | Visibility | Why |
 * | --------------------------------------- | ---------- | --- |
 * | signed in, signed out, sign-in failed   | `admins`   | it carries where from (address, browser) |
 * | account created, API key created/revoked | `space`   | an action; no address recorded |
 *
 * The auth handler is mounted before the request audit scope exists, so every
 * row names its actor explicitly. A failed sign-in names nobody: the attempt is
 * the fact, and recording the address someone typed would put a guess at a
 * person into a log that is kept forever.
 *
 * @module services/core/auth/auth-audit
 */
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { recordAudit, auditTrail } from '../../audit/audit-trail.js';

/** The fields of a stored session row these hooks read. */
interface SessionRow {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Where a session came from, for an `admins` row. */
function whereFrom(session: SessionRow): { ip?: string; userAgent?: string } {
  return {
    ...(session.ipAddress ? { ip: session.ipAddress } : {}),
    ...(session.userAgent ? { userAgent: session.userAgent } : {}),
  };
}

/**
 * Record a sign-in: a session row was created.
 *
 * @param session - The new session.
 */
export function recordSignedIn(session: SessionRow): void {
  const trail = auditTrail();
  if (!trail) return;
  recordAudit({
    actor: trail.accounts.forUser(session.userId),
    source: { surface: 'app', ...whereFrom(session) },
    action: 'auth.signed_in',
    operation: 'auth',
    target: { type: 'account', id: session.userId },
    outcome: 'ok',
    summary: 'Signed in',
    visibility: 'admins',
  });
}

/**
 * Record a sign-out: a session row was deleted.
 *
 * @param session - The ended session.
 */
export function recordSignedOut(session: SessionRow): void {
  const trail = auditTrail();
  if (!trail) return;
  recordAudit({
    actor: trail.accounts.forUser(session.userId),
    source: { surface: 'app', ...whereFrom(session) },
    action: 'auth.signed_out',
    operation: 'auth',
    target: { type: 'account', id: session.userId },
    outcome: 'ok',
    summary: 'Signed out',
    visibility: 'admins',
  });
}

/**
 * Record the owner's account being created, and link the install id the log
 * named them by until now to the new account id, so their history reads as one
 * account (spec `audit-trail` §3.2).
 *
 * @param user - The new account.
 */
export function recordAccountCreated(user: { id: string; name: string }): void {
  const trail = auditTrail();
  if (!trail) return;
  recordAudit({
    actor: { accountId: user.id, kind: 'person', name: user.name || 'Owner' },
    source: { surface: 'app' },
    action: 'account.linked',
    operation: 'create',
    target: { type: 'account', id: user.id, name: user.name || 'Owner' },
    outcome: 'ok',
    change: [{ field: 'accountId', before: trail.accounts.installAccountId(), after: user.id }],
    summary: 'Created the owner account',
  });
}

/** What an API-key endpoint returned that names the key. */
interface ApiKeyRecord {
  id?: unknown;
  name?: unknown;
  userId?: unknown;
}

/**
 * Better Auth's `hooks.after`: record failed sign-ins and API keys being
 * created or revoked. Everything else passes through untouched.
 */
export const authAuditAfterHook = createAuthMiddleware(async (ctx) => {
  const trail = auditTrail();
  if (!trail) return;
  const returned = ctx.context.returned;
  const failed = isAPIError(returned);

  if (ctx.path.startsWith('/sign-in')) {
    if (!failed) return; // a success is the session row's own hook
    const userAgent = ctx.request?.headers.get('user-agent');
    recordAudit({
      actor: trail.accounts.unidentified('Someone signing in'),
      source: { surface: 'app', ...(userAgent ? { userAgent } : {}) },
      action: 'auth.sign_in_failed',
      operation: 'auth',
      outcome: 'refused',
      summary: 'A sign-in failed',
      visibility: 'admins',
    });
    return;
  }

  if (failed) return;
  const userId = ctx.context.session?.user.id;
  if (ctx.path === '/api-key/create') {
    const key = (returned ?? {}) as ApiKeyRecord;
    const owner = typeof key.userId === 'string' ? key.userId : userId;
    if (typeof key.id !== 'string' || !owner) return;
    recordAudit({
      actor: trail.accounts.forUser(owner),
      source: { surface: 'app' },
      action: 'api_key.created',
      operation: 'create',
      target: {
        type: 'api-key',
        id: key.id,
        ...(typeof key.name === 'string' ? { name: key.name } : {}),
      },
      outcome: 'ok',
      summary: `Created an API key${typeof key.name === 'string' ? ` named ${key.name}` : ''}`,
    });
    return;
  }
  if (ctx.path === '/api-key/delete') {
    const keyId = (ctx.body as { keyId?: unknown } | undefined)?.keyId;
    if (typeof keyId !== 'string' || !userId) return;
    recordAudit({
      actor: trail.accounts.forUser(userId),
      source: { surface: 'app' },
      action: 'api_key.revoked',
      operation: 'remove',
      target: { type: 'api-key', id: keyId },
      outcome: 'ok',
      summary: 'Revoked an API key',
    });
  }
});
