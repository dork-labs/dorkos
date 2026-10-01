import type { Pool, PoolClient } from 'pg';

/**
 * The highest `seq` in each of a community's channels, from channels that hold at least one
 * message. `$1` is the community; `$2` limits it to some of its channels, or is NULL for all.
 *
 * One backward step of the `(channel_id, seq)` unique index per channel. `GROUP BY channel_id`
 * over the community's messages read every one of them instead. At the largest measured
 * community (1,000,000 messages) that was 64,069 buffers and 107–157 ms per export and per
 * erasure round; this reads 252 buffers in about 0.2 ms (DOR-2572). A message's channel is
 * always in its community (entries_channel_tenant_fk), so starting from the channels finds the
 * same rows.
 */
export const CHANNEL_WATERMARK_SQL = `SELECT c.id AS channel_id,mark.seq::text AS seq
  FROM channels c
  CROSS JOIN LATERAL (
    SELECT max(e.seq) AS seq FROM entries e WHERE e.channel_id=c.id AND e.community_id=c.community_id
  ) mark
  WHERE c.community_id=$1 AND ($2::uuid[] IS NULL OR c.id=ANY($2::uuid[])) AND mark.seq IS NOT NULL`;

/**
 * Read {@link CHANNEL_WATERMARK_SQL}: each channel's highest `seq`, by channel id.
 *
 * @param db - The pool, or the client of a transaction whose snapshot the marks must match.
 * @param communityId - The community whose channels are read.
 * @param channelIds - Only these channels, where an id from another community matches nothing;
 *   omit for all of the community's channels.
 */
export async function channelWatermarks(
  db: Pick<Pool | PoolClient, 'query'>,
  communityId: string,
  channelIds?: readonly string[]
): Promise<Map<string, number>> {
  const result = await db.query<{ channel_id: string; seq: string }>(CHANNEL_WATERMARK_SQL, [
    communityId,
    channelIds ?? null,
  ]);
  return new Map(result.rows.map((row) => [row.channel_id, Number(row.seq)]));
}
