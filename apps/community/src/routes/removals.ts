import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireEntryRemoveResponseSchema,
  type CommunityWireEntry,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  removalAuthority,
  removeAttachment,
  removeEntry,
  type RemovedBy,
} from '../content-removal.js';
import {
  bearer,
  lifecycleError,
  requireMember,
  transaction,
  type Member,
  type Principal,
} from '../data.js';
import { ApiError, json } from '../http.js';
import { hashSecret } from '../security.js';
import { resolveCommunityContext } from '../tenant-context.js';
import { attachmentsForEntries } from './attachments.js';
import { entryProjection, loadEntry, originKeyForPrincipal } from './entries.js';

const IdSchema = z.uuid();

/**
 * Lifecycles a removal may run in. Removal is not growth, so it works while a community is
 * archived or held; a suspended or closing community refuses it as it refuses every member
 * request.
 */
const REMOVAL_LIFECYCLES: ReadonlySet<string> = new Set(['active', 'archived', 'held']);

/** A principal allowed to ask for a removal, with the browser session it came from. */
export interface RemovalPrincipal extends Principal {
  /** The Better Auth session a browser request carried, rechecked inside the transaction. */
  sessionId?: string;
}

/**
 * Resolve who is asking to remove a message or file: a browser session for a live member, a
 * connection grant that can post and is not history-only, or an agent credential. A host API
 * key is refused with 401 before anything else. This applies the removal lifecycle rule
 * (active, archived, or held), not the posting rule.
 */
export async function requireRemovalPrincipal(
  c: Context,
  auth: CommunityAuth,
  pool: Pool
): Promise<RemovalPrincipal> {
  const token = bearer(c);
  const tenant = await resolveCommunityContext(c, pool);
  if (!REMOVAL_LIFECYCLES.has(tenant.lifecycle)) throw lifecycleError(tenant.lifecycle);
  if (!token) {
    const member = await requireMember(c, auth, pool);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    return {
      kind: 'human',
      id: member.id,
      ownerMemberId: member.id,
      display_name: member.display_name,
      community_id: member.community_id,
      sessionId: session.session.id,
    };
  }
  const tokenHash = hashSecret(token);
  const human = await pool.query<{
    id: string;
    display_name: string;
    community_id: string;
    scopes: string[];
    history_only: boolean;
  }>(
    `SELECT m.id,m.display_name,m.community_id,g.scopes,g.history_only FROM connection_grants g
     JOIN members m ON m.id=g.member_id WHERE g.token_hash=$1
       AND g.community_id=$2 AND m.community_id=$2 AND g.revoked_at IS NULL AND m.active`,
    [tokenHash, tenant.communityId]
  );
  const grant = human.rows[0];
  if (grant) {
    if (!grant.scopes.includes('post') || grant.history_only)
      throw new ApiError(403, 'FORBIDDEN', 'This connection cannot perform that action.');
    return {
      kind: 'human',
      id: grant.id,
      ownerMemberId: grant.id,
      display_name: grant.display_name,
      community_id: grant.community_id,
      credentialHash: tokenHash,
      credentialKind: 'grant',
      historyOnly: false,
    };
  }
  const agent = await pool.query<{
    id: string;
    display_name: string;
    community_id: string;
    owner_member_id: string;
  }>(
    `SELECT a.id,a.display_name,a.community_id,a.owner_member_id FROM agent_credentials ac
     JOIN agents a ON a.id=ac.agent_id JOIN members m ON m.id=a.owner_member_id
     WHERE ac.token_hash=$1 AND ac.community_id=$2 AND a.community_id=$2
       AND m.community_id=$2 AND ac.revoked_at IS NULL AND a.active AND m.active`,
    [tokenHash, tenant.communityId]
  );
  if (!agent.rows[0]) throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  return {
    kind: 'agent',
    id: agent.rows[0].id,
    ownerMemberId: agent.rows[0].owner_member_id,
    display_name: agent.rows[0].display_name,
    community_id: agent.rows[0].community_id,
    credentialHash: tokenHash,
    credentialKind: 'agent',
  };
}

