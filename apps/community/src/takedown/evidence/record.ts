import { createRequire } from 'node:module';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { CommunityEvidenceRecordV1Schema } from '@dorkos/shared/community-admin-wire';
import type { HostActor } from '../../host/authority.js';

/** `record.json` as the server writes it into the evidence store. */
export type EvidenceRecord = z.infer<typeof CommunityEvidenceRecordV1Schema>;

/** This server's version, from its package.json (beside `src/` and `dist-server/` alike). */
export const COMMUNITY_SERVER_VERSION: string = (
  createRequire(import.meta.url)('../../../package.json') as { version: string }
).version;

/** What every record says about where its IP addresses came from. */
export const EVIDENCE_IP_NOTE =
  'The Community server does not log request IP addresses; session IP addresses are those the sign-in stored.';

type Account = NonNullable<EvidenceRecord['account']>;
type Author = NonNullable<EvidenceRecord['author']>;
type File = EvidenceRecord['files'][number];

/**
 * An account as the evidence names it: id, email, when it was made, and each current session's
 * start, IP address, and user agent exactly as the sign-in stored them. Null when there is no
 * account (an erased member).
 */
export async function readEvidenceAccount(
  client: PoolClient,
  userId: string | null
): Promise<Account | null> {
  if (!userId) return null;
  const user = await client.query<{ id: string; email: string; created_at: Date }>(
    'SELECT id,email,"createdAt" AS created_at FROM "user" WHERE id=$1',
    [userId]
  );
  if (!user.rows[0]) return null;
  const sessions = await client.query<{
    created_at: Date;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT "createdAt" AS created_at,"ipAddress" AS ip_address,"userAgent" AS user_agent
     FROM session WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt",id`,
    [userId]
  );
  return {
    id: user.rows[0].id,
    email: user.rows[0].email,
    createdAt: user.rows[0].created_at.toISOString(),
    sessions: sessions.rows.map((row) => ({
      createdAt: row.created_at.toISOString(),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    })),
  };
}

/**
 * Who made a message or file, and the account behind them. An agent has no account of its own,
 * so the record names the agent and its owner member, with the owner's account and sessions.
 *
 * @returns `subjectMemberId`, the member the content counts as, for the author's notice.
 */
export async function readEvidenceAuthor(
  client: PoolClient,
  communityId: string,
  by: { memberId: string | null; agentId: string | null }
): Promise<{ author: Author | null; account: Account | null; subjectMemberId: string | null }> {
  let agent: Author['agent'] = null;
  let memberId = by.memberId;
  if (by.agentId) {
    const row = await client.query<{
      id: string;
      display_name: string;
      handle: string;
      owner_member_id: string;
    }>(
      'SELECT id,display_name,handle,owner_member_id FROM agents WHERE id=$1 AND community_id=$2',
      [by.agentId, communityId]
    );
    if (row.rows[0]) {
      agent = {
        id: row.rows[0].id,
        displayName: row.rows[0].display_name,
        handle: row.rows[0].handle,
      };
      memberId = row.rows[0].owner_member_id;
    }
  }
  if (!memberId) return { author: null, account: null, subjectMemberId: null };
  const member = await client.query<{
    id: string;
    display_name: string;
    handle: string;
    role: Author['role'];
    user_id: string | null;
  }>('SELECT id,display_name,handle,role,user_id FROM members WHERE id=$1 AND community_id=$2', [
    memberId,
    communityId,
  ]);
  const row = member.rows[0];
  if (!row) return { author: null, account: null, subjectMemberId: memberId };
  return {
    author: {
      memberId: row.id,
      displayName: row.display_name,
      handle: row.handle,
      role: row.role,
      kind: agent ? 'agent' : 'human',
      agent,
    },
    account: await readEvidenceAccount(client, row.user_id),
    subjectMemberId: row.id,
  };
}

/** One file as the takedown found it, with the blob that holds its bytes. */
export interface EvidenceFileRow {
  id: string;
  blob_key: string;
  display_name: string;
  content_type: string;
  byte_size: number;
  checksum: string;
  uploaded_at: Date;
  uploader_member_id: string | null;
  uploader_agent_id: string | null;
}

/** The columns {@link evidenceFile} needs, for a `SELECT` from `attachments`. */
export const EVIDENCE_FILE_COLUMNS = `id,blob_key,display_name,content_type,byte_size,checksum,
  uploaded_at,uploader_member_id,uploader_agent_id`;

/** A held file as the record lists it; `path` is relative to the attempt folder. */
export function evidenceFile(row: EvidenceFileRow): File {
  return {
    id: row.id,
    name: row.display_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    uploadedAt: row.uploaded_at.toISOString(),
    uploaderMemberId: row.uploader_member_id,
    uploaderAgentId: row.uploader_agent_id,
    path: `files/${row.id}`,
    sha256: row.checksum,
  };
}

/** Everything a record holds besides the takedown itself. */
export type EvidenceContent = Omit<EvidenceRecord, 'version' | 'takedown' | 'server' | 'notes'>;

/**
 * Assemble one evidence record and check it against the published schema, so it holds exactly
 * the documented fields and nothing more.
 */
export function buildEvidenceRecord(input: {
  takedown: {
    id: string;
    createdAt: Date;
    actor: HostActor;
    category: EvidenceRecord['takedown']['category'];
    reference: string | null;
    notify: boolean;
  };
  publicUrl: string;
  content: EvidenceContent;
}): EvidenceRecord {
  const { takedown } = input;
  return CommunityEvidenceRecordV1Schema.parse({
    version: 1,
    takedown: {
      id: takedown.id,
      createdAt: takedown.createdAt.toISOString(),
      actor:
        takedown.actor.kind === 'person'
          ? { kind: 'person', id: takedown.actor.userId, name: takedown.actor.name }
          : { kind: 'api_key', id: takedown.actor.keyId, name: null },
      category: takedown.category,
      reference: takedown.reference,
      notify: takedown.notify,
    },
    server: { publicUrl: input.publicUrl, version: COMMUNITY_SERVER_VERSION },
    ...input.content,
    notes: [EVIDENCE_IP_NOTE],
  });
}

/** The bytes of `record.json`: the record as indented JSON with a final newline. */
export function serializeEvidenceRecord(record: EvidenceRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
}
