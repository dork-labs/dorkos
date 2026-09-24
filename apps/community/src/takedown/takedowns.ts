import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminTakedownCategorySchema,
  CommunityAdminTakedownEvidenceStateSchema,
  CommunityAdminTakedownSchema,
} from '@dorkos/shared/community-admin-wire';
import {
  deleteReadyExports,
  holdBlobs,
  queueBlobs,
  releaseHeldBlobs,
  removeAttachment,
  removeEntry,
} from '../content-removal.js';
import { buildEvidenceRecord, type EvidenceRecord } from './evidence/record.js';
import { snapshotTarget, type ItemTarget } from './evidence/snapshot.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuditActor,
} from '../host/authority.js';
import { ApiError } from '../http.js';

/** Why the host removed something. */
export type TakedownCategory = z.infer<typeof CommunityAdminTakedownCategorySchema>;
/** Where a takedown's evidence copy stands. */
export type EvidenceState = z.infer<typeof CommunityAdminTakedownEvidenceStateSchema>;
type Takedown = z.infer<typeof CommunityAdminTakedownSchema>;

/** Evidence states that keep a community from being deleted: the copy has not settled yet. */
export const UNSETTLED_EVIDENCE: readonly EvidenceState[] = [
  'pending',
  'retrying',
  'failed',
  'held_on_primary',
];

/** `SQL` for "this community has a takedown whose evidence has not settled", as `$1`. */
export const UNSETTLED_EVIDENCE_SQL = `EXISTS (SELECT 1 FROM community_takedowns t
  WHERE t.community_id=$1 AND t.evidence_state IN ('pending','retrying','failed','held_on_primary'))`;

/**
 * Categories whose material many laws require a host to preserve. With no evidence store, their
 * bytes are held on primary storage until a person releases them, never purged at once.
 */
const HELD_WITHOUT_STORE: ReadonlySet<TakedownCategory> = new Set(['child_safety', 'legal_order']);

/** One takedown row, as every read selects it. */
export interface TakedownRow {
  id: string;
  community_id: string;
  target_kind: 'entry' | 'attachment' | 'icon' | 'community';
  entry_id: string | null;
  attachment_id: string | null;
  category: TakedownCategory;
  reference: string | null;
  notify: boolean;
  actor_kind: 'person' | 'api_key';
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  payload_hash: string;
  state: 'active' | 'reversed';
  evidence_state: EvidenceState;
  evidence_location: string | null;
  evidence_record_sha256: string | null;
  evidence_attempts: number;
  created_at: Date;
  reversed_at: Date | null;
}

/** Every column {@link TakedownRow} names. */
export const TAKEDOWN_COLUMNS = `id,community_id,target_kind,entry_id,attachment_id,category,
  reference,notify,actor_kind,actor_user_id,actor_api_key_id,payload_hash,state,evidence_state,
  evidence_location,evidence_record_sha256,evidence_attempts,created_at,reversed_at`;

/**
 * A takedown as host authority sees it: ids and states only.
 *
 * @param overdueBefore Evidence still unsettled from a takedown made before this is overdue.
 */
export function projectTakedown(row: TakedownRow, overdueBefore: Date): Takedown {
  const target: Takedown['target'] =
    row.target_kind === 'entry'
      ? { kind: 'entry', entryId: row.entry_id! }
      : row.target_kind === 'attachment'
        ? { kind: 'attachment', attachmentId: row.attachment_id!, entryId: row.entry_id }
        : { kind: row.target_kind };
  return {
    id: row.id,
    communityId: row.community_id,
    target,
    category: row.category,
    reference: row.reference,
    notify: row.notify,
    actor: {
      kind: row.actor_kind,
      id: row.actor_kind === 'person' ? row.actor_user_id! : row.actor_api_key_id!,
    },
    state: row.state,
    evidence: {
      state: row.evidence_state,
      recordSha256: row.evidence_record_sha256,
      location: row.evidence_location,
      attempts: row.evidence_attempts,
      overdue:
        UNSETTLED_EVIDENCE.includes(row.evidence_state) &&
        row.created_at.getTime() <= overdueBefore.getTime(),
    },
    deleteAfter: null,
    createdAt: row.created_at.toISOString(),
    reversedAt: row.reversed_at?.toISOString() ?? null,
  };
}

/** Test seams inside the takedown transaction. */
export interface TakedownHooks {
  /** Runs after the community row is locked and before the actor is rechecked. */
  afterCommunityLock?: () => Promise<void>;
}

/** What one takedown request resolved to, before it is written. */
export interface ItemTakedownInput {
  communityId: string;
  actor: HostActor;
  target: ItemTarget;
  idempotencyKey: string;
  category: TakedownCategory;
  reference: string | null;
  /** The value used: the request's, or the category's default. */
  notify: boolean;
  /** Whether the host has an evidence store. */
  evidenceStore: boolean;
  publicUrl: string;
  now: Date;
}