/** One member row a removal ranks, as locked inside its transaction. */
export interface RankedMember {
  role: Member['role'];
  active: boolean;
}

/**
 * Inside a removal transaction: take the community row `FOR SHARE` and check the removal
 * lifecycle, lock the acting member and the member the content counts as (ordered by id, so two
 * removals and an ownership transfer never wait on each other in a cycle), then recheck the
 * exact credential the request carried. Members are locked before any entry, as erasure does,
 * so a removal racing an erasure waits instead of deadlocking.
 *
 * @returns The members read under their locks, by id. The actor is always present and active.
 */
export async function lockRemovalAuthority(
  client: PoolClient,
  principal: RemovalPrincipal,
  contentHumanId: string
): Promise<Map<string, RankedMember>> {
  const lifecycle = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [principal.community_id]
  );
  const current = lifecycle.rows[0]?.lifecycle ?? 'unavailable';
  if (!REMOVAL_LIFECYCLES.has(current)) throw lifecycleError(current);
  const members = await client.query<RankedMember & { id: string; user_id: string | null }>(
    `SELECT id,role,active,user_id FROM members WHERE community_id=$1 AND id=ANY($2::uuid[])
     ORDER BY id FOR SHARE`,
    [principal.community_id, [principal.ownerMemberId, contentHumanId]]
  );
  const ranked = new Map(members.rows.map((row) => [row.id, row]));
  const actor = ranked.get(principal.ownerMemberId);
  if (!actor?.active) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
  let valid = false;
  if (principal.kind === 'agent') {
    const agent = await client.query(
      `SELECT 1 FROM agents a JOIN agent_credentials ac ON ac.agent_id=a.id
       WHERE a.id=$1 AND a.community_id=$2 AND a.owner_member_id=$3 AND a.active
         AND ac.community_id=$2 AND ac.token_hash=$4 AND ac.revoked_at IS NULL
       FOR SHARE OF a, ac`,
      [principal.id, principal.community_id, principal.ownerMemberId, principal.credentialHash]
    );
    valid = Boolean(agent.rowCount);
  } else if (principal.credentialKind === 'grant') {
    const grant = await client.query(
      `SELECT 1 FROM connection_grants WHERE member_id=$1 AND community_id=$2
         AND token_hash=$3 AND revoked_at IS NULL AND scopes @> ARRAY['post']::text[]
         AND NOT history_only FOR SHARE`,
      [principal.id, principal.community_id, principal.credentialHash]
    );
    valid = Boolean(grant.rowCount);
  } else if (principal.sessionId && actor.user_id) {
    // Member removal locks M then deletes S; the member row is already locked above.
    const session = await client.query(
      'SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE',
      [principal.sessionId, actor.user_id]
    );
    valid = Boolean(session.rowCount);
  }
  if (!valid) throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  return ranked;
}

/** The author of a message or file, as the rank rule needs it. */
interface ContentAuthor {
  member_id: string | null;
  agent_id: string | null;
  agent_owner_member_id: string | null;
}

/**
 * Lock the actor and the content's human, then apply the rank rule. Authorship never changes,
 * so it is read before the locks; the roles are read under them.
 */
async function authorize(
  client: PoolClient,
  principal: RemovalPrincipal,
  author: ContentAuthor,
  refusal: string
): Promise<RemovedBy> {
  const humanId = author.member_id ?? author.agent_owner_member_id!;
  const ranked = await lockRemovalAuthority(client, principal, humanId);
  const actor = ranked.get(principal.ownerMemberId)!;
  const human = ranked.get(humanId)!;
  const removedBy = removalAuthority(
    { kind: principal.kind, id: principal.id, role: actor.role },
    {
      agentId: author.agent_id,
      humanId,
      humanRole: human.role,
      humanActive: human.active,
    }
  );
  if (!removedBy) throw new ApiError(403, 'FORBIDDEN', refusal);
  return removedBy;
}

