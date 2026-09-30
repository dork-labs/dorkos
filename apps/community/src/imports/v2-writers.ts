import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tombstonePayloadHash } from '../content-removal.js';
import { ERASED_ENTRY_TEXT, REMOVED_ENTRY_TEXT, type RemovedBy } from '../content/tombstones.js';
import { ERASED_AGENT_NAME, ERASED_MEMBER_NAME } from '../erasure/erasure.js';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import { ImportFailure, importedChannel } from './manifest.js';
import type { V2Collection } from './v2-archive.js';
import type { V2Row } from './v2-rows.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(condition: boolean): void {
  if (condition) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

/** Insert one batch of a step's rows in the caller's transaction. */
export type BatchWriter<K extends V2Collection> = (
  client: PoolClient,
  rows: V2Row[K][],
  scope: RestoreScope
) => Promise<void>;

/** What every batch writer needs: the community, the ID derivation, and the export. */
export interface RestoreScope {
  communityId: string;
  importId: string;
  derive: (sourceId: string) => string;
  ownerSourceId: string;
}

/** Refuse unless an `ON CONFLICT DO NOTHING` insert wrote every row: a duplicate in the export. */
function wroteAll(result: { rowCount: number | null }, expected: number): void {
  invalid((result.rowCount ?? 0) !== expected);
}

const insertRows = (client: PoolClient, sql: string, rows: unknown[], communityId: string) =>
  client.query(sql, [JSON.stringify(rows), communityId]);

const writeChannels: BatchWriter<'channels'> = async (client, rows, scope) => {
  wroteAll(
    await insertRows(
      client,
      // A channel's last_seq grows as its messages are restored, batch by batch.
      `INSERT INTO channels(id,community_id,name,description,visibility,archived,last_seq,epoch,created_at)
       SELECT r.id,$2,r.name,r.description,r.visibility,r.archived,0,1,r.created_at
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,name text,description text,visibility text,
         archived boolean,created_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map(importedChannel).map((channel) => ({
        id: scope.derive(channel.id),
        name: channel.name,
        description: channel.description,
        visibility: channel.visibility,
        archived: channel.archived,
        created_at: channel.created_at,
      })),
      scope.communityId
    ),
    rows.length
  );
};

/** Every handle stays reserved, so nobody can take a past author's name to impersonate them. */
async function writeHandles(
  client: PoolClient,
  handles: { handle: string; member_id: string | null; agent_id: string | null }[],
  communityId: string
): Promise<void> {
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO community_handles(community_id,handle,member_id,agent_id)
       SELECT $2,r.handle,r.member_id,r.agent_id
       FROM jsonb_to_recordset($1::jsonb) AS r(handle text,member_id uuid,agent_id uuid)
       ON CONFLICT DO NOTHING`,
      handles,
      communityId
    ),
    handles.length
  );
}

const writeMembers: BatchWriter<'members'> = async (client, rows, scope) => {
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO members(id,community_id,user_id,display_name,handle,role,active,created_at,removed_at,origin)
       SELECT r.id,$2,NULL,r.display_name,r.handle,r.role,false,r.created_at,r.removed_at,'imported'
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,display_name text,handle text,role text,
         created_at timestamptz,removed_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map((member) => ({
        id: scope.derive(member.id),
        display_name: member.display_name,
        handle: member.handle,
        role: member.role,
        created_at: member.created_at,
        removed_at: member.removed_at,
      })),
      scope.communityId
    ),
    rows.length
  );
  await writeHandles(
    client,
    rows.map((member) => ({
      handle: member.handle,
      member_id: scope.derive(member.id),
      agent_id: null,
    })),
    scope.communityId
  );
};

const writeAgents: BatchWriter<'agents'> = async (client, rows, scope) => {
  const ids = rows.map((agent) => scope.derive(agent.id));
  // No ID is both a member and an agent, so a mention resolves to exactly one author.
  const clash = await client.query('SELECT 1 FROM members WHERE community_id=$1 AND id=ANY($2)', [
    scope.communityId,
    ids,
  ]);
  invalid(Boolean(clash.rowCount));
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO agents(id,community_id,owner_member_id,display_name,handle,active,created_at,revoked_at)
       SELECT r.id,$2,r.owner_member_id,r.display_name,r.handle,false,r.created_at,
         COALESCE(r.revoked_at,now())
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,owner_member_id uuid,display_name text,
         handle text,created_at timestamptz,revoked_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map((agent, index) => ({
        id: ids[index],
        owner_member_id: scope.derive(agent.owner_member_id),
        display_name: agent.display_name,
        handle: agent.handle,
        created_at: agent.created_at,
        revoked_at: agent.revoked_at,
      })),
      scope.communityId
    ),
    rows.length
  );
  await writeHandles(
    client,
    rows.map((agent, index) => ({ handle: agent.handle, member_id: null, agent_id: ids[index] })),
    scope.communityId
  );
};

