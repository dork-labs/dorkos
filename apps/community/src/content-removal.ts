import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from './http.js';

/**
 * The text a removed message shows in place of what it said, by who removed it. The kind of
 * remover is shown, never the person.
 */
export const REMOVED_ENTRY_TEXT = {
  author: 'This message was deleted.',
  moderator: 'This message was removed by a community admin.',
  host: 'This message was removed by the host.',
} as const;

/** Who removed a message or file: its author (or their agent), an owner or admin, or the host. */
export type RemovedBy = keyof typeof REMOVED_ENTRY_TEXT;

/** A named, content-free reason a content change could not be made. */
export class ContentChangeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ContentChangeError';
  }
}

/** Test seams inside one removal transaction. */
export interface ContentRemovalHooks {
  /** Runs after the content version is bumped and before any redaction row is written. */
  afterVersionBump?: () => Promise<void>;
}

/**
 * SHA-256 of a tombstoned entry's payload, in the shape a post hashes its own payload, so the
 * stored hash says nothing about what the entry used to say.
 */
export function tombstonePayloadHash(text: string, parentEntryId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ text, mentions: [], parentEntryId, attachmentIds: [] }))
    .digest('hex');
}

/**
 * Bump the community's content version, which takes that row's lock and holds it to commit.
 *
 * Every transaction that writes `entry_redactions` rows calls this first. An identity value is
 * assigned at insert, not at commit, so two changes that each inserted before locking could
 * commit in the opposite order of their ids, and a reader that saved cursor `N+1` would never
 * see row `N`. Taking this lock first serializes every content change in a community, so
 * redaction ids become visible in the order they were assigned.
 */
export async function bumpContentVersion(client: PoolClient, communityId: string): Promise<void> {
  const bumped = await client.query(
    'UPDATE community_content_versions SET version=version+1 WHERE community_id=$1',
    [communityId]
  );
  if (bumped.rowCount !== 1) throw new ContentChangeError('CONTENT_VERSION_MISSING');
}

/**
 * Queue blobs for deletion in the transaction that removed the rows naming them. Storage
 * limits count only `stored` and `committed` blobs, so the space is freed at commit; the
 * pending-deletion sweep removes the bytes and then the inventory row with its checksum.
 */
export async function queueBlobs(
  client: PoolClient,
  communityId: string,
  keys: readonly string[]
): Promise<void> {
  if (!keys.length) return;
  // The same two statements queueCommittedBlobDeletion and discardManagedBlob run.
  await client.query(
    `UPDATE managed_blobs SET state='pending_delete'
     WHERE community_id=$1 AND blob_key=ANY($2::text[]) AND state IN ('committed','stored')`,
    [communityId, keys]
  );
  await client.query(
    `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
     SELECT key,0,now() FROM unnest($1::text[]) AS key ON CONFLICT(blob_key) DO NOTHING`,
    [keys]
  );
}

/**
 * Record one redaction row per changed entry, for the redaction feed. The caller has already
 * bumped the content version in this transaction ({@link bumpContentVersion}).
 */
export async function recordRedactions(
  client: PoolClient,
  communityId: string,
  changed: readonly { entryId: string; channelId: string }[]
): Promise<void> {
  if (!changed.length) return;
  await client.query(
    `INSERT INTO entry_redactions(community_id,channel_id,entry_id)
     SELECT $1,changed.channel_id,changed.id
     FROM unnest($2::uuid[],$3::uuid[]) AS changed(id,channel_id)`,
    [communityId, changed.map((row) => row.entryId), changed.map((row) => row.channelId)]
  );
}

/**
 * Tombstone a batch of locked entries for member erasure: the erased text and author name, a
 * retired idempotency key, the tombstone payload hash, and no mentions. Files are erased in an
 * earlier step; the caller bumps the version and records the redaction rows.
 */
