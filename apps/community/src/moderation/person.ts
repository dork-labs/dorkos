import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import type { CommunityAuth } from '../auth.js';
import {
  assertPrincipalCurrentInTransaction,
  bearer,
  requireMember,
  requirePrincipal,
  type HeldRemovalOption,
  type Member,
} from '../data.js';
import { ApiError } from '../http.js';

/** The person behind a request about their own conduct, and how to recheck their credential. */
export interface Person {
  /** Their membership. */
  member: Member;
  /** Inside the write's transaction: refuse if the credential was revoked meanwhile. */
  recheck: (client: PoolClient) => Promise<void>;
}

/**
 * Require the PERSON a request is about: their browser session, or the grant they approved for
 * their own DorkOS install (DOR-2770), so the app can read their standing, accept the rules,
 * rename and report for them. An agent's credential is refused: these are a person's own word,
 * and an agent never speaks it for its owner. A history-only grant holds only `read` (a table
 * constraint), so `post` refuses it with every other read-only grant.
 *
 * @param c - The request.
 * @param auth - The Community's auth.
 * @param pool - The database.
 * @param scope - `read` for the person's standing, `post` for anything that changes it.
 * @param options - `allowHeld` for the one change a host hold still allows: accepting the rules,
 *   which changes nothing anyone else sees. A browser session gets the same answer from the
 *   route's `requireLiveRole`.
 */
export async function requirePerson(
  c: Context,
  auth: CommunityAuth,
  pool: Pool,
  scope: 'read' | 'post',
  options: HeldRemovalOption = {}
): Promise<Person> {
  // A browser session: the existing path, with its own clearance check in `requireLiveRole`.
  if (!bearer(c)) return { member: await requireMember(c, auth, pool), recheck: async () => {} };
  const principal = await requirePrincipal(c, auth, pool, scope, true, options);
  if (principal.kind !== 'human')
    throw new ApiError(403, 'FORBIDDEN', 'Only a person can do this, not an agent.');
  const row = await pool.query<Member>(
    // member-kind: by-grant
    'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND community_id=$2 AND active',
    [principal.id, principal.community_id]
  );
  if (!row.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'You have not joined this space.');
  return {
    member: row.rows[0],
    recheck: (client) =>
      assertPrincipalCurrentInTransaction(client, principal, scope, undefined, options),
  };
}
