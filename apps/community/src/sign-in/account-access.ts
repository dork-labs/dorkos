import type { PoolClient } from 'pg';

/** What {@link clearAccountAccess} keeps. Everything else that reaches the account ends. */
export interface AccountAccessKeep {
  /** Keep the password (`credential`) row. Recovery keeps it to overwrite it; a link does not. */
  password: boolean;
  /** Keep the Google, GitHub and single sign-on links (`recover-password --keep-linked`). */
  links: boolean;
}

/**
 * End every way into one host account that existed before now, in the caller's transaction.
 *
 * The caller must already hold the account's `"user"` row and every one of its `members` rows
 * `FOR UPDATE` (members in `community_id,id` order), so a concurrent tenant mutation cannot leave
 * one community's derived credentials valid. Password recovery and a trusted sign-in that takes
 * over a never-confirmed account both run this one clean-out, so the two can never drift:
 *
 * - its sign-in rows (the password unless kept, and the provider links unless kept);
 * - every session;
 * - the connection grants, unfinished pairings and agent credentials of every membership;
 * - the host API keys the account issued, and the invitation links it issued that still work;
 * - its sign-ins waiting to be linked by password;
 * - any session a sign-in that began before this transaction commits goes on to make: the
 *   account is stamped with this transaction (`access_cleared_xid`), and the session hooks refuse
 *   and delete such a session.
 *
 * Removed provider links are audited as `member.sign_in_links_removed` in every community the
 * account is in, and each revoked host key as `api_key.revoke` by the system.
 *
 * @param memberIds - The account's memberships, locked by the caller.
 * @param hostActor - Who the host audit names: `offline` for the recovery command, `system`
 *   for a sign-in.
 * @returns The provider ids of the sign-in rows removed, sorted, `credential` included.
 */
export async function clearAccountAccess(
  client: PoolClient,
  userId: string,
  memberIds: readonly string[],
  keep: AccountAccessKeep,
  hostActor: 'offline' | 'system'
): Promise<string[]> {
  // Stamped first: a sign-in that began before this transaction commits cannot keep the session
  // it makes, whatever it read (see sign-in/request-start.ts).
  await client.query('UPDATE "user" SET access_cleared_xid=pg_current_xact_id() WHERE id=$1', [
    userId,
  ]);
  const removed = new Set<string>();
  if (!keep.password || !keep.links) {
    const deleted = await client.query<{ providerId: string }>(
      `DELETE FROM account WHERE "userId"=$1 AND (
         ("providerId"='credential' AND $2::boolean) OR ("providerId"<>'credential' AND $3::boolean)
       ) RETURNING "providerId"`,
      [userId, !keep.password, !keep.links]
    );
    for (const row of deleted.rows) removed.add(row.providerId);
  }
  const links = [...removed].filter((provider) => provider !== 'credential').sort();
  if (links.length)
    await client.query(
      `INSERT INTO audit_events(community_id,action,subject_id,changed_fields)
       SELECT community_id,'member.sign_in_links_removed',id,$2::text[] FROM members
       WHERE id=ANY($1::uuid[]) ORDER BY community_id,id`,
      [memberIds, links]
    );
  await client.query('DELETE FROM session WHERE "userId"=$1', [userId]);
  await client.query(
    `UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now())
     WHERE member_id=ANY($1::uuid[])`,
    [memberIds]
  );
  await client.query(
    `UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now())
     WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=ANY($1::uuid[]))`,
    [memberIds]
  );
  await client.query(
    `UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now())
     WHERE member_id=ANY($1::uuid[])`,
    [memberIds]
  );
  // An invitation the account issued would let someone join on its say-so after it changed hands.
  await client.query(
    `UPDATE invites SET revoked_at=now()
     WHERE issuer_member_id=ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at>now()`,
    [memberIds]
  );
  const keys = await client.query<{ id: string }>(
    `UPDATE host_api_keys SET revoked_at=now()
     WHERE issued_by_user_id=$1 AND revoked_at IS NULL RETURNING id`,
    [userId]
  );
  for (const key of keys.rows)
    await client.query(
      `INSERT INTO host_audit_events(actor_kind,subject_api_key_id,action,changed_fields)
       VALUES($1,$2,'api_key.revoke',ARRAY['revoked_at'])`,
      [hostActor, key.id]
    );
  // Recovery may run from a new image before its server has applied migration 0031.
  const pending = await client.query<{ present: boolean }>(
    "SELECT to_regclass('pending_sign_in_links') IS NOT NULL AS present"
  );
  if (pending.rows[0]?.present)
    await client.query('DELETE FROM pending_sign_in_links WHERE user_id=$1', [userId]);
  return [...removed].sort();
}
