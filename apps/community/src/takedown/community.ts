import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { endExportJob, deleteReadyExports } from '../exports/store.js';
import { revokeTenantAccess } from '../host/communities.js';
import {
  assertHostActor,
  hostActorRequester,
  recordHostAudit,
  type HostActor,
} from '../host/authority.js';
import { ApiError, RateLimited } from '../http.js';
import { queueEvidenceExport } from './evidence-export.js';
import {
  buildEvidenceRecord,
  readEvidenceAccount,
  type EvidenceRecord,
} from './evidence/record.js';
import {
  actorColumns,
  HELD_WITHOUT_STORE,
  lockTakedown,
  TAKEDOWN_COLUMNS,
  takedownPayloadHash,
  type EvidenceState,
  type TakedownCategory,
  type TakedownHooks,
  type TakedownRow,
} from './takedowns.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type Lifecycle =
  'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';

/** The community row a community takedown locks and records. */
interface CommunityRow {
  id: string;
  name: string;
  lifecycle: Lifecycle;
  lifecycle_version: number;
  suspended_from_state: 'active' | 'archived' | 'held' | null;
  held_from_state: 'active' | 'archived' | null;
  deletion_from_state: 'active' | 'archived' | 'suspended' | 'held' | null;
  deletion_from_prior_state: 'active' | 'archived' | 'held' | null;
  delete_requested_by: string | null;
  delete_requested_by_host_actor: string | null;
  takedown_id: string | null;
}

/**
 * Where the community stood before its takedown, kept on the takedown row: what a reversal
 * restores, what the evidence archive records as the lifecycle, and who (if anyone) had already
 * asked for its deletion.
 */
export interface TakedownPriorState {
  lifecycle: Exclude<Lifecycle, 'pending_owner'>;
  suspendedFromState: CommunityRow['suspended_from_state'];
  heldFromState: CommunityRow['held_from_state'];
  deletionFromState: CommunityRow['deletion_from_state'];
  deletionFromPriorState: CommunityRow['deletion_from_prior_state'];
  /** Who asked for a deletion already pending at the takedown, or null. */
  deletionRequestedBy: 'owner' | 'host' | null;
}

/** What one whole-community takedown request resolved to, before it is written. */
export interface CommunityTakedownInput {
  communityId: string;
  actor: HostActor;
  target: { kind: 'community'; lifecycleVersion: number; confirmIdSuffix: string };
  idempotencyKey: string;
  category: TakedownCategory;
  reference: string | null;
  notify: boolean;
  evidenceStore: boolean;
  publicUrl: string;
  now: Date;
  /** `COMMUNITY_TAKEDOWN_REVERSAL_HOURS`. */
  reversalHours: number;
  /** `COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY`. */
  communitiesPerDay: number;
  /** Receives the warning line a refusal by the rate limit logs. */
  warn: (line: string) => void;
}

/**
 * The warning line every community takedown, and every refusal by the rate limit, logs for a
 * host's alerting: ids only.
 */
export function communityTakedownLogLine(event: {
  outcome: 'created' | 'rate_limited';
  communityId: string;
  actor: HostActor;
  takedownId?: string;
}): string {
  const actor = actorColumns(event.actor);
  return JSON.stringify({
    event: 'community.takedown.community',
    outcome: event.outcome,
    communityId: event.communityId,
    actorKind: actor.kind,
    actorId: actor.id,
    ...(event.takedownId ? { takedownId: event.takedownId } : {}),
  });
}

/**
 * The accounts the evidence record keeps, read at the takedown, and no more than it needs:
 * every member active at the takedown, with each current session's start, IP address, and user
 * agent; and a former member only while content they (or their agents) posted is still in the
 * community, without sessions. An erased member has no account and is left out.
 */