/**
 * Refuse unless every id in `ids` (derived) is a row of `table` in this import's community: a
 * membership that names a channel, member, or agent the export does not hold is tampering.
 */
async function allRestored(
  client: PoolClient,
  table: 'channels' | 'members' | 'agents',
  ids: readonly string[],
  communityId: string
): Promise<void> {
  const distinct = [...new Set(ids)];
  if (!distinct.length) return;
  const found = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE community_id=$1 AND id=ANY($2::uuid[])`,
    [communityId, distinct]
  );
  invalid(found.rows[0].n !== distinct.length);
}

/**
 * Only the adopted owner's own memberships are restored: everyone else's member row is
 * historical. Every membership must still name a channel and a member of this export.
 */
const writeChannelMembers: BatchWriter<'channelMembers'> = async (client, rows, scope) => {
  const derive = (id: string) => scope.derive(id);
  await allRestored(
    client,
    'channels',
    rows.map((row) => derive(row.channel_id)),
    scope.communityId
  );
  await allRestored(
    client,
    'members',
    rows.map((row) => derive(row.member_id)),
    scope.communityId
  );
  const own = rows.filter((membership) => membership.member_id === scope.ownerSourceId);
  if (!own.length) return;
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO channel_members(community_id,channel_id,member_id,joined_at)
       SELECT $2,r.channel_id,r.member_id,r.joined_at
       FROM jsonb_to_recordset($1::jsonb) AS r(channel_id uuid,member_id uuid,joined_at timestamptz)
       ON CONFLICT DO NOTHING`,
      own.map((membership) => ({
        channel_id: scope.derive(membership.channel_id),
        member_id: scope.derive(membership.member_id),
        joined_at: membership.joined_at,
      })),
      scope.communityId
    ),
    own.length
  );
};

/**
 * What a restored message shows. A message the export marks removed or erased shows exactly the
 * tombstone this host writes itself (the removal sentence, or the erased sentence and author
 * name), with the tombstone payload hash, never the text the export put there: a removed message
 * cannot be removed again, so text planted under a removal mark would stay for good.
 */
function restoredContent(
  entry: V2Row['entries'],
  parentId: string | null
): { text: string; authorName: string; payloadHash: string; removedBy: RemovedBy | null } {
  if (entry.removal === null)
    return {
      text: entry.text,
      authorName: entry.author_display_name,
      payloadHash: createHash('sha256').update(entry.text).digest('hex'),
      removedBy: null,
    };
  if (entry.removal === 'erased')
    return {
      text: ERASED_ENTRY_TEXT,
      authorName: entry.author_agent_id ? ERASED_AGENT_NAME : ERASED_MEMBER_NAME,
      payloadHash: tombstonePayloadHash(ERASED_ENTRY_TEXT, parentId),
      removedBy: null,
    };
  const text = REMOVED_ENTRY_TEXT[entry.removal];
  return {
    text,
    authorName: entry.author_display_name,
    payloadHash: tombstonePayloadHash(text, parentId),
    removedBy: entry.removal,
  };
}

/**
 * Agents' channel memberships are not restored (every agent arrives revoked), but each must
 * name a channel and an agent of this export, like any other row.
 */
const checkAgentChannelMembers: BatchWriter<'agentChannelMembers'> = async (
  client,
  rows,
  scope
) => {
  const derive = (id: string) => scope.derive(id);
  await allRestored(
    client,
    'channels',
    rows.map((row) => derive(row.channel_id)),
    scope.communityId
  );
  await allRestored(
    client,
    'agents',
    rows.map((row) => derive(row.agent_id)),
    scope.communityId
  );
};

/**
 * One batch of messages, with their mentions. Each channel's messages are numbered 1 to n in
 * the export's order, continuing from the channel's `last_seq` (so a resumed restore numbers on
 * where it stopped). A reply's parent must be a top-level message earlier in the same channel,
 * and each mention must resolve to exactly one member or agent of this import; the database's
 * tenant keys and the mention constraint refuse anything else.
 */
