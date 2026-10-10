import type { PoolClient } from 'pg';
import type { Member } from '../data.js';
import { ApiError } from '../http.js';
import { outranks } from './bans.js';

/**
 * Mute a current member for `minutes` as `actor`, replacing any mute in force: the shared step
 * of the mute route and of resolving a report with a mute. The caller has checked the actor's
 * live role. The target's member row is taken `FOR UPDATE`, the lock every post of theirs (and
 * of their agents) takes first, so a post either lands before the mute or meets it.
 *
 * @returns When the mute ends.
 */
export async function muteMember(
  client: PoolClient,
  input: {
    actor: { id: string; communityId: string; role: Member['role'] };
    targetId: string;
    minutes: number;
  }
): Promise<Date> {
  const { actor } = input;
  const target = await client.query<{ id: string; role: Member['role'] }>(
    'SELECT id,role FROM members WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
    [input.targetId, actor.communityId]
  );
  const row = target.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
  if (row.id === actor.id) throw new ApiError(409, 'STATE_CONFLICT', "You can't mute yourself.");
  if (!outranks(actor.role, row.role))
    throw new ApiError(403, 'FORBIDDEN', 'This member cannot be muted by your role.');
  const updated = await client.query<{ muted_until: Date }>(
    `UPDATE members SET muted_until=now()+make_interval(mins => $3)
     WHERE id=$1 AND community_id=$2 RETURNING muted_until`,
    [row.id, actor.communityId, input.minutes]
  );
  const until = updated.rows[0].muted_until;
  await client.query(
    `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,next_state,changed_fields)
     VALUES($1,$2,'member.mute',$3,$4,ARRAY['muted_until'])`,
    [actor.communityId, actor.id, row.id, until.toISOString()]
  );
  return until;
}
