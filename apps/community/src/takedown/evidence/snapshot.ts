import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { CommunityAdminTakedownRequestSchema } from '@dorkos/shared/community-admin-wire';
import { lockRemovedFiles } from '../../content-removal.js';
import { ApiError } from '../../http.js';
import {
  EVIDENCE_FILE_COLUMNS,
  evidenceFile,
  readEvidenceAuthor,
  type EvidenceContent,
  type EvidenceFileRow,
  type EvidenceRecord,
} from './record.js';

/** An item target: one message, one file, or the icon. */
export type ItemTarget = Exclude<
  z.infer<typeof CommunityAdminTakedownRequestSchema>['target'],
  { kind: 'community' }
>;

interface EntrySnapshot {
  id: string;
  channel_id: string;
  seq: string;
  created_at: Date;
  text: string;
  parent_entry_id: string | null;
  thread_root_entry_id: string | null;
  author_member_id: string | null;
  author_agent_id: string | null;
  removed_at: Date | null;
  erased_at: Date | null;
}

async function lockEntrySnapshot(
  client: PoolClient,
  communityId: string,
  entryId: string
): Promise<EntrySnapshot | undefined> {
  // FOR NO KEY UPDATE, as content-removal.ts locks an entry: a reply holds FOR KEY SHARE on its
  // parent while it holds its channel.
  const entry = await client.query<EntrySnapshot>(
    `SELECT id,channel_id,seq::text AS seq,created_at,text,parent_entry_id,thread_root_entry_id,
            author_member_id,author_agent_id,removed_at,erased_at
     FROM entries WHERE id=$2 AND community_id=$1 FOR NO KEY UPDATE`,
    [communityId, entryId]
  );
  return entry.rows[0];
}

async function entryEvidence(
  client: PoolClient,
  communityId: string,
  entry: EntrySnapshot
): Promise<EvidenceContent['entry']> {
  const mentions = await client.query<{ id: string }>(
    `SELECT COALESCE(mentioned_member_id,mentioned_agent_id) AS id FROM entry_mentions
     WHERE community_id=$1 AND entry_id=$2 ORDER BY position`,
    [communityId, entry.id]
  );
  return {
    id: entry.id,
    seq: Number(entry.seq),
    createdAt: entry.created_at.toISOString(),
    text: entry.text,
    parentEntryId: entry.parent_entry_id,
    threadRootEntryId: entry.thread_root_entry_id,
    mentionIds: mentions.rows.map((row) => row.id),
    contentAlreadyRemoved: Boolean(entry.removed_at || entry.erased_at),
  };
}

async function channelEvidence(client: PoolClient, communityId: string, channelId: string) {
  const channel = await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM channels WHERE id=$1 AND community_id=$2',
    [channelId, communityId]
  );
  return channel.rows[0] ?? null;
}

/**
 * Lock a file for its takedown in the order `removeAttachment` takes it: a posted file's message
 * first, then the file. An unposted file is locked alone, under a savepoint; if a post bound it
 * before the lock was granted, the savepoint releases the lock and the message is taken first.
 */
