import type { PoolClient } from 'pg';

/**
 * Erase one person from a space's moderation records, inside the erasure's husk step.
 *
 * - A ban on the membership loses the account and the moderator's words about the person, and
 *   keeps its keyed email, so erasing an account is not a way back in (0033).
 * - Reports keep who reported which message, why and what was done, which is the moderators'
 *   record, but lose every note that is the person's: the notes they wrote, and the notes others
 *   wrote about a message by them or by one of their agents.
 * - Their slow-mode clocks are rate state about them, and go.
 *
 * Every statement is idempotent, so a reapplied erasure runs it again safely.
 */
export async function huskModerationRecords(
  client: PoolClient,
  communityId: string,
  memberId: string
): Promise<void> {
  await client.query(
    'UPDATE bans SET user_id=NULL,reason=NULL WHERE community_id=$1 AND member_id=$2',
    [communityId, memberId]
  );
  await client.query(
    `UPDATE reports r SET note=NULL WHERE r.community_id=$1 AND r.note IS NOT NULL AND (
       r.reporter_member_id=$2 OR EXISTS(
         SELECT 1 FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.id=r.entry_id AND e.community_id=$1
           AND (e.author_member_id=$2 OR a.owner_member_id=$2)))`,
    [communityId, memberId]
  );
  await client.query('DELETE FROM channel_post_clocks WHERE community_id=$1 AND member_id=$2', [
    communityId,
    memberId,
  ]);
}
