import type { Hono } from 'hono';
import type { PoolClient, Pool } from 'pg';
import { z } from 'zod';
import type { CommunityAuth } from '../../auth.js';
import { requireMember, type Member } from '../../data.js';
import { ApiError } from '../../http.js';
import { hashSecret, randomToken } from '../../security.js';

/**
 * The `administer` pairing scope (DOR-3005): how an owner or admin gives their own DorkOS app a
 * separate credential that manages the space for them, with their consent.
 *
 * - A request may ask for it only beside `read`.
 * - The approval page shows it only to an owner or admin, who must tick the consent line; any
 *   other approval drops it from the request, so a member's pairing never carries it.
 * - The exchange issues it only if the approver is still an owner or admin, as its own row in
 *   `connection_administer_grants` with its own token, never as a scope on the connection grant.
 * - The person can take it back on its own, keeping the connection.
 */

/** Whether a role may give its app the `administer` credential. */
function manages(role: Member['role'] | null): boolean {
  return role === 'owner' || role === 'admin';
}

/** Refuse a request that asks to manage a space without reading it. */
export function assertAdministerScopes(scopes: readonly string[]): void {
  if (scopes.includes('administer') && !scopes.includes('read'))
    throw new ApiError(400, 'STATE_CONFLICT', 'A connection that manages a space must read it.');
}

/** What the approval page shows its reader: `administer` only to an owner or admin. */
export function visibleScopes<Scope extends string>(
  scopes: readonly Scope[],
  role: Member['role'] | null
): Scope[] {
  return scopes.filter((scope) => scope !== 'administer' || manages(role));
}

/**
 * At approval, keep `administer` on the request only when an owner or admin consented to it; for
 * anyone else, or without the consent, drop it. Returns whether it was kept.
 */
export async function settleAdministerOnApproval(
  client: PoolClient,
  pairingId: string,
  communityId: string,
  role: Member['role'] | null,
  consented: boolean
): Promise<boolean> {
  const keep = consented && manages(role);
  const result = await client.query<{ scopes: string[] }>(
    `UPDATE connection_pairings
     SET scopes=CASE WHEN $3::boolean THEN scopes ELSE array_remove(scopes,'administer') END
     WHERE id=$1 AND community_id=$2 RETURNING scopes`,
    [pairingId, communityId, keep]
  );
  return result.rows[0]?.scopes.includes('administer') ?? false;
}

/**
 * At exchange, after the connection grant was created: issue the `administer` credential when the
 * request kept it and the approver is still an owner or admin of the active space. Returns its
 * token, once, or nothing.
 */
export async function issueAdministerCredential(
  client: PoolClient,
  input: { communityId: string; memberId: string; grantId: string; scopes: readonly string[] }
): Promise<string | undefined> {
  if (!input.scopes.includes('administer')) return undefined;
  const approver = await client.query<{ role: Member['role'] }>(
    // member-kind: by-grant
    `SELECT m.role FROM members m JOIN communities c ON c.id=m.community_id
     WHERE m.id=$1 AND m.community_id=$2 AND m.active AND m.kind='person' AND c.lifecycle='active'`,
    [input.memberId, input.communityId]
  );
  if (!manages(approver.rows[0]?.role ?? null)) return undefined;
  const token = randomToken();
  await client.query(
    `INSERT INTO connection_administer_grants(community_id,member_id,grant_id,token_hash)
     VALUES($1,$2,$3,$4)`,
    [input.communityId, input.memberId, input.grantId, hashSecret(token)]
  );
  return token;
}

/**
 * `DELETE /me/grants/:id/administer`: the person takes back the manage credential they gave one
 * of their installs, in their browser, and keeps the connection itself.
 */
export function registerAdministerGrantRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.delete('/me/grants/:id/administer', async (c) => {
    const actor = await requireMember(c, auth, pool, {
      allowSuspended: true,
      allowDeletionPending: true,
    });
    const grantId = z.uuid().parse(c.req.param('id'));
    // Taking access back needs no lifecycle or role: any state of the space allows it. The
    // audit row is written in the same statement, so a revoke is never unrecorded.
    const revoked = await pool.query(
      `WITH r AS (
         UPDATE connection_administer_grants SET revoked_at=COALESCE(revoked_at,now())
         WHERE grant_id=$1 AND member_id=$2 AND community_id=$3 RETURNING grant_id)
       INSERT INTO audit_events(community_id,actor_member_id,action,subject_id)
       SELECT $3,$2,'administer.revoke',grant_id::text FROM r RETURNING id`,
      [grantId, actor.id, actor.community_id]
    );
    if (!revoked.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Grant not found.');
    return c.body(null, 204);
  });
}