async function readMemberAccounts(
  client: PoolClient,
  communityId: string
): Promise<NonNullable<EvidenceRecord['accounts']>> {
  const members = await client.query<{ id: string; user_id: string; active: boolean }>(
    `SELECT m.id,m.user_id,m.active FROM members m
     WHERE m.community_id=$1 AND m.user_id IS NOT NULL
       AND (m.active OR EXISTS (
         SELECT 1 FROM entries e
         WHERE e.community_id=m.community_id AND e.removed_at IS NULL AND e.erased_at IS NULL
           AND (e.author_member_id=m.id OR e.author_agent_id IN (
             SELECT a.id FROM agents a
             WHERE a.community_id=m.community_id AND a.owner_member_id=m.id))))
     ORDER BY m.id`,
    [communityId]
  );
  const accounts: NonNullable<EvidenceRecord['accounts']> = [];
  for (const member of members.rows) {
    const account = await readEvidenceAccount(client, member.user_id);
    if (account)
      accounts.push({
        memberId: member.id,
        account: member.active ? account : { ...account, sessions: [] },
      });
  }
  return accounts;
}

/**
 * Take a whole community down, in one transaction: revoke every credential, make it a pending
 * deletion whose requester is the host and whose deletion waits out the reversal window, delete
 * every ready export and cancel every other one, record the takedown with what the community was
 * before, and preserve it: an evidence export is queued (with an evidence store), and every
 * member's account and sessions are staged as they are now. With no store, `child_safety` and
 * `legal_order` keep everything on this server (`held_on_primary`) until a person releases it.
 *
 * A replay of the same actor's idempotency key with the same request returns the first
 * takedown (`replayed: true`). Nothing it returns or throws carries content.
 */