/** `notify` as the request gave it, or false for `child_safety` and true for the rest. */
export function resolveNotify(category: TakedownCategory, notify: boolean | undefined): boolean {
  return notify ?? category !== 'child_safety';
}

/** A replay must name the same community and ask for exactly the same takedown. */
function takedownPayloadHash(input: ItemTakedownInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        communityId: input.communityId,
        target: input.target,
        category: input.category,
        reference: input.reference,
        notify: input.notify,
      })
    )
    .digest('hex');
}

function actorColumns(actor: HostActor): { kind: string; id: string } {
  return actor.kind === 'person'
    ? { kind: 'person', id: actor.userId }
    : { kind: 'api_key', id: actor.keyId };
}

/**
 * Take down one message, one file, or the community's icon, in one transaction: hide it at once
 * (the host tombstone, the file gone, the icon cleared), hold its bytes for the evidence copy or
 * queue them for deletion, delete every ready export, record the takedown with its staged
 * evidence, and audit it in the host audit and the community's own.
 *
 * Nothing it returns or throws carries content. A replay of the same actor's idempotency key
 * with the same request returns the first takedown (`replayed: true`).
 */
export async function createItemTakedown(
  client: PoolClient,
  input: ItemTakedownInput,
  hooks: TakedownHooks = {}
): Promise<{ row: TakedownRow; replayed: boolean }> {
  const lock = input.target.kind === 'icon' ? 'FOR UPDATE' : 'FOR SHARE';
  const locked = await client.query<{
    id: string;
    name: string;
    lifecycle: EvidenceRecord['community']['lifecycle'];
    icon_blob_key: string | null;
    icon_content_type: string | null;
  }>(
    `SELECT id,name,lifecycle,icon_blob_key,icon_content_type FROM communities
     WHERE id=$1 ${lock}`,
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
  // A deletion the worker has started is already removing bytes, so nothing could be held.
  const deletion = await client.query<{ state: string }>(
    'SELECT state FROM community_deletion_jobs WHERE community_id=$1',
    [community.id]
  );
  if (deletion.rows[0] && deletion.rows[0].state !== 'waiting')
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is already being deleted.');

  const snapshot = await snapshotTarget(client, community, input.target, {
    key: community.icon_blob_key,
    contentType: community.icon_content_type,
  });
  const evidenceState: EvidenceState = !snapshot.hasContent
    ? 'nothing_to_preserve'
    : input.evidenceStore
      ? 'pending'
      : HELD_WITHOUT_STORE.has(input.category)
        ? 'held_on_primary'
        : 'not_configured';
  const hold = evidenceState === 'pending' || evidenceState === 'held_on_primary';

  if (input.target.kind === 'entry') {
    await removeEntry(client, {
      communityId: community.id,
      entryId: input.target.entryId,
      removedBy: 'host',
      holdBlobs: hold,
    });
  } else if (input.target.kind === 'attachment') {
    await removeAttachment(client, {
      communityId: community.id,
      attachmentId: input.target.attachmentId,
      removedBy: 'host',
      holdBlobs: hold,
    });
  } else {
    // As removing an icon does: the settings version moves, so an open settings page reloads.
    await client.query(
      `UPDATE communities SET icon_blob_key=NULL,icon_content_type=NULL,
         settings_version=settings_version+1 WHERE id=$1`,
      [community.id]
    );
    if (hold) await holdBlobs(client, community.id, snapshot.blobKeys);
    else await queueBlobs(client, community.id, snapshot.blobKeys);
  }
  await deleteReadyExports(client, community.id);

  const id = randomUUID();
  const inserted = await client.query<TakedownRow>(
    `INSERT INTO community_takedowns(
       id,community_id,target_kind,entry_id,attachment_id,channel_id,subject_member_id,
       category,reference,notify,actor_kind,actor_user_id,actor_api_key_id,idempotency_key,
       payload_hash,evidence_state,next_attempt_at,created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       CASE WHEN $16='pending' THEN $17::timestamptz END,$17)
     RETURNING ${TAKEDOWN_COLUMNS}`,
    [
      id,
      community.id,
      input.target.kind,
      snapshot.entryId,
      input.target.kind === 'attachment' ? input.target.attachmentId : null,
      snapshot.channelId,
      snapshot.subjectMemberId,
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
    ]
  );
  if (hold) {
    // The whole record is staged now, while the rows still say who posted it: a later erasure
    // or sign-out cannot take the account or sessions out of the copy.
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
      content: snapshot.content,
    });
    await client.query(
      `INSERT INTO takedown_evidence_staging(takedown_id,record,blob_keys)
       VALUES($1,$2::jsonb,$3::text[])`,
      [id, JSON.stringify(record), snapshot.blobKeys]
    );
  }
  await recordHostAudit(client, input.actor, {
    action: 'takedown.create',
    communityId: community.id,
    nextState: evidenceState,
    changedFields: [input.target.kind, input.notify ? 'notified' : 'withheld'],
  });
  await client.query(
    `INSERT INTO audit_events(community_id,actor_kind,action,subject_id,withheld)
     VALUES($1,'host',$2,$3,$4)`,
    [community.id, `${input.target.kind}.takedown`, snapshot.subjectId, !input.notify]
  );
  return { row: inserted.rows[0], replayed: false };
}