/** Write the content-free tenant audit row for one removal: ids and field names only. */
async function audit(
  client: PoolClient,
  principal: RemovalPrincipal,
  input: { kind: 'entry' | 'attachment'; removedBy: RemovedBy; subjectId: string; fields: string[] }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
     VALUES($1,$2,$3,$4,$5::text[])`,
    [
      principal.community_id,
      principal.ownerMemberId,
      `${input.kind}.${input.removedBy === 'author' ? 'delete' : 'remove'}`,
      input.subjectId,
      input.fields,
    ]
  );
}

/** The entry as it stands now, in the wire form the actor would read it in. */
async function currentEntry(
  client: PoolClient,
  entryId: string,
  principal: RemovalPrincipal,
  config: CommunityConfig
): Promise<CommunityWireEntry> {
  const row = await loadEntry(client, entryId);
  const channel = await client.query<{ epoch: number }>('SELECT epoch FROM channels WHERE id=$1', [
    row.channel_id,
  ]);
  const attachments = await attachmentsForEntries(client, [entryId]);
  return entryProjection(
    row,
    channel.rows[0].epoch,
    config,
    attachments.get(entryId),
    principal.community_id,
    originKeyForPrincipal(row, principal)
  );
}

/**
 * Register removal of one message (`DELETE /entries/:entryId`) and one file
 * (`DELETE /attachments/:attachmentId`). Both remove in place through `content-removal.ts`, in
 * one transaction with their audit row, and answer with the entry as it now stands.
 */
export function registerRemovalRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
) {
  app.delete('/entries/:entryId', async (c) => {
    const principal = await requireRemovalPrincipal(c, auth, pool);
    const entryId = c.req.param('entryId');
    if (!IdSchema.safeParse(entryId).success)
      throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
    const entry = await transaction(pool, async (client) => {
      const found = await client.query<ContentAuthor>(
        `SELECT e.author_member_id AS member_id,e.author_agent_id AS agent_id,
           a.owner_member_id AS agent_owner_member_id
         FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.id=$1 AND e.community_id=$2`,
        [entryId, principal.community_id]
      );
      if (!found.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
      const removedBy = await authorize(
        client,
        principal,
        found.rows[0],
        "You can't remove this message."
      );
      const removed = await removeEntry(client, {
        communityId: principal.community_id,
        entryId,
        removedBy,
      });
      // A repeat, or an entry erasure already tombstoned, changes nothing and is not audited.
      if (removed.changed)
        await audit(client, principal, {
          kind: 'entry',
          removedBy,
          subjectId: entryId,
          fields: ['text', 'mentions', 'attachments'],
        });
      return currentEntry(client, entryId, principal, config);
    });
    return json(c, CommunityWireEntryRemoveResponseSchema, { entry });
  });

  app.delete('/attachments/:attachmentId', async (c) => {
    const principal = await requireRemovalPrincipal(c, auth, pool);
    const attachmentId = c.req.param('attachmentId');
    if (!IdSchema.safeParse(attachmentId).success)
      throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    const entry = await transaction(pool, async (client) => {
      const found = await client.query<ContentAuthor>(
        `SELECT f.uploader_member_id AS member_id,f.uploader_agent_id AS agent_id,
           a.owner_member_id AS agent_owner_member_id
         FROM attachments f LEFT JOIN agents a ON a.id=f.uploader_agent_id
         WHERE f.id=$1 AND f.community_id=$2`,
        [attachmentId, principal.community_id]
      );
      if (!found.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
      const removedBy = await authorize(
        client,
        principal,
        found.rows[0],
        "You can't remove this file."
      );
      const removed = await removeAttachment(client, {
        communityId: principal.community_id,
        attachmentId,
        removedBy,
      });
      await audit(client, principal, {
        kind: 'attachment',
        removedBy,
        subjectId: attachmentId,
        fields: removed.entryTombstoned ? ['text', 'mentions', 'attachments'] : ['attachments'],
      });
      return removed.entryId ? currentEntry(client, removed.entryId, principal, config) : null;
    });
    if (!entry) return c.body(null, 204);
    return json(c, CommunityWireEntryRemoveResponseSchema, { entry });
  });
}
