import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireErasureCreateRequestSchema,
  CommunityWireErasureListResponseSchema,
  CommunityWireErasureResponseSchema,
  CommunityWireFormerMembershipListResponseSchema,
  CommunityWireOwnerErasureListResponseSchema,
  type CommunityWireErasure,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireMember, transaction } from '../data.js';
import { ERASURE_WINDOW_HOURS } from '../erasure.js';
import { ApiError, json, readJson } from '../http.js';

/** How recent a sign-in must be for an account without a password to confirm an erasure. */
export const REAUTH_WINDOW_MS = 5 * 60_000;

/** What a request must do to prove the person is at the keyboard. */
export type ReauthenticationDecision =
  'check-password' | 'password-required' | 'fresh-session' | 'sign-in-again';

/**
 * Decide how an erasure request reauthenticates. An account with a password must type it;
 * an account that signs in only through a provider must have signed in within five minutes.
 */
export function reauthenticationDecision(input: {
  hasPassword: boolean;
  passwordGiven: boolean;
  sessionCreatedAt: Date;
  now: Date;
}): ReauthenticationDecision {
  if (input.hasPassword) return input.passwordGiven ? 'check-password' : 'password-required';
  return input.now.getTime() - input.sessionCreatedAt.getTime() < REAUTH_WINDOW_MS
    ? 'fresh-session'
    : 'sign-in-again';
}

