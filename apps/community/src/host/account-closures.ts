import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminAccountClosureReasonSchema,
  CommunityAdminAccountClosureSchema,
} from '@dorkos/shared/community-admin-wire';
import { ERASURE_WINDOW_HOURS } from '../erasure/erasure.js';
import {
  ERASURE_WAITS_ON_LEGAL_HOLD_SQL,
  ERASURE_WAITS_ON_TAKEDOWN_SQL,
} from '../erasure/guards.js';
import { ApiError } from '../http.js';
import {
  assertHostActor,
  hostActorRequester,
  recordHostAudit,
  type HostActor,
} from './authority.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Why a host closed an account. */
export type AccountClosureReason = z.infer<typeof CommunityAdminAccountClosureReasonSchema>;
/** One closure as the host API returns it. */
export type AccountClosureProjection = z.infer<typeof CommunityAdminAccountClosureSchema>;

/** What the host asked for, with the checks that need no database already passed. */
export interface AccountClosureRequest {
  accountId: string;
  actor: HostActor;
  idempotencyKey: string;
  reason: AccountClosureReason;
  reference: string | null;
  now: Date;
}

interface ClosureRow {
  id: string;
  user_id: string;
  state: 'closed' | 'cancelled' | 'completed';
  reason: AccountClosureReason;
  reference: string | null;
  person_requested: boolean;
  requested_by_host_actor: string;
  payload_hash: string;
  created_at: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
  erasure_request_id: string | null;
  erasure_state: 'scheduled' | 'running' | 'completed' | 'cancelled' | null;
  execute_after: Date | null;
  held: boolean;
  waits_on_takedown: boolean;
}

// The erasure's own state and what it waits on, read through the closure's request (`r`).
const CLOSURE_SQL = `SELECT ac.id,ac.user_id,ac.state,ac.reason,ac.reference,ac.person_requested,
  ac.requested_by_host_actor,ac.payload_hash,ac.created_at,ac.cancelled_at,ac.completed_at,
  ac.erasure_request_id,r.state AS erasure_state,r.execute_after,
  COALESCE(${ERASURE_WAITS_ON_LEGAL_HOLD_SQL},false) AS held,
  COALESCE(${ERASURE_WAITS_ON_TAKEDOWN_SQL},false) AS waits_on_takedown
  FROM account_closures ac LEFT JOIN erasure_requests r ON r.id=ac.erasure_request_id`;

/** Project a closure row onto the host wire shape. */
function project(row: ClosureRow): AccountClosureProjection {
  const [kind, ...rest] = row.requested_by_host_actor.split(':');
  const open = row.state === 'closed';
  return {
    closureId: row.id,
    accountId: row.user_id,
    state:
      row.state === 'completed'
        ? 'erased'
        : row.state === 'cancelled'
          ? 'cancelled'
          : row.erasure_state === 'running'
            ? 'erasing'
            : 'closed',
    reason: row.reason,
    reference: row.reference,
    personRequested: row.person_requested,
    actor: { kind: kind as 'person' | 'api_key', id: rest.join(':') },
    closedAt: row.created_at.toISOString(),
    eraseAfter: row.execute_after?.toISOString() ?? null,
    waitingOn:
      open && row.held ? 'legal_hold' : open && row.waits_on_takedown ? 'takedown_evidence' : null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    erasedAt: row.completed_at?.toISOString() ?? null,
  };
}

/**
 * The idempotency hash of a closure: everything the host chose, never the password. Keyed with
 * the account, so the same key used for another account is a conflict, not a replay.
 */
function closurePayloadHash(input: {
  accountId: string;
  reason: AccountClosureReason;
  reference: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        reason: input.reason,
        reference: input.reference,
      })
    )
    .digest('hex');
}

/** The account's newest closure, the open one when there is one; null when it has none. */
export async function readAccountClosure(
  db: Queryable,
  accountId: string
): Promise<AccountClosureProjection | null> {
  const result = await db.query<ClosureRow>(
    `${CLOSURE_SQL} WHERE ac.user_id=$1
     ORDER BY (ac.state='closed') DESC,ac.created_at DESC,ac.id DESC LIMIT 1`,
    [accountId]
  );
  return result.rows[0] ? project(result.rows[0]) : null;
}