export async function createCommunityTakedown(
  client: PoolClient,
  input: CommunityTakedownInput,
  hooks: TakedownHooks = {}
): Promise<{ row: TakedownRow; replayed: boolean }> {
  const locked = await client.query<CommunityRow>(
    `SELECT id,name,lifecycle,lifecycle_version,suspended_from_state,held_from_state,
            deletion_from_state,deletion_from_prior_state,delete_requested_by,
            delete_requested_by_host_actor,takedown_id
     FROM communities WHERE id=$1 FOR UPDATE`,
    [input.communityId]
  );
  await hooks.afterCommunityLock?.();
  await assertHostActor(client, input.actor, input.now);
  const actor = actorColumns(input.actor);
  // Two requests with one actor's key serialize here, so exactly one of them writes.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `takedown:${actor.kind}:${actor.id}:${input.idempotencyKey}`,
  ]);
  const hash = takedownPayloadHash(input);
  const existing = await client.query<TakedownRow>(
    `SELECT ${TAKEDOWN_COLUMNS} FROM community_takedowns
     WHERE actor_kind=$1 AND COALESCE(actor_user_id,actor_api_key_id::text)=$2
       AND idempotency_key=$3`,
    [actor.kind, actor.id, input.idempotencyKey]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== hash)
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'That takedown key has different inputs.');
    return { row: existing.rows[0], replayed: true };
  }
  const community = locked.rows[0];
  if (!community) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  if (community.lifecycle === 'pending_owner')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'Nobody has claimed this community, so it has no content. Abandon it instead.'
    );
  if (
    community.lifecycle_version !== input.target.lifecycleVersion ||
    community.id.slice(-8) !== input.target.confirmIdSuffix
  )
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The community changed, or the confirmation did not match. Check it and try again.'
    );
  if (community.takedown_id)
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is already taken down.');
  const deletion = await client.query<{ state: string }>(
    'SELECT state FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE',
    [community.id]
  );
  if (deletion.rows[0] && deletion.rows[0].state !== 'waiting')
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is already being deleted.');

  // The rate limit counts every community takedown this actor made in the last day, reversed
  // ones too: a leaked key cannot take down and reverse its way past it. The count runs under a
  // per-actor lock held to commit, so parallel requests from one actor count one after another
  // (at READ COMMITTED each sees the takedowns committed before it). Lock order is always the
  // community row, then this actor lock: a takedown holds at most one of each, so two of them
  // can wait on each other's actor lock only after taking different communities, never in a
  // cycle.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `takedown-rate:${actor.kind}:${actor.id}`,
  ]);
  const recent = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM community_takedowns
     WHERE target_kind='community' AND actor_kind=$1
       AND COALESCE(actor_user_id,actor_api_key_id::text)=$2
       AND created_at>$3::timestamptz - interval '24 hours'
     ORDER BY created_at`,
    [actor.kind, actor.id, input.now]
  );
  if (recent.rows.length >= input.communitiesPerDay) {
    input.warn(
      communityTakedownLogLine({
        outcome: 'rate_limited',
        communityId: community.id,
        actor: input.actor,
      })
    );
    const frees = recent.rows[recent.rows.length - input.communitiesPerDay].created_at;
    throw new RateLimited(
      'You have taken down as many communities today as this host allows.',
      Math.max(1, Math.ceil((frees.getTime() + DAY_MS - input.now.getTime()) / 1000))
    );
  }

  const prior: TakedownPriorState = {
    lifecycle: community.lifecycle,
    suspendedFromState: community.suspended_from_state,
    heldFromState: community.held_from_state,
    deletionFromState: community.deletion_from_state,
    deletionFromPriorState: community.deletion_from_prior_state,
    deletionRequestedBy: community.delete_requested_by_host_actor
      ? 'host'
      : community.delete_requested_by
        ? 'owner'
        : null,
  };
  await revokeTenantAccess(client, community.id);
  const id = randomUUID();
  const requester = hostActorRequester(input.actor);
  const deleteAfter = new Date(input.now.getTime() + input.reversalHours * HOUR_MS);
  // Entering deletion_pending records where it came from, as an owner's or host's deletion
  // does; an already pending deletion keeps its origin. Either way the host is now its only
  // requester, so the owner can no longer cancel it.
  const updated = await client.query<{ lifecycle_version: number }>(
    `UPDATE communities SET
       deletion_from_state=CASE WHEN lifecycle='deletion_pending' THEN deletion_from_state
         ELSE lifecycle END,
       deletion_from_prior_state=CASE WHEN lifecycle='deletion_pending'
         THEN deletion_from_prior_state
         WHEN lifecycle='suspended' THEN suspended_from_state
         WHEN lifecycle='held' THEN held_from_state END,
       lifecycle='deletion_pending',suspended_from_state=NULL,suspended_at=NULL,
       deletion_notice_at=NULL,delete_requested_at=$2,delete_after=$3,delete_requested_by=NULL,
       delete_requested_by_host_actor=$4,takedown_id=$5,lifecycle_version=lifecycle_version+1
     WHERE id=$1 RETURNING lifecycle_version`,
    [community.id, input.now, deleteAfter, requester, id]
  );
  await client.query(
    `INSERT INTO community_deletion_jobs(
       community_id,requested_by_host_actor,lifecycle_version,delete_after,next_attempt_at,
       takedown_id
     ) VALUES($1,$2,$3,$4,$4,$5)
     ON CONFLICT(community_id) DO UPDATE SET requested_by_member_id=NULL,
       requested_by_host_actor=EXCLUDED.requested_by_host_actor,
       lifecycle_version=EXCLUDED.lifecycle_version,delete_after=EXCLUDED.delete_after,
       next_attempt_at=EXCLUDED.next_attempt_at,takedown_id=EXCLUDED.takedown_id,
       state='waiting',updated_at=now()`,
    [community.id, requester, updated.rows[0].lifecycle_version, deleteAfter, id]
  );

  // No archive anyone can download keeps the community: ready ones are deleted, and one still
  // being prepared is cancelled. Only the evidence export below runs from now on.
  await deleteReadyExports(client, community.id);
  const open = await client.query<{ id: string }>(
    `SELECT id FROM export_archives
     WHERE community_id=$1 AND state IN ('queued','building') AND scope<>'evidence' FOR UPDATE`,
    [community.id]
  );
  for (const job of open.rows)
    await endExportJob(client, job.id, { state: 'cancelled' }, input.now);

  const evidenceState: EvidenceState = input.evidenceStore
    ? 'pending'
    : HELD_WITHOUT_STORE.has(input.category)
      ? 'held_on_primary'
      : 'not_configured';
  const inserted = await client.query<TakedownRow>(
    `INSERT INTO community_takedowns(
       id,community_id,target_kind,category,reference,notify,actor_kind,actor_user_id,
       actor_api_key_id,idempotency_key,payload_hash,evidence_state,next_attempt_at,created_at,
       prior_state,delete_after
     ) VALUES($1,$2,'community',$3,$4,$5,$6,$7,$8,$9,$10,$11,
       CASE WHEN $11='pending' THEN $12::timestamptz END,$12,$13::jsonb,$14)
     RETURNING ${TAKEDOWN_COLUMNS}`,
    [
      id,
      community.id,
      input.category,
      input.reference,
      input.notify,
      actor.kind,
      input.actor.kind === 'person' ? input.actor.userId : null,
      input.actor.kind === 'api_key' ? input.actor.keyId : null,
      input.idempotencyKey,
      hash,
      evidenceState,
      input.now,
      JSON.stringify(prior),
      deleteAfter,
    ]
  );
  if (evidenceState !== 'not_configured') {
    // Every member's account is staged now, while it is still there: the archive holds member
    // rows, not accounts, and a later erasure or sign-out cannot take these out of the copy.
    const record = buildEvidenceRecord({
      takedown: {
        id,
        createdAt: input.now,
        actor: input.actor,
        category: input.category,
        reference: input.reference,
        notify: input.notify,
      },
      publicUrl: input.publicUrl,
      content: {
        community: { id: community.id, name: community.name, lifecycle: prior.lifecycle },
        channel: null,
        entry: null,
        author: null,
        account: null,
        files: [],
        icon: null,
        archive: null,
        accounts: await readMemberAccounts(client, community.id),
      },
    });
    await client.query(
      `INSERT INTO takedown_evidence_staging(takedown_id,record,blob_keys)
       VALUES($1,$2::jsonb,'{}'::text[])`,
      [id, JSON.stringify(record)]
    );
  }
  if (evidenceState === 'pending')
    await queueEvidenceExport(client, { id, communityId: community.id });
  await recordHostAudit(client, input.actor, {
    action: 'takedown.create',
    communityId: community.id,
    priorState: community.lifecycle,
    nextState: evidenceState,
    changedFields: ['community', input.notify ? 'notified' : 'withheld'],
  });
  return { row: inserted.rows[0], replayed: false };
}

/**
 * Reverse a whole-community takedown within its window: the community becomes `suspended`
 * (never live in one step), from the state it was in before the takedown, its pending deletion
 * is cancelled, and the takedown is marked `reversed`. Credentials stay revoked; the host resumes
 * the community when it is ready. The evidence copy goes on: an export in progress finishes and
 * is stored on the reversed takedown, and stored evidence is kept.
 *
 * Refused (`409`) for a message, file, or icon (their content is gone), once the window has
 * ended or the deletion has started, and for a takedown of a deletion the owner had already
 * asked for (the host cannot undo the owner's own decision).
 */
export async function reverseCommunityTakedown(
  client: PoolClient,
  input: {
    takedownId: string;
    actor: HostActor;
    lifecycleVersion: number;
    now: Date;
    /** Test seam: after the takedown and community are locked. */
    afterLock?: () => Promise<void>;
  }
): Promise<TakedownRow> {
  // The community first, then the takedown: the order a takedown itself takes them in.
  const target = await client.query<{ community_id: string; target_kind: string }>(
    'SELECT community_id,target_kind FROM community_takedowns WHERE id=$1',
    [input.takedownId]
  );
  if (!target.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Takedown not found.');
  const community = await client.query<{
    lifecycle: Lifecycle;
    lifecycle_version: number;
    takedown_id: string | null;
  }>('SELECT lifecycle,lifecycle_version,takedown_id FROM communities WHERE id=$1 FOR UPDATE', [
    target.rows[0].community_id,
  ]);
  const row = await lockTakedown(client, input.takedownId);
  await input.afterLock?.();
  await assertHostActor(client, input.actor, input.now);
  if (row.target_kind !== 'community')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'A removed message, file, or icon cannot be restored: it is gone.'
    );
  if (row.state === 'reversed')
    throw new ApiError(409, 'STATE_CONFLICT', 'This takedown was already reversed.');
  const current = community.rows[0];
  if (!current || current.takedown_id !== row.id)
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is already deleted.');
  if (current.lifecycle_version !== input.lifecycleVersion)
    throw new ApiError(409, 'STATE_CONFLICT', 'Community lifecycle changed.');
  const job = await client.query<{ state: string; delete_after: Date }>(
    'SELECT state,delete_after FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE',
    [row.community_id]
  );
  if (
    !job.rows[0] ||
    job.rows[0].state !== 'waiting' ||
    job.rows[0].delete_after.getTime() <= input.now.getTime()
  )
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The reversal window has ended. This community is being deleted.'
    );
  const prior = (
    await client.query<{ prior_state: TakedownPriorState }>(
      'SELECT prior_state FROM community_takedowns WHERE id=$1',
      [row.id]
    )
  ).rows[0].prior_state;
  if (prior.lifecycle === 'deletion_pending' && prior.deletionRequestedBy !== 'host')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The owner had already asked to delete this community. A takedown of it cannot be reversed.'
    );
  const suspendedFrom = reversalSuspendedFrom(prior);
  // Clearing the lifecycle clears the deletion origin (a trigger); held_from_state stays exactly
  // when the community was under a hold, which the hold check requires of a suspension from it.
  await client.query(
    `UPDATE communities SET lifecycle='suspended',suspended_from_state=$2,suspended_at=$3,
       delete_requested_at=NULL,delete_after=NULL,delete_requested_by=NULL,
       delete_requested_by_host_actor=NULL,takedown_id=NULL,
       lifecycle_version=lifecycle_version+1
     WHERE id=$1`,
    [row.community_id, suspendedFrom, input.now]
  );
  await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [
    row.community_id,
  ]);
  const reversed = await client.query<TakedownRow>(
    `UPDATE community_takedowns SET state='reversed',reversed_at=$2 WHERE id=$1
     RETURNING ${TAKEDOWN_COLUMNS}`,
    [row.id, input.now]
  );
  await recordHostAudit(client, input.actor, {
    action: 'takedown.reverse',
    communityId: row.community_id,
    priorState: 'deletion_pending',
    nextState: 'suspended',
    changedFields: ['lifecycle', 'delete_after'],
  });
  return reversed.rows[0];
}

/**
 * The state a reversed community is suspended from: the state it was in before the takedown.
 * A suspension restores its own origin, and a deletion the host had started (only ever from a
 * hold, directly or through a suspension of it) returns to that hold.
 */
export function reversalSuspendedFrom(prior: TakedownPriorState): 'active' | 'archived' | 'held' {
  if (prior.lifecycle !== 'suspended' && prior.lifecycle !== 'deletion_pending')
    return prior.lifecycle;
  // The lifecycle checks guarantee each origin below is set; a row without one is corrupt, and
  // guessing a state for it could reopen a community that should stay closed.
  const origin =
    prior.lifecycle === 'suspended'
      ? prior.suspendedFromState
      : prior.deletionFromState === 'suspended'
        ? prior.deletionFromPriorState
        : prior.deletionFromState === 'held'
          ? 'held'
          : null;
  if (!origin) throw new Error('A takedown recorded no state to return the community to');
  return origin;
}
