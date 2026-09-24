import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type { CommunityAdminHostApiKeyScopeSchema } from '@dorkos/shared/community-admin-wire';
import type { CommunityAuth } from '../auth.js';
import { requireSessionUser } from '../data.js';
import { ApiError } from '../http.js';
import { HOST_API_KEY_PATTERN, bearerCredential, hashSecret } from '../security.js';

/** One host API key scope. No scope reaches community content or manages keys. */
export type HostApiKeyScope = z.infer<typeof CommunityAdminHostApiKeyScopeSchema>;

/** A host operator acting through their own browser session. */
export interface HostPersonActor {
  kind: 'person';
  userId: string;
  name: string;
}

/** A host API key acting within the scopes it was issued with. */
export interface HostKeyActor {
  kind: 'api_key';
  keyId: string;
  scopes: readonly HostApiKeyScope[];
}

/** Whoever holds host authority for one request. A person holds every scope. */
export type HostActor = HostPersonActor | HostKeyActor;

/**
 * Every actor a host audit row can name: a person, a key, the offline key command, or the
 * server itself (the import worker). Only the identity is recorded, so any {@link HostActor}
 * is one.
 */
export type HostAuditActor =
  | Pick<HostPersonActor, 'kind' | 'userId'>
  | Pick<HostKeyActor, 'kind' | 'keyId'>
  | { kind: 'offline' }
  | { kind: 'system' };

/** Append one metadata-only host audit row naming its actor. Never pass values, only field names. */
export async function recordHostAudit(
  client: PoolClient,
  actor: HostAuditActor,
  event: {
    action: string;
    communityId?: string | null;
    priorState?: string | null;
    nextState?: string | null;
    changedFields?: readonly string[];
    subjectApiKeyId?: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO host_audit_events(
       actor_kind,actor_user_id,actor_api_key_id,subject_api_key_id,
       community_id,action,prior_state,next_state,changed_fields
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text[])`,
    [
      actor.kind,
      actor.kind === 'person' ? actor.userId : null,
      actor.kind === 'api_key' ? actor.keyId : null,
      event.subjectApiKeyId ?? null,
      event.communityId ?? null,
      event.action,
      event.priorState ?? null,
      event.nextState ?? null,
      event.changedFields ?? [],
    ]
  );
}

/**
 * Recheck host authority inside a write transaction, after the rows it will change are locked.
 *
 * A key row is re-read `FOR SHARE` with the same live predicate as authentication, so a
 * revocation or expiry that commits before this point always wins over a waiting request.
 */
export async function assertHostActor(
  client: PoolClient,
  actor: HostActor,
  now: Date
): Promise<void> {
  if (actor.kind === 'person') {
    const operator = await client.query(
      'SELECT 1 FROM host_operators WHERE user_id=$1 AND revoked_at IS NULL FOR SHARE',
      [actor.userId]
    );
    if (!operator.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Host operator access ended.');
    return;
  }
  const key = await client.query(
    `SELECT 1 FROM host_api_keys
     WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) FOR SHARE`,
    [actor.keyId, now]
  );
  if (!key.rowCount) throw new ApiError(401, 'UNAUTHENTICATED', 'This host API key is not valid.');
}

async function requireHostPerson(
  c: Context,
  auth: CommunityAuth,
  pool: Pool
): Promise<HostPersonActor> {
  const user = await requireSessionUser(c, auth);
  const operator = await pool.query(
    'SELECT 1 FROM host_operators WHERE user_id=$1 AND revoked_at IS NULL',
    [user.id]
  );
  if (!operator.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Host operator access is required.');
  return { kind: 'person', userId: user.id, name: user.name };
}

/** Request-time host authority: a key or a host operator's session, never both. */
export interface HostAuthority {
  /**
   * Authenticate a host route that needs `scope`.
   *
   * With an `Authorization` header only a host API key is considered and any session cookie
   * on the same request is ignored. Without one, the caller must be a signed-in host operator.
   */
  require(c: Context, scope: HostApiKeyScope): Promise<HostActor>;
  /** Authenticate key management, which only a signed-in host operator may do. */
  requireSession(c: Context): Promise<HostPersonActor>;
}

/** Build the host authority pipeline for one app. */
export function createHostAuthority(deps: {
  auth: CommunityAuth;
  pool: Pool;
  now: () => Date;
  /** Count one failed key attempt against the caller; throws once the caller is over its limit. */
  limitKeyMiss: (c: Context) => void;
}): HostAuthority {
  const { auth, pool, now, limitKeyMiss } = deps;

  async function touch(keyId: string, at: Date): Promise<void> {
    // At most once a minute, outside the request's own transaction, and never waiting on a
    // key row another request holds: a busy row just skips this update.
    try {
      await pool.query(
        `UPDATE host_api_keys SET last_used_at=$2
         WHERE id IN (
           SELECT id FROM host_api_keys
           WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<$2::timestamptz-interval '1 minute')
           FOR UPDATE SKIP LOCKED
         )`,
        [keyId, at]
      );
    } catch (error) {
      console.error(
        'Host API key last-use update unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
    }
  }

  return {
    async require(c, scope) {
      const authorization = c.req.header('authorization');
      if (authorization === undefined) return requireHostPerson(c, auth, pool);
      const secret = bearerCredential(authorization) ?? '';
      const at = now();
      const key = HOST_API_KEY_PATTERN.test(secret)
        ? await pool.query<{ id: string; scopes: HostApiKeyScope[] }>(
            `SELECT id,scopes FROM host_api_keys
             WHERE secret_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)`,
            [hashSecret(secret), at]
          )
        : { rows: [] };
      const row = key.rows[0];
      if (!row) {
        limitKeyMiss(c);
        throw new ApiError(401, 'UNAUTHENTICATED', 'A valid host API key is required.');
      }
      if (!row.scopes.includes(scope)) {
        throw new ApiError(403, 'FORBIDDEN', 'This key does not allow that action.');
      }
      await touch(row.id, at);
      return { kind: 'api_key', keyId: row.id, scopes: row.scopes };
    },
    async requireSession(c) {
      if (c.req.header('authorization') !== undefined) {
        throw new ApiError(403, 'FORBIDDEN', 'A host API key cannot manage keys.');
      }
      return requireHostPerson(c, auth, pool);
    },
  };
}
