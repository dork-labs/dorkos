import type { PoolClient } from 'pg';
import { mintHandle } from '../handles.js';
import { ApiError } from '../http.js';

/** The name a newcomer gets when the name on their account is one nobody may take here. */
export const PLACEHOLDER_DISPLAY_NAME = 'Member';

/**
 * The form a display name is compared in: case, width, accents, spacing, dashes, invisible
 * characters and the punctuation around a handle do not make a different name, so
 * `D o r k O S`, `@dorkos`, `Dörk-OS`, `Dork\u200BOS` and `ＤｏｒｋＯＳ` are all the reserved
 * `DorkOS`. Look-alike letters from other scripts are not folded: this is a speed bump against
 * passing for staff or an agent, not a wall.
 */
export function comparableName(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Latin accents only: other scripts' combining marks are letters' vowels, not decoration.
      .replace(/[\u0300-\u036f\p{Cf}]/gu, '')
      .toLowerCase()
      // Blanks that are not whitespace (braille blank, Hangul fillers) and the minus sign too.
      .replace(/[\s._@\p{Pd}\u2212\u2800\u3164\uffa0\u115f\u1160]+/gu, '')
  );
}

/**
 * Whether `name` is one this person may not take in the space: a name the owner reserved (owners
 * and admins may use those, as the staff they are kept for), or the name or handle of another
 * person's active agent, so no person can pass for an agent. Their own agents do not count: a
 * person may share a name with their own agent.
 */
export async function isRefusedDisplayName(
  client: PoolClient,
  communityId: string,
  name: string,
  { staff, memberId = null }: { staff: boolean; memberId?: string | null }
): Promise<boolean> {
  const wanted = comparableName(name);
  if (!wanted) return true;
  const taken = await client.query<{ name: string }>(
    `SELECT unnest(reserved_names) AS name FROM communities WHERE id=$1 AND NOT $2::boolean
     UNION ALL SELECT unnest(ARRAY[display_name,handle]) FROM agents
       WHERE community_id=$1 AND active AND owner_member_id IS DISTINCT FROM $3::uuid`,
    [communityId, staff, memberId]
  );
  return taken.rows.some((row) => comparableName(row.name) === wanted);
}

/**
 * The handle and display name a newcomer is admitted with. The handle is minted from the name on
 * their account as before; a name the space refuses (see {@link isRefusedDisplayName}) is
 * replaced by {@link PLACEHOLDER_DISPLAY_NAME}, which the person can change once they are in.
 */
export async function admittedIdentity(
  client: PoolClient,
  communityId: string,
  accountName: string
): Promise<{ handle: string; name: string }> {
  const handle = await mintHandle(client, communityId, accountName);
  const refused = await isRefusedDisplayName(client, communityId, accountName, { staff: false });
  return { handle, name: refused ? PLACEHOLDER_DISPLAY_NAME : accountName };
}

/**
 * Refuse an agent name or handle that passes for someone: a name the owner reserved (unless the
 * agent's owner is the owner or an admin, the staff reserved names are kept for), or another
 * current person's display name or handle, so an agent cannot pose as a person or hold a
 * person's name away from them. An agent may share its own owner's name, and other agents'.
 */
export async function refuseAgentName(
  client: PoolClient,
  owner: { id: string; community_id: string },
  names: readonly string[]
): Promise<void> {
  const wanted = new Set(names.map(comparableName));
  const taken = await client.query<{ name: string }>(
    `SELECT unnest(c.reserved_names) AS name FROM communities c
       WHERE c.id=$1 AND NOT EXISTS(SELECT 1 FROM members m
         WHERE m.id=$2 AND m.community_id=$1 AND m.role IN ('owner','admin'))
     UNION ALL SELECT unnest(ARRAY[display_name,handle]) FROM members
       WHERE community_id=$1 AND active AND id<>$2`,
    [owner.community_id, owner.id]
  );
  if (taken.rows.some((row) => wanted.has(comparableName(row.name))))
    throw new ApiError(409, 'STATE_CONFLICT', 'That name is taken in this space. Try another.');
}

/**
 * Check a returning person's display name again: a name that became reserved, or an agent's,
 * while they were away is replaced by {@link PLACEHOLDER_DISPLAY_NAME}. `staff` is true only when
 * they come back as the owner.
 */
export async function recheckReturningName(
  client: PoolClient,
  memberId: string,
  communityId: string,
  { staff }: { staff: boolean }
): Promise<void> {
  const row = await client.query<{ display_name: string }>(
    'SELECT display_name FROM members WHERE id=$1 AND community_id=$2',
    [memberId, communityId]
  );
  const name = row.rows[0]?.display_name;
  if (
    name !== undefined &&
    (await isRefusedDisplayName(client, communityId, name, { staff, memberId }))
  )
    await client.query('UPDATE members SET display_name=$3 WHERE id=$1 AND community_id=$2', [
      memberId,
      communityId,
      PLACEHOLDER_DISPLAY_NAME,
    ]);
}