const writeEntries: BatchWriter<'entries'> = async (client, rows, scope) => {
  const channelIds = [...new Set(rows.map((entry) => scope.derive(entry.channel_id)))];
  const channels = await client.query<{ id: string; last_seq: string }>(
    'SELECT id,last_seq::text FROM channels WHERE community_id=$1 AND id=ANY($2) FOR UPDATE',
    [scope.communityId, channelIds]
  );
  invalid(channels.rows.length !== channelIds.length);
  const lastSeq = new Map(channels.rows.map((channel) => [channel.id, Number(channel.last_seq)]));
  const entries = rows.map((entry) => {
    const channelId = scope.derive(entry.channel_id);
    const seq = lastSeq.get(channelId)! + 1;
    lastSeq.set(channelId, seq);
    const parentId = entry.parent_entry_id && scope.derive(entry.parent_entry_id);
    const shown = restoredContent(entry, parentId);
    return {
      id: scope.derive(entry.id),
      channel_id: channelId,
      seq,
      author_member_id: entry.author_member_id && scope.derive(entry.author_member_id),
      author_agent_id: entry.author_agent_id && scope.derive(entry.author_agent_id),
      author_display_name: shown.authorName,
      text: shown.text,
      parent_entry_id: parentId,
      thread_root_entry_id: entry.thread_root_entry_id && scope.derive(entry.thread_root_entry_id),
      idempotency_key: `import:${entry.id}`,
      payload_hash: shown.payloadHash,
      created_at: entry.created_at,
      // The export says who removed a message, not when; its own time is the earliest honest one.
      removed_by: shown.removedBy,
      removed_at: shown.removedBy ? entry.created_at : null,
      erased_at: entry.removal === 'erased' ? entry.created_at : null,
    };
  });
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO entries(id,community_id,channel_id,seq,author_member_id,author_agent_id,
         author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash,
         created_at,removed_by,removed_at,erased_at)
       SELECT r.id,$2,r.channel_id,r.seq,r.author_member_id,r.author_agent_id,r.author_display_name,
         r.text,r.parent_entry_id,r.thread_root_entry_id,r.idempotency_key,r.payload_hash,r.created_at,
         r.removed_by,r.removed_at,r.erased_at
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,channel_id uuid,seq bigint,
         author_member_id uuid,author_agent_id uuid,author_display_name text,text text,
         parent_entry_id uuid,thread_root_entry_id uuid,idempotency_key text,payload_hash text,
         created_at timestamptz,removed_by text,removed_at timestamptz,erased_at timestamptz)
       ON CONFLICT DO NOTHING`,
      entries,
      scope.communityId
    ),
    entries.length
  );
  const badParent = await client.query(
    `SELECT 1 FROM entries e
     JOIN entries p ON p.community_id=e.community_id AND p.id=e.parent_entry_id
     WHERE e.community_id=$1 AND e.id=ANY($2::uuid[])
       AND (p.channel_id<>e.channel_id OR p.parent_entry_id IS NOT NULL OR p.seq>=e.seq)
     LIMIT 1`,
    [scope.communityId, entries.map((entry) => entry.id)]
  );
  invalid(Boolean(badParent.rowCount));
  await client.query(
    `UPDATE channels c SET last_seq=v.last_seq
     FROM jsonb_to_recordset($1::jsonb) AS v(id uuid,last_seq bigint)
     WHERE c.id=v.id AND c.community_id=$2`,
    [JSON.stringify([...lastSeq].map(([id, seq]) => ({ id, last_seq: seq }))), scope.communityId]
  );
  // A removed or erased message has no mentions left, whatever the export says.
  const mentions = rows.flatMap((entry) =>
    (entry.removal === null ? entry.mentions : []).map((target, index) => ({
      entry_id: scope.derive(entry.id),
      position: index + 1,
      target: scope.derive(target),
    }))
  );
  if (!mentions.length) return;
  wroteAll(
    await insertRows(
      client,
      // content-change: import-restore-batch
      `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id,mentioned_agent_id)
       SELECT r.entry_id,r.position,$2,m.id,a.id
       FROM jsonb_to_recordset($1::jsonb) AS r(entry_id uuid,position integer,target uuid)
       LEFT JOIN members m ON m.community_id=$2 AND m.id=r.target
       LEFT JOIN agents a ON a.community_id=$2 AND a.id=r.target
       ON CONFLICT DO NOTHING`,
      mentions,
      scope.communityId
    ),
    mentions.length
  );
};

/** One batch of files' rows, pointing at the blobs the files step stored. */
const writeAttachments: BatchWriter<'attachments'> = async (client, rows, scope) => {
  const stored = await client.query<{
    source_attachment_id: string;
    blob_key: string;
    content_type: string;
  }>(
    `SELECT source_attachment_id,blob_key,content_type FROM community_import_files
     WHERE import_id=$1 AND purpose='attachment' AND source_attachment_id=ANY($2::uuid[])`,
    [scope.importId, rows.map((attachment) => attachment.id)]
  );
  const files = new Map(stored.rows.map((file) => [file.source_attachment_id, file]));
  const attachments = rows.map((attachment) => {
    const file = files.get(attachment.id);
    if (!file) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
    return {
      id: scope.derive(attachment.id),
      channel_id: scope.derive(attachment.channelId),
      entry_id: scope.derive(attachment.entryId),
      uploader_member_id: attachment.uploaderMemberId && scope.derive(attachment.uploaderMemberId),
      uploader_agent_id: attachment.uploaderAgentId && scope.derive(attachment.uploaderAgentId),
      blob_key: file.blob_key,
      display_name: sanitizeDisplayName(attachment.name),
      // What storage detected from the bytes, never the type the export claims.
      content_type: file.content_type,
      byte_size: attachment.byteSize,
      checksum: attachment.checksum,
      uploaded_at: attachment.uploadedAt,
    };
  });
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO attachments(id,community_id,channel_id,entry_id,uploader_member_id,
         uploader_agent_id,blob_key,display_name,content_type,byte_size,checksum,uploaded_at)
       SELECT r.id,$2,r.channel_id,r.entry_id,r.uploader_member_id,r.uploader_agent_id,r.blob_key,
         r.display_name,r.content_type,r.byte_size,r.checksum,r.uploaded_at
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,channel_id uuid,entry_id uuid,
         uploader_member_id uuid,uploader_agent_id uuid,blob_key text,display_name text,
         content_type text,byte_size integer,checksum text,uploaded_at timestamptz)
       ON CONFLICT DO NOTHING`,
      attachments,
      scope.communityId
    ),
    attachments.length
  );
  const elsewhere = await client.query(
    `SELECT 1 FROM attachments a JOIN entries e ON e.community_id=a.community_id AND e.id=a.entry_id
     WHERE a.community_id=$1 AND a.id=ANY($2::uuid[]) AND e.channel_id<>a.channel_id LIMIT 1`,
    [scope.communityId, attachments.map((attachment) => attachment.id)]
  );
  invalid(Boolean(elsewhere.rowCount));
  // Removing or erasing a message deletes its files, so a file on one is a tampered export.
  const onTombstone = await client.query(
    `SELECT 1 FROM attachments a JOIN entries e ON e.community_id=a.community_id AND e.id=a.entry_id
     WHERE a.community_id=$1 AND a.id=ANY($2::uuid[])
       AND (e.removed_at IS NOT NULL OR e.erased_at IS NOT NULL) LIMIT 1`,
    [scope.communityId, attachments.map((attachment) => attachment.id)]
  );
  invalid(Boolean(onTombstone.rowCount));
};