/** Lock one takedown row for a change, or refuse with 404. */
export async function lockTakedown(client: PoolClient, takedownId: string): Promise<TakedownRow> {
  const row = await client.query<TakedownRow>(
    `SELECT ${TAKEDOWN_COLUMNS} FROM community_takedowns WHERE id=$1 FOR UPDATE`,
    [takedownId]
  );
  if (!row.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Takedown not found.');
  return row.rows[0];
}

/**
 * Send a failed or held evidence copy back to the worker. Needs an evidence store: a held copy
 * waits for one, and a failed one can only succeed with one.
 */
export async function retryTakedownEvidence(
  client: PoolClient,
  input: { takedownId: string; actor: HostAuditActor; evidenceStore: boolean; now: Date }
): Promise<TakedownRow> {
  const row = await lockTakedown(client, input.takedownId);
  if (input.actor.kind === 'person' || input.actor.kind === 'api_key')
    await assertHostActor(client, input.actor, input.now);
  if (row.evidence_state !== 'failed' && row.evidence_state !== 'held_on_primary')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'Only a failed or held evidence copy can be retried.'
    );
  if (!input.evidenceStore)
    throw new ApiError(409, 'STATE_CONFLICT', 'Set an evidence store first, then try again.');
  const updated = await client.query<TakedownRow>(
    `UPDATE community_takedowns SET evidence_state='pending',evidence_failures=0,
       next_attempt_at=$2,lease_until=NULL
     WHERE id=$1 RETURNING ${TAKEDOWN_COLUMNS}`,
    [row.id, input.now]
  );
  await recordHostAudit(client, input.actor, {
    action: 'takedown.evidence_retry',
    communityId: row.community_id,
    priorState: row.evidence_state,
    nextState: 'pending',
    changedFields: ['evidence'],
  });
  return updated.rows[0];
}

/**
 * Release the bytes a takedown holds to deletion, without a copy: the evidence becomes
 * `not_configured` and the staged record is dropped.
 *
 * A host operator may release only bytes held on this server for want of a store
 * (`held_on_primary`). The offline command (`offline: true`) may release any unsettled copy,
 * which is how a host backs out this feature.
 */
export async function releaseHeldEvidence(
  client: PoolClient,
  input: { takedownId: string; actor: HostAuditActor; now: Date }
): Promise<TakedownRow> {
  const row = await lockTakedown(client, input.takedownId);
  if (input.actor.kind === 'person' || input.actor.kind === 'api_key')
    await assertHostActor(client, input.actor, input.now);
  const releasable: readonly EvidenceState[] =
    input.actor.kind === 'offline' ? UNSETTLED_EVIDENCE : ['held_on_primary'];
  if (!releasable.includes(row.evidence_state))
    throw new ApiError(409, 'STATE_CONFLICT', 'This takedown holds nothing to release.');
  const staged = await client.query<{ blob_keys: string[] }>(
    'DELETE FROM takedown_evidence_staging WHERE takedown_id=$1 RETURNING blob_keys',
    [row.id]
  );
  await releaseHeldBlobs(client, row.community_id, staged.rows[0]?.blob_keys ?? []);
  const updated = await client.query<TakedownRow>(
    `UPDATE community_takedowns SET evidence_state='not_configured',next_attempt_at=NULL,
       lease_until=NULL
     WHERE id=$1 RETURNING ${TAKEDOWN_COLUMNS}`,
    [row.id]
  );
  await recordHostAudit(client, input.actor, {
    action: 'takedown.release_held',
    communityId: row.community_id,
    priorState: row.evidence_state,
    nextState: 'not_configured',
    changedFields: ['evidence'],
  });
  return updated.rows[0];
}

/** One page of takedowns, newest first, optionally in one community. */
export async function listTakedowns(
  pool: Pool,
  input: { communityId: string | null; after: string | null; limit: number }
): Promise<{ rows: TakedownRow[]; nextAfter: string | null }> {
  const rows = await pool.query<TakedownRow>(
    `SELECT ${TAKEDOWN_COLUMNS} FROM community_takedowns t
     WHERE ($1::uuid IS NULL OR t.community_id=$1)
       AND ($2::uuid IS NULL OR (t.created_at,t.id) < (
         SELECT created_at,id FROM community_takedowns WHERE id=$2))
     ORDER BY t.created_at DESC,t.id DESC LIMIT $3`,
    [input.communityId, input.after, input.limit + 1]
  );
  const page = rows.rows.slice(0, input.limit);
  return {
    rows: page,
    nextAfter: rows.rows.length > input.limit ? page[page.length - 1].id : null,
  };
}
