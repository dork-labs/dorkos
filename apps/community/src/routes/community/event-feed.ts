/**
 * What a live stream sends for one entry, read once and shared: the entry row, its files, and the
 * finished SSE frame for each way a reader can see it. The feed that holds these is in
 * `live/feed.ts`; the stream that sends them is in `events.ts`.
 */
import type { Pool } from 'pg';
import {
  CommunityWireEventSchema,
  type CommunityWireAttachment,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../../config.js';
import type { FeedReader } from '../../live/feed.js';
import { attachmentsForEntries } from './attachments.js';
import { ENTRY_COLUMNS, entryProjection, originKeyForPrincipal, type EntryRow } from './entries.js';

/** One entry ready to send, with its frames built on first use. */
export interface StreamEntry {
  readonly row: EntryRow;
  readonly attachments: CommunityWireAttachment[];
  /** Finished frames by channel epoch and the agent post key the reader may see. */
  readonly frames: Map<string, Uint8Array>;
}

/**
 * Read a channel's entries after `afterSeq` (and up to `upToSeq`, when given) with their files:
 * two queries however many streams will send them.
 *
 * @param pool - Database pool.
 * @param channelId - The channel.
 * @param afterSeq - Read entries after this sequence number.
 * @param upToSeq - Read none after this one; null for no bound.
 * @param limit - Read at most this many.
 */
export async function readStreamEntries(
  pool: Pool,
  channelId: string,
  afterSeq: number,
  upToSeq: number | null,
  limit: number
): Promise<StreamEntry[]> {
  const rows = (
    await pool.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS}
       FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id
       WHERE e.channel_id=$1 AND e.seq>$2 AND ($3::bigint IS NULL OR e.seq<=$3)
       ORDER BY e.seq LIMIT $4`,
      [channelId, afterSeq, upToSeq, limit]
    )
  ).rows;
  const files = await attachmentsForEntries(
    pool,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({ row, attachments: files.get(row.id) ?? [], frames: new Map() }));
}

/**
 * The feed reader a server's channel feeds use.
 *
 * @param pool - Database pool.
 * @param afterRead - Runs once the entries and their files are read. Tests hold it.
 */
export function streamEntryReader(
  pool: Pool,
  afterRead?: () => Promise<void>
): FeedReader<StreamEntry> {
  return async (_communityId, channelId, afterSeq, upToSeq, limit) => {
    const entries = await readStreamEntries(pool, channelId, afterSeq, upToSeq, limit);
    await afterRead?.();
    return entries.map((value) => ({ seq: Number(value.row.seq), value }));
  };
}

const encoder = new TextEncoder();

/**
 * The SSE frame one reader gets for `entry`. Every reader of the channel shares a frame, except
 * the agent and owner who may see that agent's post key: they share another.
 *
 * @param entry - The entry to send.
 * @param reader - Who reads it: the channel epoch it opened at, and the member or agent.
 * @param config - Server settings, for the cursor.
 */
export function entryFrame(
  entry: StreamEntry,
  reader: {
    epoch: number;
    communityId: string;
    principal: { kind: 'human' | 'agent'; id: string };
  },
  config: CommunityConfig
): Uint8Array {
  const originKey = originKeyForPrincipal(entry.row, reader.principal);
  const key = `${reader.epoch}:${originKey ?? ''}`;
  const kept = entry.frames.get(key);
  if (kept) return kept;
  const projected = entryProjection(
    entry.row,
    reader.epoch,
    config,
    entry.attachments,
    reader.communityId,
    originKey
  );
  const event = CommunityWireEventSchema.parse({
    type: 'entry',
    entry: projected,
    cursor: projected.cursor,
  });
  const frame = encoder.encode(
    `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  );
  entry.frames.set(key, frame);
  return frame;
}