interface ErasureRow {
  id: string;
  kind: 'membership' | 'account';
  state: CommunityWireErasure['state'];
  community_id: string | null;
  community_name: string | null;
  execute_after: Date;
  created_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

const ERASURE_COLUMNS = `r.id,r.kind,r.state,r.community_id,r.execute_after,r.created_at,
  r.completed_at,r.cancelled_at`;

function projectErasure(row: ErasureRow): CommunityWireErasure {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    communityId: row.community_id,
    communityName: row.community_name,
    executeAfter: row.execute_after.toISOString(),
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

/** Erasure belongs to the person: no connection grant, agent, or host key may reach it. */
function refuseBearer(c: Context): void {
  if (c.req.header('authorization'))
    throw new ApiError(403, 'FORBIDDEN', 'Erasing needs your own signed-in browser session.');
}

async function requireAccount(c: Context, auth: CommunityAuth) {
  refuseBearer(c);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return session;
}

/** Wrong passwords one account may try on erasure routes in {@link REAUTH_FAILURE_WINDOW_MS}. */
export const REAUTH_FAILURE_LIMIT = 5;
const REAUTH_FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * Per-account count of recent wrong passwords, so a stolen session cannot guess the password
 * that erasure asks for. In memory, like the app's other attempt limits.
 */
class ReauthFailures {
  private readonly failures = new Map<string, number[]>();

  private recent(userId: string, now: number): number[] {
    const times = (this.failures.get(userId) ?? []).filter(
      (time) => now - time < REAUTH_FAILURE_WINDOW_MS
    );
    if (times.length) this.failures.set(userId, times);
    else this.failures.delete(userId);
    return times;
  }

  assertAllowed(userId: string): void {
    if (this.recent(userId, Date.now()).length >= REAUTH_FAILURE_LIMIT)
      throw new ApiError(429, 'RATE_LIMITED', 'Too many wrong passwords. Try again later.');
  }

  record(userId: string): void {
    const now = Date.now();
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(userId, [...this.recent(userId, now), now]);
  }
}

async function reauthenticate(
  c: Context,
  auth: CommunityAuth,
  failures: ReauthFailures,
  pool: Pool,
  session: { user: { id: string }; session: { createdAt: Date } },
  password: string | undefined
): Promise<void> {
  const credential = await pool.query(
    `SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"='credential' AND password IS NOT NULL`,
    [session.user.id]
  );
  const decision = reauthenticationDecision({
    hasPassword: Boolean(credential.rowCount),
    passwordGiven: Boolean(password),
    sessionCreatedAt: new Date(session.session.createdAt),
    now: new Date(),
  });
  if (decision === 'password-required')
    throw new ApiError(403, 'FORBIDDEN', 'Enter your password to continue.');
  if (decision === 'sign-in-again')
    throw new ApiError(403, 'REAUTH_REQUIRED', 'Sign in again, then try once more.');
  if (decision === 'check-password') {
    failures.assertAllowed(session.user.id);
    try {
      await auth.api.verifyPassword({
        headers: c.req.raw.headers,
        body: { password: password! },
      });
    } catch {
      failures.record(session.user.id);
      throw new ApiError(403, 'FORBIDDEN', 'Reauthentication failed.');
    }
  }
}

async function openRequest(
  client: PoolClient,
  where: string,
  params: unknown[]
): Promise<ErasureRow | undefined> {
  const result = await client.query<ErasureRow>(
    `SELECT ${ERASURE_COLUMNS},c.name AS community_name FROM erasure_requests r
     LEFT JOIN communities c ON c.id=r.community_id
     WHERE r.state IN ('scheduled','running') AND ${where}`,
    params
  );
  return result.rows[0];
}

async function schedule(
  client: PoolClient,
  values: { kind: 'membership' | 'account'; userId: string | null; memberId: string | null },
  communityId: string | null,
  communityName: string | null
): Promise<ErasureRow> {
  const inserted = await client.query<ErasureRow>(
    `INSERT INTO erasure_requests(kind,user_id,community_id,member_id,execute_after,next_attempt_at)
     VALUES($1,$2,$3,$4,now()+make_interval(hours=>$5),now()+make_interval(hours=>$5))
     RETURNING id,kind,state,community_id,execute_after,created_at,completed_at,cancelled_at`,
    [values.kind, values.userId, communityId, values.memberId, ERASURE_WINDOW_HOURS]
  );
  return { ...inserted.rows[0], community_name: communityName };
}

/**
 * Register the signed-in person's own erasure routes on the host API. They act only on the
 * session's own account and memberships, so host authority has nothing here to reach.
 */
export function registerAccountErasureRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  const failures = new ReauthFailures();
  app.get('/account/former-memberships', async (c) => {
    const session = await requireAccount(c, auth);
    const result = await pool.query<{
      community_id: string;
      name: string;
      removed_at: Date | null;
      erasure_id: string | null;
    }>(
      `SELECT c.id AS community_id,c.name,m.removed_at,r.id AS erasure_id
       FROM members m JOIN communities c ON c.id=m.community_id
       LEFT JOIN erasure_requests r ON r.kind='membership' AND r.community_id=m.community_id
         AND r.member_id=m.id AND r.state IN ('scheduled','running')
       WHERE m.user_id=$1 AND NOT m.active
       ORDER BY lower(c.name),c.id`,
      [session.user.id]
    );
    const open = await pool.query<ErasureRow>(
      `SELECT ${ERASURE_COLUMNS},c.name AS community_name FROM erasure_requests r
       JOIN communities c ON c.id=r.community_id WHERE r.id=ANY($1::uuid[])`,
      [result.rows.flatMap((row) => (row.erasure_id ? [row.erasure_id] : []))]
    );
    const byId = new Map(open.rows.map((row) => [row.id, projectErasure(row)]));
    return json(c, CommunityWireFormerMembershipListResponseSchema, {
      memberships: result.rows.map((row) => ({
        communityId: row.community_id,
        communityName: row.name,
        leftAt: row.removed_at?.toISOString() ?? null,
        erasure: (row.erasure_id && byId.get(row.erasure_id)) || null,
      })),
    });
  });

  app.get('/account/erasures', async (c) => {
    const session = await requireAccount(c, auth);
    const recent = `(r.state IN ('scheduled','running')
      OR (r.state='cancelled' AND r.cancelled_at>now()-interval '30 days'))`;
    const result = await pool.query<ErasureRow>(
      `SELECT ${ERASURE_COLUMNS},NULL::text AS community_name FROM erasure_requests r
       WHERE r.kind='account' AND r.user_id=$1 AND ${recent}
       UNION ALL
       SELECT ${ERASURE_COLUMNS},c.name AS community_name FROM erasure_requests r
       JOIN members m ON m.id=r.member_id AND m.community_id=r.community_id
       JOIN communities c ON c.id=r.community_id
       WHERE r.kind='membership' AND m.user_id=$1 AND ${recent}
       ORDER BY created_at DESC,id`,
      [session.user.id]
    );
    return json(c, CommunityWireErasureListResponseSchema, {
      erasures: result.rows.map(projectErasure),
    });
  });

  app.post('/account/erasures', async (c) => {
    const session = await requireAccount(c, auth);
    const body = await readJson(c, CommunityWireErasureCreateRequestSchema);
    if (body.kind === 'account' && body.confirmEmail !== session.user.email)
      throw new ApiError(409, 'STATE_CONFLICT', 'Enter your account email exactly.');
    await reauthenticate(c, auth, failures, pool, session, body.password);
    const userId = session.user.id;
    const outcome = await transaction(pool, async (client) => {
      // Lock the account, then its memberships: an owner claim waits on the account row and an
      // ownership transfer on the member row, so neither can race this request's checks.
      const account = await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
      if (!account.rowCount) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const memberships = await client.query<{
        id: string;
        community_id: string;
        community_name: string;
        role: 'owner' | 'admin' | 'member';
        active: boolean;
      }>(
        `SELECT m.id,m.community_id,c.name AS community_name,m.role,m.active
         FROM members m JOIN communities c ON c.id=m.community_id
         WHERE m.user_id=$1 ORDER BY m.community_id,m.id FOR UPDATE OF m`,
        [userId]
      );
      if (body.kind === 'membership') {
        const member = memberships.rows.find((row) => row.community_id === body.communityId);
        if (!member)
          throw new ApiError(404, 'NOT_FOUND', 'You are not a member of that community.');
        if (member.active && member.role === 'owner')
          throw new ApiError(403, 'FORBIDDEN', 'Transfer ownership or delete the community first.');
        const existing = await openRequest(
          client,
          `r.kind='membership' AND r.community_id=$1 AND r.member_id=$2`,
          [member.community_id, member.id]
        );
        if (existing) return { row: existing, created: false };
        return {
          row: await schedule(
            client,
            { kind: 'membership', userId: null, memberId: member.id },
            member.community_id,
            member.community_name
          ),
          created: true,
        };
      }
      const operator = await client.query('SELECT 1 FROM host_operators WHERE user_id=$1', [
        userId,
      ]);
      if (operator.rowCount)
        throw new ApiError(
          403,
          'FORBIDDEN',
          'This account runs this host, so it cannot be deleted here. You can still erase your messages from each community.'
        );
      const owned = memberships.rows
        .filter((row) => row.active && row.role === 'owner')
        .map((row) => row.community_name);
      if (owned.length)
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          `You own ${owned.join(', ')}. To delete your account, first transfer ownership to another member or delete ${owned.length === 1 ? 'the community' : 'those communities'}, then wait until the deletion finishes.`
        );
      const existing = await openRequest(client, `r.kind='account' AND r.user_id=$1`, [userId]);
      if (existing) return { row: existing, created: false };
      return {
        row: await schedule(client, { kind: 'account', userId, memberId: null }, null, null),
        created: true,
      };
    });
    return json(
      c,
      CommunityWireErasureResponseSchema,
      { erasure: projectErasure(outcome.row) },
      outcome.created ? 201 : 200
    );
  });