export async function eraseEntries(
  client: PoolClient,
  communityId: string,
  rows: readonly { id: string; parentEntryId: string | null }[],
  tombstone: { text: string; memberName: string; agentName: string }
): Promise<void> {
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  await client.query(
    `UPDATE entries e SET text=$2,
       author_display_name=CASE WHEN e.author_agent_id IS NULL THEN $3 ELSE $4 END,
       idempotency_key='erased:' || e.id::text,payload_hash=erased.hash,erased_at=now()
     FROM unnest($5::uuid[],$6::text[]) AS erased(id,hash)
     WHERE e.id=erased.id AND e.community_id=$1`,
    [
      communityId,
      tombstone.text,
      tombstone.memberName,
      tombstone.agentName,
      ids,
      rows.map((row) => tombstonePayloadHash(tombstone.text, row.parentEntryId)),
    ]
  );
  await client.query(
    'DELETE FROM entry_mentions WHERE community_id=$1 AND entry_id=ANY($2::uuid[])',
    [communityId, ids]
  );
}

/** Replace one locked entry's text and payload hash with a removal tombstone, and drop its mentions. */
async function tombstoneRemoved(
  client: PoolClient,
  communityId: string,
  entry: { id: string; parent_entry_id: string | null },
  removedBy: RemovedBy
): Promise<void> {
  const text = REMOVED_ENTRY_TEXT[removedBy];
  await client.query(
    `UPDATE entries SET text=$3,payload_hash=$4,removed_at=now(),removed_by=$5
     WHERE id=$2 AND community_id=$1`,
    [communityId, entry.id, text, tombstonePayloadHash(text, entry.parent_entry_id), removedBy]
  );
  await client.query('DELETE FROM entry_mentions WHERE community_id=$1 AND entry_id=$2', [
    communityId,
    entry.id,
  ]);
}

interface LockedEntry {
  id: string;
  channel_id: string;
  parent_entry_id: string | null;
  text: string;
  removed_at: Date | null;
  erased_at: Date | null;
}

async function lockEntry(
  client: PoolClient,
  communityId: string,
  entryId: string
): Promise<LockedEntry | null> {
  // FOR NO KEY UPDATE, not FOR UPDATE: a reply holds FOR KEY SHARE on its parent while it holds
  // its channel, and a removal never changes an entry's key.
  const result = await client.query<LockedEntry>(
    `SELECT id,channel_id,parent_entry_id,text,removed_at,erased_at FROM entries
     WHERE id=$2 AND community_id=$1 FOR NO KEY UPDATE`,
    [communityId, entryId]
  );
  return result.rows[0] ?? null;
}

/**
 * Replace an entry's content with a tombstone and remove its mentions and files, in place. The
 * entry keeps its id, sequence, thread links, author, time, and idempotency key.
 *
 * The caller has taken the community row `FOR SHARE` and checked the lifecycle and the actor.
 * An entry already removed or erased is left as it is (`changed: false`): erasure wins over a
 * removal, and a repeat changes nothing.
 *
 * @throws ApiError 404 when the entry is not in this community.
 */
export async function removeEntry(
  client: PoolClient,
  input: { communityId: string; entryId: string; removedBy: RemovedBy },
  hooks: ContentRemovalHooks = {}
): Promise<{ changed: boolean; channelId: string; blobKeys: string[] }> {
  const entry = await lockEntry(client, input.communityId, input.entryId);
  if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
  if (entry.removed_at || entry.erased_at)
    return { changed: false, channelId: entry.channel_id, blobKeys: [] };
  await bumpContentVersion(client, input.communityId);
  await hooks.afterVersionBump?.();
  await tombstoneRemoved(client, input.communityId, entry, input.removedBy);
  const files = await client.query<{ blob_key: string }>(
    'DELETE FROM attachments WHERE community_id=$1 AND entry_id=$2 RETURNING blob_key',
    [input.communityId, entry.id]
  );
  const blobKeys = files.rows.map((row) => row.blob_key);
  await queueBlobs(client, input.communityId, blobKeys);
  await recordRedactions(client, input.communityId, [
    { entryId: entry.id, channelId: entry.channel_id },
  ]);
  return { changed: true, channelId: entry.channel_id, blobKeys };
}

