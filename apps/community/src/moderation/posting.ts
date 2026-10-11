import type { PoolClient } from 'pg';
import { ApiError, Muted, RateLimited } from '../http.js';

/**
 * Refuse a post its human may not make right now, and start the slow-mode wait for the next one.
 * An agent posts as its owner here: a muted owner's agents are muted, an owner who has not
 * accepted the current rules cannot post through an agent either, and slow mode counts the
 * owner's posts and their agents' together.
 *
 * Call it inside the post's transaction after the channel lock and `lockPrincipalAuthority`, which holds the owner's
 * member row `FOR UPDATE`: a mute, a rules acceptance and this person's other posts all take
 * that row, so they cannot interleave with this check. Owners and admins post through slow mode.
 *
 * @throws {Muted} `403 COMMUNITY_MUTED`, with when the mute ends.
 * @throws {ApiError} `403 COMMUNITY_RULES_NOT_ACCEPTED` before the current rules are accepted.
 * @throws {RateLimited} `429 COMMUNITY_SLOW_MODE`, with `Retry-After`, inside the wait.
 */
export async function enforcePostingRules(
  client: PoolClient,
  input: { communityId: string; ownerMemberId: string; channelId: string }
): Promise<void> {
  const standing = await client.query<{
    role: 'owner' | 'admin' | 'member';
    muted_until: Date | null;
    rules_accepted_version: number;
    rules_version: number;
    has_rules: boolean;
    slow_mode_seconds: number;
  }>(
    `SELECT m.role,CASE WHEN m.muted_until>now() AND m.role<>'owner' THEN m.muted_until END AS muted_until,
            m.rules_accepted_version,c.rules_version,c.rules_text IS NOT NULL AS has_rules,
            ch.slow_mode_seconds
     FROM members m JOIN communities c ON c.id=m.community_id
     JOIN channels ch ON ch.community_id=c.id AND ch.id=$3
     WHERE m.id=$1 AND m.community_id=$2`,
    [input.ownerMemberId, input.communityId, input.channelId]
  );
  const row = standing.rows[0];
  if (!row) throw new ApiError(403, 'FORBIDDEN', 'The owner membership has ended.');
  if (row.muted_until) throw new Muted(row.muted_until);
  if (row.has_rules && row.rules_accepted_version < row.rules_version)
    throw new ApiError(
      403,
      'COMMUNITY_RULES_NOT_ACCEPTED',
      "Accept this space's rules before you post."
    );
  if (row.slow_mode_seconds <= 0 || row.role === 'owner' || row.role === 'admin') return;
  const wait = await client.query<{ seconds: number }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (posted_at + make_interval(secs => $3) - now())))::int AS seconds
     FROM channel_post_clocks WHERE channel_id=$1 AND member_id=$2`,
    [input.channelId, input.ownerMemberId, row.slow_mode_seconds]
  );
  const seconds = wait.rows[0]?.seconds ?? 0;
  if (seconds > 0)
    throw new RateLimited(
      'This channel is in slow mode. Wait a moment before you post again.',
      seconds,
      'COMMUNITY_SLOW_MODE'
    );
  await client.query(
    `INSERT INTO channel_post_clocks(community_id,channel_id,member_id,posted_at)
     VALUES($1,$2,$3,now())
     ON CONFLICT (channel_id,member_id) DO UPDATE SET posted_at=excluded.posted_at`,
    [input.communityId, input.channelId, input.ownerMemberId]
  );
}
