import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import type { CommunityAuth } from '../auth.js';
import { bearer, requireMember, type Member } from '../data.js';
import { ApiError } from '../http.js';
import { hashSecret } from '../security.js';
import { resolveCommunityContext } from '../tenant-context.js';

/** The person managing a space, and how to recheck the credential they reached it with. */
export interface Administrator {
  /** Their membership. Its role is checked again, live, by every route that uses it. */
  member: Member;
  /** Inside the route's transaction: refuse if the credential was revoked meanwhile. */
  recheck: (client: PoolClient) => Promise<void>;
  /**
   * How they reached the space: their own browser `session`, or the `administer` credential an
   * owner or admin gave their own DorkOS app when they paired it (DOR-3005).
   */
  credential: 'session' | 'administer';
}

/**
 * Require the PERSON managing a space: their browser session, or the `administer` credential
 * they gave their own paired app with their consent (DOR-3005). Only that bearer passes; any
 * other gets 401: a connection grant (even an owner's), an agent's credential, and an unknown,
 * revoked or other space's credential. The `administer` credential lives in its own table and is
 * refused once the grant it came with is revoked. A host key never gets here (`bearer`).
 *
 * It decides who is asking, never what they may do: every route that uses it still checks the
 * member's role live, inside its transaction, on every call, exactly as it does for the browser,
 * so a demoted admin is refused at once. Then it calls `recheck`.
 *
 * @param c - The request.
 * @param auth - The space's auth.
 * @param pool - The database.
 */
export async function requireAdministrator(
  c: Context,
  auth: CommunityAuth,
  pool: Pool
): Promise<Administrator> {
  const token = bearer(c);
  if (!token)
    return {
      member: await requireMember(c, auth, pool),
      recheck: async () => {},
      credential: 'session',
    };
  const tenant = await resolveCommunityContext(c, pool);
  const tokenHash = hashSecret(token);
  const found = await pool.query<Member & { administer_id: string }>(
    // member-kind: by-grant
    `SELECT m.id,m.user_id,m.display_name,m.role,m.community_id,a.id AS administer_id
     FROM connection_administer_grants a
     JOIN connection_grants g ON g.id=a.grant_id AND g.member_id=a.member_id
     JOIN members m ON m.id=a.member_id
     WHERE a.token_hash=$1 AND a.community_id=$2 AND g.community_id=$2 AND m.community_id=$2
       AND a.revoked_at IS NULL AND g.revoked_at IS NULL AND m.active AND m.kind='person'`,
    [tokenHash, tenant.communityId]
  );
  const row = found.rows[0];
  // Anything else is refused as the browser path always refused a bearer: a connection grant, an
  // agent's credential, and a revoked or another space's credential alike.
  if (!row) throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  // At most once a minute, as a connection grant is touched.
  await pool.query(
    "UPDATE connection_administer_grants SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",
    [row.administer_id]
  );
  const { administer_id: administerId, ...member } = row;
  return {
    member,
    recheck: (client) => assertAdministerCurrent(client, administerId, member),
    credential: 'administer',
  };
}

/**
 * Refuse the app's `administer` credential for a move that hits other people hard: making or
 * unmaking an admin, removing a member, and changing who may join (#3155 review, M2). A person
 * makes those in their browser, so an agent holding the app's credential never can.
 *
 * @param credential - How the caller reached the space ({@link Administrator.credential}).
 */
export function browserOnly(credential: Administrator['credential']): void {
  if (credential === 'administer') throw new ApiError(403, 'FORBIDDEN', 'Do this in your browser.');
}

/**
 * Recheck, on the route's own transaction, that the credential and its grant are still live. It
 * also marks the transaction, so every audit row the route writes says the app acted
 * (`audit_events.via`, migration 0047).
 */
async function assertAdministerCurrent(
  client: PoolClient,
  administerId: string,
  member: Member
): Promise<void> {
  const current = await client.query(
    `SELECT 1 FROM connection_administer_grants a JOIN connection_grants g ON g.id=a.grant_id
     WHERE a.id=$1 AND a.member_id=$2 AND a.community_id=$3
       AND a.revoked_at IS NULL AND g.revoked_at IS NULL`,
    [administerId, member.id, member.community_id]
  );
  if (!current.rowCount)
    throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  await client.query("SELECT set_config('dorkos.audit_via','administer',true)");
}