  app.post('/account/erasures/:id/cancel', async (c) => {
    const session = await requireAccount(c, auth);
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError(404, 'NOT_FOUND', 'Erasure not found.');
    const row = await transaction(pool, async (client) => {
      const found = await client.query<ErasureRow & { due: boolean }>(
        `SELECT ${ERASURE_COLUMNS},c.name AS community_name,r.execute_after<=now() AS due
         FROM erasure_requests r
         LEFT JOIN members m ON m.id=r.member_id AND m.community_id=r.community_id
         LEFT JOIN communities c ON c.id=r.community_id
         WHERE r.id=$1 AND (
           (r.kind='account' AND r.user_id=$2) OR (r.kind='membership' AND m.user_id=$2)
         ) FOR UPDATE OF r`,
        [id.data, session.user.id]
      );
      const request = found.rows[0];
      if (!request) throw new ApiError(404, 'NOT_FOUND', 'Erasure not found.');
      if (request.state === 'cancelled') return request;
      if (request.state !== 'scheduled' || request.due)
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This erasure has already started, so it can no longer be cancelled.'
        );
      const cancelled = await client.query<{ cancelled_at: Date }>(
        `UPDATE erasure_requests SET state='cancelled',cancelled_at=now()
         WHERE id=$1 RETURNING cancelled_at`,
        [request.id]
      );
      return {
        ...request,
        state: 'cancelled' as const,
        cancelled_at: cancelled.rows[0].cancelled_at,
      };
    });
    return json(c, CommunityWireErasureResponseSchema, { erasure: projectErasure(row) });
  });
}

/**
 * Register the owner's list of completed self-erasures in one community. A scheduled one is
 * never shown, so nobody can press the person to cancel during the window.
 */
export function registerOwnerErasureRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.get('/owner/erasures', async (c) => {
    refuseBearer(c);
    const member = await requireMember(c, auth, pool, {
      allowSuspended: true,
      allowDeletionPending: true,
    });
    if (member.role !== 'owner')
      throw new ApiError(403, 'FORBIDDEN', 'Only the owner can see erasures.');
    const result = await pool.query<{ id: string; member_id: string; completed_at: Date }>(
      `SELECT id,member_id,completed_at FROM erasure_requests
       WHERE kind='membership' AND community_id=$1 AND state='completed'
       ORDER BY completed_at DESC,id LIMIT 500`,
      [member.community_id]
    );
    return json(c, CommunityWireOwnerErasureListResponseSchema, {
      erasures: result.rows.map((row) => ({
        id: row.id,
        memberId: row.member_id,
        completedAt: row.completed_at.toISOString(),
      })),
    });
  });
}