/**
 * Remove one file and queue its bytes for deletion. A file bound to a message is taken out of
 * it; the message is tombstoned when it has no text and no other file left. An upload that was
 * never posted belongs to no message, so no version bump and no redaction row are needed.
 *
 * The caller has taken the community row `FOR SHARE` and checked the lifecycle and the actor.
 *
 * @throws ApiError 404 when the file is not in this community (or is already gone).
 */
export async function removeAttachment(
  client: PoolClient,
  input: { communityId: string; attachmentId: string; removedBy: RemovedBy },
  hooks: ContentRemovalHooks = {}
): Promise<{ entryId: string | null; entryTombstoned: boolean; blobKeys: string[] }> {
  // A post that binds an unbound upload takes this same row lock, so once it is held the
  // binding read from the locked row cannot change under the removal.
  const locked = await client.query<{ entry_id: string | null; blob_key: string }>(
    'SELECT entry_id,blob_key FROM attachments WHERE id=$2 AND community_id=$1 FOR UPDATE',
    [input.communityId, input.attachmentId]
  );
  const attachment = locked.rows[0];
  if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  const blobKeys = [attachment.blob_key];
  if (!attachment.entry_id) {
    await client.query('DELETE FROM attachments WHERE id=$2 AND community_id=$1', [
      input.communityId,
      input.attachmentId,
    ]);
    await queueBlobs(client, input.communityId, blobKeys);
    return { entryId: null, entryTombstoned: false, blobKeys };
  }
  const entry = await lockEntry(client, input.communityId, attachment.entry_id);
  if (!entry) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  await bumpContentVersion(client, input.communityId);
  await hooks.afterVersionBump?.();
  await client.query('DELETE FROM attachments WHERE id=$2 AND community_id=$1', [
    input.communityId,
    input.attachmentId,
  ]);
  await queueBlobs(client, input.communityId, blobKeys);
  const others = await client.query(
    'SELECT 1 FROM attachments WHERE community_id=$1 AND entry_id=$2 LIMIT 1',
    [input.communityId, entry.id]
  );
  const tombstone = !entry.removed_at && !entry.erased_at && !entry.text && !others.rowCount;
  if (tombstone) await tombstoneRemoved(client, input.communityId, entry, input.removedBy);
  await recordRedactions(client, input.communityId, [
    { entryId: entry.id, channelId: entry.channel_id },
  ]);
  return { entryId: entry.id, entryTombstoned: tombstone, blobKeys };
}

/** The acting principal, as the rank rule sees it. */
export interface RemovalActor {
  kind: 'human' | 'agent';
  /** The member id, or the agent id for an agent credential. */
  id: string;
  /** The member's current role; for an agent, its owner's (unused by the rule). */
  role: 'owner' | 'admin' | 'member';
}

/** The content being removed, ranked by its human. */
export interface RemovalTarget {
  /** The authoring or uploading agent, when an agent made it. */
  agentId: string | null;
  /** The member the content counts as: its author, or its author agent's owner. */
  humanId: string;
  /** That member's role now. */
  humanRole: 'owner' | 'admin' | 'member';
  /** Whether that member is still an active member. */
  humanActive: boolean;
}

/**
 * Decide whether an actor may remove a message or file, and as whom.
 *
 * Content is ranked by its human: an agent's content counts as its owner's. An agent credential
 * may remove only what it made; a member what they or their agents made; an admin also anything
 * whose human is neither the owner nor an active admin; the owner anything.
 *
 * @returns `author` when the actor removes their own (or their agent's) content, `moderator`
 *   when an owner or admin removes someone else's, or `null` when refused.
 */
export function removalAuthority(actor: RemovalActor, target: RemovalTarget): RemovedBy | null {
  if (actor.kind === 'agent') return target.agentId === actor.id ? 'author' : null;
  if (target.humanId === actor.id) return 'author';
  if (actor.role === 'owner') return 'moderator';
  const protectedHuman =
    target.humanRole === 'owner' || (target.humanRole === 'admin' && target.humanActive);
  if (actor.role === 'admin' && !protectedHuman) return 'moderator';
  return null;
}
