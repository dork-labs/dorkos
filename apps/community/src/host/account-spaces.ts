import type { Pool } from 'pg';
import { HOST_ACCOUNT_SPACES_MAX } from '@dorkos/shared/community-admin-wire';
import type { HostActor } from './authority.js';

/** One space an account belongs to, as the host's account-spaces answer lists it. */
export interface AccountSpace {
  communityId: string;
  name: string;
  url: string;
  role: 'owner' | 'admin' | 'member';
  state: 'active' | 'archived';
}

/**
 * The spaces an account belongs to as a person (DOR-2954), sorted by name, at most
 * {@link HOST_ACCOUNT_SPACES_MAX}. Only a current membership counts: active, never
 * removed, erased or under a standing ban. Only a space that is open or archived counts: one that
 * is held, suspended, waiting to be deleted or still waiting for an owner is left out. An agent's
 * membership has no account; the kind filter keeps it out anyway.
 *
 * @param pool - The database.
 * @param accountId - The account, already resolved from its sign-in identity.
 * @param publicUrl - This server's public origin, which every space's address starts with.
 */
export async function listAccountSpaces(
  pool: Pool,
  accountId: string,
  publicUrl: string
): Promise<{ spaces: AccountSpace[]; truncated: boolean }> {
  // One past the cap, so the answer can say there were more without counting them.
  const result = await pool.query<{
    id: string;
    name: string;
    role: AccountSpace['role'];
    lifecycle: AccountSpace['state'];
  }>(
    `SELECT c.id,c.name,m.role,c.lifecycle
     FROM members m JOIN communities c ON c.id=m.community_id
     WHERE m.user_id=$1 AND m.kind='person' AND m.active
       AND m.removed_at IS NULL AND m.erased_at IS NULL
       AND c.lifecycle IN ('active','archived')
       AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.community_id=m.community_id
                         AND b.member_id=m.id AND b.lifted_at IS NULL)
     ORDER BY lower(c.name),c.id
     LIMIT $2`,
    [accountId, HOST_ACCOUNT_SPACES_MAX + 1]
  );
  const rows = result.rows.slice(0, HOST_ACCOUNT_SPACES_MAX);
  return {
    spaces: rows.map((row) => ({
      communityId: row.id,
      name: row.name,
      // The id address always opens the space; a short name can change or be released.
      url: `${publicUrl}/c/${row.id}`,
      role: row.role,
      state: row.lifecycle,
    })),
    truncated: result.rows.length > HOST_ACCOUNT_SPACES_MAX,
  };
}

/** The one log line an account-spaces answer writes: ids and a count, never the identity. */
export function accountSpacesLogLine(event: {
  /** Null when no account signs in with the identity asked about. */
  accountId: string | null;
  actor: HostActor;
  count: number;
  truncated: boolean;
}): string {
  return JSON.stringify({
    event: 'community.account.spaces',
    accountId: event.accountId,
    actorKind: event.actor.kind,
    actorId: event.actor.kind === 'person' ? event.actor.userId : event.actor.keyId,
    count: event.count,
    truncated: event.truncated,
  });
}