/**
 * Audit events keep `origin='imported'`, so nothing an export claims passes for an event this
 * host wrote. A subject that is another row of the export maps through the same derivation.
 */
const writeAuditEvents: BatchWriter<'auditEvents'> = async (client, rows, scope) => {
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO audit_events(id,community_id,actor_member_id,actor_kind,action,subject_id,
         prior_state,next_state,changed_fields,created_at,origin)
       SELECT r.id,$2,r.actor_member_id,r.actor_kind,r.action,r.subject_id,r.prior_state,
         r.next_state,ARRAY(SELECT jsonb_array_elements_text(r.changed_fields)),r.created_at,
         'imported'
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,actor_member_id uuid,actor_kind text,
         action text,subject_id text,prior_state text,next_state text,changed_fields jsonb,
         created_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map((event) => ({
        id: scope.derive(event.id),
        actor_member_id: event.actor_member_id && scope.derive(event.actor_member_id),
        actor_kind: event.actor_kind,
        action: event.action,
        subject_id:
          event.subject_id !== null && UUID.test(event.subject_id)
            ? scope.derive(event.subject_id)
            : event.subject_id,
        prior_state: event.prior_state,
        next_state: event.next_state,
        changed_fields: event.changed_fields,
        created_at: event.created_at,
      })),
      scope.communityId
    ),
    rows.length
  );
};

/**
 * The restore's steps, in dependency order. Handles go with the members and agents they
 * reserve, and mentions with their messages, so each batch is complete on its own.
 */
export const STEPS: { key: V2Collection; write: BatchWriter<never> }[] = [
  { key: 'channels', write: writeChannels as BatchWriter<never> },
  { key: 'members', write: writeMembers as BatchWriter<never> },
  { key: 'agents', write: writeAgents as BatchWriter<never> },
  { key: 'channelMembers', write: writeChannelMembers as BatchWriter<never> },
  { key: 'agentChannelMembers', write: checkAgentChannelMembers as BatchWriter<never> },
  { key: 'entries', write: writeEntries as BatchWriter<never> },
  { key: 'attachments', write: writeAttachments as BatchWriter<never> },
  { key: 'auditEvents', write: writeAuditEvents as BatchWriter<never> },
];

/** A row's weight in a batch: a message counts its mentions too. */
export function weight(key: V2Collection, row: unknown): number {
  return key === 'entries' ? 1 + (row as V2Row['entries']).mentions.length : 1;
}