async function readClosureById(client: PoolClient, id: string): Promise<AccountClosureProjection> {
  const result = await client.query<ClosureRow>(`${CLOSURE_SQL} WHERE ac.id=$1`, [id]);
  if (!result.rows[0]) throw new Error('The account closure could not be read back');
  return project(result.rows[0]);
}

/**
 * End every way the account reaches a community without signing in again: its sessions, its
 * installations' connection grants and unfinished pairings, and its agents' credentials. Agents
 * and memberships stay, so a cancelled closure leaves the person able to sign in and connect
 * again; the erasure removes the rest.
 */
async function endAccess(client: PoolClient, userId: string): Promise<void> {
  await client.query('DELETE FROM session WHERE "userId"=$1', [userId]);
  const mine = 'SELECT id FROM members WHERE user_id=$1';
  await client.query(
    `UPDATE connection_grants SET revoked_at=now()
     WHERE member_id IN (${mine}) AND revoked_at IS NULL`,
    [userId]
  );
  await client.query(
    `UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now())
     WHERE member_id IN (${mine}) AND consumed_at IS NULL`,
    [userId]
  );
  await client.query(
    `UPDATE agent_credentials SET revoked_at=now()
     WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id IN (${mine}))
       AND revoked_at IS NULL`,
    [userId]
  );
}

/**
 * Close an account, in the caller's transaction.
 *
 * It locks the account row first and then its member rows, the order a person's own account
 * erasure and an ownership transfer take them, so neither can race these checks. It refuses an
 * account that operates this host or still owns a community, and one already being erased. It
 * schedules the account's erasure after the ordinary window, or joins the person's own waiting
 * request, records the closure, ends the person's access, and writes one host audit row that
 * names the closure, never the account.
 *
 * A replay of the same actor's key with the same request returns the first closure
 * (`replayed: true`), even after the account is gone; the same key with a different request is
 * `409 IDEMPOTENCY_CONFLICT`.
 */
export async function closeAccount(
  client: PoolClient,
  input: AccountClosureRequest
): Promise<{ closure: AccountClosureProjection; replayed: boolean }> {
  const account = await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [
    input.accountId,
  ]);
  await assertHostActor(client, input.actor, input.now);
  // The account lock serializes every closure of one account; a replay of a closure whose
  // account is already gone has nothing left to race.
  const requester = hostActorRequester(input.actor);
  const hash = closurePayloadHash(input);
  const existing = await client.query<{ id: string; payload_hash: string }>(
    `SELECT id,payload_hash FROM account_closures
     WHERE requested_by_host_actor=$1 AND idempotency_key=$2`,
    [requester, input.idempotencyKey]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== hash)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'That idempotency key was used for a different request.'
      );
    return { closure: await readClosureById(client, existing.rows[0].id), replayed: true };
  }
  if (!account.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');

  const operator = await client.query('SELECT 1 FROM host_operators WHERE user_id=$1', [
    input.accountId,
  ]);
  if (operator.rowCount)
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This account has operated this host, so it cannot be closed.'
    );
  const memberships = await client.query<{ community_id: string; role: string; active: boolean }>(
    `SELECT community_id,role,active FROM members WHERE user_id=$1
     ORDER BY community_id,id FOR UPDATE`,
    [input.accountId]
  );
  const owned = memberships.rows
    .filter((row) => row.active && row.role === 'owner')
    .map((row) => row.community_id);
  if (owned.length)
    throw new ApiError(
      409,
      'ACCOUNT_OWNS_COMMUNITY',
      `This account owns ${owned.length === 1 ? 'community' : 'communities'} ${owned.join(', ')}. Replace the owner or delete ${owned.length === 1 ? 'that community' : 'those communities'} first.`
    );
  const open = await client.query(
    `SELECT 1 FROM account_closures WHERE user_id=$1 AND state='closed'`,
    [input.accountId]
  );
  if (open.rowCount) throw new ApiError(409, 'STATE_CONFLICT', 'This account is already closed.');

  const own = await client.query<{ id: string; state: 'scheduled' | 'running' }>(
    `SELECT id,state FROM erasure_requests
     WHERE kind='account' AND user_id=$1 AND state IN ('scheduled','running') FOR UPDATE`,
    [input.accountId]
  );
  if (own.rows[0]?.state === 'running')
    throw new ApiError(409, 'STATE_CONFLICT', 'This account is already being erased.');
  const erasureId =
    own.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        `INSERT INTO erasure_requests(kind,user_id,execute_after,next_attempt_at)
         VALUES('account',$1,now()+make_interval(hours=>$2),now()+make_interval(hours=>$2))
         RETURNING id`,
        [input.accountId, ERASURE_WINDOW_HOURS]
      )
    ).rows[0].id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO account_closures(
       user_id,erasure_request_id,reason,reference,person_requested,requested_by_host_actor,
       idempotency_key,payload_hash
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.accountId,
      erasureId,
      input.reason,
      input.reference,
      Boolean(own.rows[0]),
      requester,
      input.idempotencyKey,
      hash,
    ]
  );
  await endAccess(client, input.accountId);
  await recordHostAudit(client, input.actor, {
    action: 'account.close',
    nextState: 'closed',
    subjectAccountClosureId: inserted.rows[0].id,
  });
  return { closure: await readClosureById(client, inserted.rows[0].id), replayed: false };
}

