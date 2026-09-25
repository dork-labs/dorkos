import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import { uuidv5 } from './derived-id.js';
import { ImportFailure, importedChannel, renumberedSequences } from './manifest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One restored file, as the worker stored it: its new key and the type storage detected. */
export interface RestoredFile {
  blobKey: string;
  contentType: string;
}

/**
 * Insert every row of a checked owner export into its import's community, inside the caller's
 * transaction, with IDs derived from the import and the source IDs. Nothing here is visible
 * until that transaction commits.
 *
 * A version 1 export does not say which messages were removed or erased, only the text they
 * show, so no restored message is marked removed or erased; one whose text is a removal
 * sentence arrives as an ordinary message. Version 2 carries the marks (`removal`).
 *
 * Audit events keep `origin='imported'`, so nothing an export claims passes for an event this
 * host wrote. Members and agents are historical: no account, inactive, `origin='imported'`; agents are
 * revoked. The owner who made the export is the one row the claimant later adopts, and it is
 * added to every channel. Emails are dropped. Entries keep their order (renumbered 1 to n per
 * channel), thread, mentions,
 * author name, and time.
 *
 * @returns The adopted owner's new member ID.
 */
export async function insertImportedRows(
  client: PoolClient,
  input: {
    importId: string;
    communityId: string;
    manifest: CommunityExportManifestV1;
    files: ReadonlyMap<string, RestoredFile>;
  }
): Promise<string> {
  const { importId, communityId, manifest, files } = input;
  const derive = (sourceId: string) => uuidv5(importId, sourceId);
  const insert = (sql: string, rows: unknown[]) =>
    rows.length ? client.query(sql, [JSON.stringify(rows), communityId]) : Promise.resolve();

  const sequences = renumberedSequences(manifest.entries);
  const lastSeq = new Map<string, number>();
  for (const entry of manifest.entries) {
    const seq = sequences.get(entry.id)!;
    if (seq > (lastSeq.get(entry.channel_id) ?? 0)) lastSeq.set(entry.channel_id, seq);
  }
  await insert(
    `INSERT INTO channels(id,community_id,name,description,visibility,archived,last_seq,epoch,created_at)
     SELECT r.id,$2,r.name,r.description,r.visibility,r.archived,r.last_seq,1,r.created_at
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,name text,description text,visibility text,
       archived boolean,last_seq bigint,created_at timestamptz)`,
    manifest.channels.map(importedChannel).map((channel) => ({
      id: derive(channel.id),
      name: channel.name,
      description: channel.description,
      visibility: channel.visibility,
      archived: channel.archived,
      last_seq: lastSeq.get(channel.id) ?? 0,
      created_at: channel.created_at,
    }))
  );
  await insert(
    `INSERT INTO members(id,community_id,user_id,display_name,handle,role,active,created_at,removed_at,origin)
     SELECT r.id,$2,NULL,r.display_name,r.handle,r.role,false,r.created_at,r.removed_at,'imported'
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,display_name text,handle text,role text,
       created_at timestamptz,removed_at timestamptz)`,
    manifest.members.map((member) => ({
      id: derive(member.id),
      display_name: member.display_name,
      handle: member.handle,
      role: member.role,
      created_at: member.created_at,
      removed_at: member.removed_at,
    }))
  );
  await insert(
    `INSERT INTO agents(id,community_id,owner_member_id,display_name,handle,active,created_at,revoked_at)
     SELECT r.id,$2,r.owner_member_id,r.display_name,r.handle,false,r.created_at,
       COALESCE(r.revoked_at,now())
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,owner_member_id uuid,display_name text,
       handle text,created_at timestamptz,revoked_at timestamptz)`,
    manifest.agents.map((agent) => ({
      id: derive(agent.id),
      owner_member_id: derive(agent.owner_member_id),
      display_name: agent.display_name,
      handle: agent.handle,
      created_at: agent.created_at,
      revoked_at: agent.revoked_at,
    }))
  );
  // Every handle stays reserved, so nobody can take a past author's name to impersonate them.
  await insert(
    `INSERT INTO community_handles(community_id,handle,member_id,agent_id)
     SELECT $2,r.handle,r.member_id,r.agent_id
     FROM jsonb_to_recordset($1::jsonb) AS r(handle text,member_id uuid,agent_id uuid)`,
    [
      ...manifest.members.map((member) => ({
        handle: member.handle,
        member_id: derive(member.id),
        agent_id: null,
      })),
      ...manifest.agents.map((agent) => ({
        handle: agent.handle,
        member_id: null,
        agent_id: derive(agent.id),
      })),
    ]
  );
  const ownerId = derive(manifest.requesterMemberId);
  // A version 1 export has no channel memberships; an owner export held every channel.
  await insert(
    `INSERT INTO channel_members(community_id,channel_id,member_id)
     SELECT $2,r.channel_id,r.member_id
     FROM jsonb_to_recordset($1::jsonb) AS r(channel_id uuid,member_id uuid)`,
    manifest.channels.map((channel) => ({ channel_id: derive(channel.id), member_id: ownerId }))
  );
  // Parents first, as a live community wrote them: by sequence within each channel.
  const entries = [...manifest.entries].sort((a, b) =>
    a.channel_id === b.channel_id
      ? sequences.get(a.id)! - sequences.get(b.id)!
      : a.channel_id.localeCompare(b.channel_id)
  );
  await insert(
    `INSERT INTO entries(id,community_id,channel_id,seq,author_member_id,author_agent_id,
       author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash,
       created_at)
     SELECT r.id,$2,r.channel_id,r.seq,r.author_member_id,r.author_agent_id,r.author_display_name,
       r.text,r.parent_entry_id,r.thread_root_entry_id,r.idempotency_key,r.payload_hash,r.created_at
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,channel_id uuid,seq bigint,
       author_member_id uuid,author_agent_id uuid,author_display_name text,text text,
       parent_entry_id uuid,thread_root_entry_id uuid,idempotency_key text,payload_hash text,
       created_at timestamptz)`,
    entries.map((entry) => ({
      id: derive(entry.id),
      channel_id: derive(entry.channel_id),
      seq: sequences.get(entry.id),
      author_member_id: entry.author_member_id && derive(entry.author_member_id),
      author_agent_id: entry.author_agent_id && derive(entry.author_agent_id),
      author_display_name: entry.author_display_name,
      text: entry.text,
      parent_entry_id: entry.parent_entry_id && derive(entry.parent_entry_id),
      thread_root_entry_id: entry.thread_root_entry_id && derive(entry.thread_root_entry_id),
      idempotency_key: `import:${entry.id}`,
      payload_hash: createHash('sha256').update(entry.text).digest('hex'),
      created_at: entry.created_at,
    }))
  );
  const members = new Set(manifest.members.map((member) => member.id));
  await insert(
    // content-change: import-restore
    `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id,mentioned_agent_id)
     SELECT r.entry_id,r.position,$2,r.member_id,r.agent_id
     FROM jsonb_to_recordset($1::jsonb) AS r(entry_id uuid,position integer,member_id uuid,
       agent_id uuid)`,
    manifest.entries.flatMap((entry) =>
      entry.mentions.map((target, index) => ({
        entry_id: derive(entry.id),
        position: index + 1,
        member_id: members.has(target) ? derive(target) : null,
        agent_id: members.has(target) ? null : derive(target),
      }))
    )
  );
  await insert(
    `INSERT INTO attachments(id,community_id,channel_id,entry_id,uploader_member_id,
       uploader_agent_id,blob_key,display_name,content_type,byte_size,checksum,uploaded_at)
     SELECT r.id,$2,r.channel_id,r.entry_id,r.uploader_member_id,r.uploader_agent_id,r.blob_key,
       r.display_name,r.content_type,r.byte_size,r.checksum,r.uploaded_at
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,channel_id uuid,entry_id uuid,
       uploader_member_id uuid,uploader_agent_id uuid,blob_key text,display_name text,
       content_type text,byte_size integer,checksum text,uploaded_at timestamptz)`,
    manifest.attachments.map((attachment) => {
      const file = files.get(attachment.id);
      if (!file) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
      return {
        id: derive(attachment.id),
        channel_id: derive(attachment.channelId),
        entry_id: derive(attachment.entryId),
        uploader_member_id: attachment.uploaderMemberId && derive(attachment.uploaderMemberId),
        uploader_agent_id: attachment.uploaderAgentId && derive(attachment.uploaderAgentId),
        blob_key: file.blobKey,
        display_name: sanitizeDisplayName(attachment.name),
        // What storage detected from the bytes, never the type the export claims.
        content_type: file.contentType,
        byte_size: attachment.byteSize,
        checksum: attachment.checksum,
        uploaded_at: attachment.uploadedAt,
      };
    })
  );
  await insert(
    `INSERT INTO audit_events(id,community_id,actor_member_id,actor_kind,action,subject_id,
       prior_state,next_state,changed_fields,created_at,origin)
     SELECT r.id,$2,r.actor_member_id,r.actor_kind,r.action,r.subject_id,r.prior_state,
       r.next_state,ARRAY(SELECT jsonb_array_elements_text(r.changed_fields)),r.created_at,
       'imported'
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,actor_member_id uuid,actor_kind text,
       action text,subject_id text,prior_state text,next_state text,changed_fields jsonb,
       created_at timestamptz)`,
    (manifest.auditEvents ?? []).map((event) => ({
      id: derive(event.id),
      actor_member_id: event.actor_member_id && derive(event.actor_member_id),
      actor_kind: event.actor_kind,
      action: event.action,
      // A subject is another row of the export, and maps through the same derivation.
      subject_id:
        event.subject_id !== null && UUID.test(event.subject_id)
          ? derive(event.subject_id)
          : event.subject_id,
      prior_state: event.prior_state,
      next_state: event.next_state,
      changed_fields: event.changed_fields,
      created_at: event.created_at,
    }))
  );
  return ownerId;
}
