import type { Pool, PoolClient } from 'pg';
import type { CommunityWireEntry } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import { encodeCursor } from './cursor.js';

/** The columns every entry projection reads, from `entries e LEFT JOIN agents a`. */
export const ENTRY_COLUMNS = `e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id`;

/** One entry as the projection reads it. */
export interface EntryRow {
  id: string;
  channel_id: string;
  seq: string;
  author_member_id: string;
  author_agent_id: string | null;
  author_display_name: string;
  text: string;
  mentions: string[];
  parent_entry_id: string | null;
  thread_root_entry_id: string | null;
  created_at: Date;
  idempotency_key: string;
  agent_owner_member_id: string | null;
}

/** Reveal an agent's stable post key only to that agent or its owning human. */
export function originKeyForPrincipal(
  row: EntryRow,
  principal: { kind: 'human' | 'agent'; id: string }
): string | undefined {
  if (!row.author_agent_id) return undefined;
  return (principal.kind === 'agent' && principal.id === row.author_agent_id) ||
    (principal.kind === 'human' && principal.id === row.agent_owner_member_id)
    ? row.idempotency_key
    : undefined;
}

/** Convert a committed row to the public wire form. */
export function entryProjection(
  row: EntryRow,
  epoch: number,
  config: CommunityConfig,
  attachments: CommunityWireEntry['attachments'] = [],
  communityId: string,
  originIdempotencyKey?: string
): CommunityWireEntry {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: Number(row.seq),
    authorMemberId: row.author_member_id,
    authorDisplayName: row.author_display_name,
    authorKind: row.author_agent_id ? 'agent' : 'human',
    text: row.text,
    mentions: row.mentions,
    parentEntryId: row.parent_entry_id,
    threadRootEntryId: row.thread_root_entry_id,
    createdAt: row.created_at.toISOString(),
    cursor: encodeCursor(
      {
        version: 1,
        communityId,
        channelId: row.channel_id,
        thread: null,
        epoch,
        seq: Number(row.seq),
      },
      config
    ),
    attachments,
    ...(originIdempotencyKey ? { originIdempotencyKey } : {}),
  };
}

/** Load one entry without revealing its storage columns. */
export async function loadEntry(client: PoolClient | Pool, id: string): Promise<EntryRow> {
  const result = await client.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.id=$1`,
    [id]
  );
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
  return result.rows[0];
}

/**
 * Load the current rows of several entries of one channel, in sequence order. Ids that name no
 * entry of that channel are left out.
 */
export async function loadChannelEntries(
  client: PoolClient,
  channelId: string,
  ids: readonly string[]
): Promise<EntryRow[]> {
  if (!ids.length) return [];
  const result = await client.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id
     WHERE e.channel_id=$1 AND e.id=ANY($2::uuid[]) ORDER BY e.seq`,
    [channelId, ids]
  );
  return result.rows;
}