/**
 * Cancel an account's open closure, in the caller's transaction. The person can sign in again
 * at once. The erasure the closure scheduled is cancelled with it; a request the person made
 * themselves keeps waiting, as they asked. Once the erasure has started it can no longer be
 * cancelled (`409`). Cancelling a cancelled closure returns it unchanged.
 *
 * It locks the account first, as the erasure's last step does, then the closure, then the
 * erasure request, so a cancel and the worker finishing the erasure never wait on each other in
 * a cycle; the worker's claim takes only the request, and a cancel that loses to it sees it running.
 */
export async function cancelAccountClosure(
  client: PoolClient,
  input: { accountId: string; actor: HostActor; now: Date }
): Promise<AccountClosureProjection> {
  await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [input.accountId]);
  await assertHostActor(client, input.actor, input.now);
  const found = await client.query<{
    id: string;
    state: 'closed' | 'cancelled' | 'completed';
    person_requested: boolean;
    erasure_request_id: string | null;
  }>(
    `SELECT id,state,person_requested,erasure_request_id FROM account_closures WHERE user_id=$1
     ORDER BY (state='closed') DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
    [input.accountId]
  );
  const closure = found.rows[0];
  if (!closure) throw new ApiError(404, 'NOT_FOUND', 'This account has not been closed.');
  if (closure.state === 'cancelled') return readClosureById(client, closure.id);
  if (closure.state === 'completed')
    throw new ApiError(409, 'STATE_CONFLICT', 'This account has already been erased.');
  const request = await client.query<{ state: string }>(
    'SELECT state FROM erasure_requests WHERE id=$1 FOR UPDATE',
    [closure.erasure_request_id]
  );
  if (request.rows[0]?.state !== 'scheduled')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The erasure has already started, so this closure can no longer be cancelled.'
    );
  if (!closure.person_requested)
    await client.query(
      `UPDATE erasure_requests SET state='cancelled',cancelled_at=now() WHERE id=$1`,
      [closure.erasure_request_id]
    );
  await client.query(
    `UPDATE account_closures SET state='cancelled',cancelled_at=now() WHERE id=$1`,
    [closure.id]
  );
  await recordHostAudit(client, input.actor, {
    action: 'account.close.cancel',
    priorState: 'closed',
    nextState: 'cancelled',
    subjectAccountClosureId: closure.id,
  });
  return readClosureById(client, closure.id);
}

/**
 * The account that signs in through this host's single sign-on with `subject`, or null. Only an
 * exact match on the identity the sign-in service gave this host.
 */
export async function findAccountBySignOn(
  db: Queryable,
  providerId: string,
  subject: string
): Promise<string | null> {
  const result = await db.query<{ userId: string }>(
    `SELECT "userId" FROM account WHERE "providerId"=$1 AND "accountId"=$2`,
    [providerId, subject]
  );
  return result.rows[0]?.userId ?? null;
}