async function lockAttachmentSnapshot(
  client: PoolClient,
  communityId: string,
  attachmentId: string
): Promise<{ file: EvidenceFileRow & { channel_id: string }; entry: EntrySnapshot | null }> {
  const select = `SELECT ${EVIDENCE_FILE_COLUMNS},channel_id,entry_id FROM attachments
    WHERE id=$2 AND community_id=$1`;
  type Locked = EvidenceFileRow & { channel_id: string; entry_id: string | null };
  const current = await client.query<{ entry_id: string | null }>(
    'SELECT entry_id FROM attachments WHERE id=$2 AND community_id=$1',
    [communityId, attachmentId]
  );
  if (!current.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  let entryId = current.rows[0].entry_id;
  if (!entryId) {
    await client.query('SAVEPOINT takedown_unbound_file');
    const locked = await client.query<Locked>(`${select} FOR UPDATE`, [communityId, attachmentId]);
    if (!locked.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    if (!locked.rows[0].entry_id) {
      await client.query('RELEASE SAVEPOINT takedown_unbound_file');
      return { file: locked.rows[0], entry: null };
    }
    await client.query('ROLLBACK TO SAVEPOINT takedown_unbound_file');
    entryId = locked.rows[0].entry_id;
  }
  const entry = await lockEntrySnapshot(client, communityId, entryId);
  if (!entry) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  const locked = await client.query<Locked>(`${select} AND entry_id=$3 FOR UPDATE`, [
    communityId,
    attachmentId,
    entry.id,
  ]);
  if (!locked.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  return { file: locked.rows[0], entry };
}

/** What a target's evidence holds, and who it counts as, read under the target's locks. */
export interface TargetSnapshot {
  content: EvidenceContent;
  /** Blob keys in record order: each file, then the icon. */
  blobKeys: string[];
  /** Whether anything is left to remove and preserve. */
  hasContent: boolean;
  entryId: string | null;
  channelId: string | null;
  subjectMemberId: string | null;
  subjectId: string;
  /**
   * Files an author or admin removed from this message earlier whose bytes the sweep has not
   * deleted yet: a takedown holds them again. Already swept is already gone.
   */
  reheldKeys: string[];
}

/**
 * Lock a takedown's target the way content-removal.ts will, and read what its evidence holds:
 * the message, its channel, its author and their account and sessions, its files, or the icon.
 * An id that is not in this community is `404`, the same as an unknown one.
 */
export async function snapshotTarget(
  client: PoolClient,
  community: { id: string; name: string; lifecycle: EvidenceRecord['community']['lifecycle'] },
  target: ItemTarget,
  icon: { key: string | null; contentType: string | null }
): Promise<TargetSnapshot> {
  const base = {
    community: { id: community.id, name: community.name, lifecycle: community.lifecycle },
    channel: null,
    entry: null,
    author: null,
    account: null,
    files: [],
    icon: null,
  } satisfies EvidenceContent;
  if (target.kind === 'icon') {
    if (!icon.key || !icon.contentType)
      throw new ApiError(404, 'NOT_FOUND', 'Community icon not found.');
    const blob = await client.query<{ byte_size: string; checksum: string }>(
      `SELECT byte_size::text,checksum FROM managed_blobs
       WHERE blob_key=$1 AND community_id=$2 AND state IN ('committed','stored')`,
      [icon.key, community.id]
    );
    // The icon's foreign key (communities_icon_tenant_fk) keeps its inventory row, and an icon
    // is committed before it is set, so its size and checksum are always there.
    const found = blob.rows[0];
    if (!found) throw new Error('Community icon inventory is missing');
    return {
      content: {
        ...base,
        icon: {
          contentType: icon.contentType,
          byteSize: Number(found.byte_size),
          path: 'icon',
          sha256: found.checksum,
        },
      },
      blobKeys: [icon.key],
      hasContent: true,
      entryId: null,
      channelId: null,
      subjectMemberId: null,
      subjectId: community.id,
      reheldKeys: [],
    };
  }
  if (target.kind === 'entry') {
    const entry = await lockEntrySnapshot(client, community.id, target.entryId);
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
    const files = await client.query<EvidenceFileRow>(
      // Locked here, in id order as every removal takes files: a file erasure deletes between this
      // read and the removal would leave a staged record naming bytes that are already queued.
      `SELECT ${EVIDENCE_FILE_COLUMNS} FROM attachments
       WHERE community_id=$1 AND entry_id=$2 ORDER BY id FOR UPDATE`,
      [community.id, entry.id]
    );
    // A message its author or an admin already removed has no files left, but their bytes may
    // still be waiting for the sweep. An erased message stays erased.
    const removed =
      entry.removed_at && !entry.erased_at
        ? await lockRemovedFiles(client, community.id, entry.id)
        : [];
    for (const row of removed)
      files.rows.push({ ...row, id: row.attachment_id } as EvidenceFileRow);
    const who = await readEvidenceAuthor(client, community.id, {
      memberId: entry.author_member_id,
      agentId: entry.author_agent_id,
    });
    return {
      content: {
        ...base,
        channel: await channelEvidence(client, community.id, entry.channel_id),
        entry: await entryEvidence(client, community.id, entry),
        author: who.author,
        account: who.account,
        files: files.rows.map(evidenceFile),
      },
      blobKeys: files.rows.map((row) => row.blob_key),
      hasContent: (!entry.removed_at && !entry.erased_at) || removed.length > 0,
      entryId: entry.id,
      channelId: entry.channel_id,
      subjectMemberId: who.subjectMemberId,
      subjectId: entry.id,
      reheldKeys: removed.map((row) => row.blob_key),
    };
  }
  const { file, entry } = await lockAttachmentSnapshot(client, community.id, target.attachmentId);
  const who = await readEvidenceAuthor(client, community.id, {
    memberId: file.uploader_member_id,
    agentId: file.uploader_agent_id,
  });
  return {
    content: {
      ...base,
      channel: await channelEvidence(client, community.id, file.channel_id),
      entry: entry ? await entryEvidence(client, community.id, entry) : null,
      author: who.author,
      account: who.account,
      files: [evidenceFile(file)],
    },
    blobKeys: [file.blob_key],
    hasContent: true,
    entryId: entry?.id ?? null,
    channelId: file.channel_id,
    subjectMemberId: who.subjectMemberId,
    subjectId: file.id,
    reheldKeys: [],
  };
}
