/**
 * Every live stream's access check, batched: the streams that ask in the same moment are checked
 * in one query per kind of credential, not one query each.
 *
 * At 10,000 open streams the quiet-time rechecks alone came to about 600 queries a second, each
 * waiting for a pooled connection, and posts queued behind them for seconds. The checks are the
 * same as one stream's own (`readStreamAccess` explains them); only the round trips are shared.
 */
import type { Pool } from 'pg';
import type { Principal } from '../../data.js';
import type { OpenedSession, StreamAccess } from './event-stream-access.js';

/** At most this many checks share one query. */
const BATCH_MAX = 500;

/** One stream's request: who, with which credential, on which channel. */
interface Request {
  principal: Principal;
  openedSession: OpenedSession;
  channelId: string;
  resolve: (state: StreamAccess | undefined) => void;
  reject: (error: unknown) => void;
}

type Kind = 'agent' | 'grant' | 'cookie';

const COLUMNS = `ch.archived,ch.epoch,co.lifecycle,(co.takedown_id IS NOT NULL) AS taken_down`;

/**
 * One query per kind. Each `unnest` row is one request, numbered by `i`; a request that matches
 * nothing (its credential sees nothing) has no row, exactly as one stream's own query has none.
 */
const SQL: Record<Kind, string> = {
  // member-kind: agent-owner
  agent: `SELECT r.i,(a.active AND owner.active) AS active,(cm.agent_id IS NOT NULL) AS joined,${COLUMNS},
      NULL::timestamptz AS expires_at
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[])
      WITH ORDINALITY AS r(agent_id,channel_id,community_id,token_hash,owner_id,i)
    JOIN agents a ON a.id=r.agent_id::uuid AND a.community_id=r.community_id::uuid
      AND a.owner_member_id=r.owner_id::uuid
    JOIN members owner ON owner.id=a.owner_member_id
    JOIN communities co ON co.id=a.community_id
    JOIN channels ch ON ch.id=r.channel_id::uuid AND ch.community_id=r.community_id::uuid
    LEFT JOIN agent_channel_members cm ON cm.channel_id=ch.id AND cm.agent_id=a.id
    WHERE EXISTS (SELECT 1 FROM agent_credentials ac WHERE ac.agent_id=a.id
      AND ac.token_hash=r.token_hash AND ac.revoked_at IS NULL)`,
  // member-kind: by-grant
  grant: `SELECT r.i,m.active,(cm.member_id IS NOT NULL) AS joined,${COLUMNS},
      NULL::timestamptz AS expires_at
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[])
      WITH ORDINALITY AS r(member_id,channel_id,community_id,token_hash,i)
    JOIN members m ON m.id=r.member_id::uuid AND m.community_id=r.community_id::uuid
    JOIN communities co ON co.id=m.community_id
    JOIN channels ch ON ch.id=r.channel_id::uuid AND ch.community_id=r.community_id::uuid
    LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.member_id=m.id
    WHERE EXISTS (SELECT 1 FROM connection_grants g WHERE g.member_id=m.id
      AND g.token_hash=r.token_hash AND g.revoked_at IS NULL
      AND g.scopes @> ARRAY['read']::text[] AND NOT g.history_only)`,
  // member-kind: by-grant
  cookie: `SELECT r.i,m.active,(cm.member_id IS NOT NULL) AS joined,${COLUMNS},s."expiresAt" AS expires_at
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[])
      WITH ORDINALITY AS r(member_id,channel_id,community_id,session_id,user_id,token,i)
    JOIN members m ON m.id=r.member_id::uuid AND m.community_id=r.community_id::uuid
    JOIN communities co ON co.id=m.community_id
    JOIN channels ch ON ch.id=r.channel_id::uuid AND ch.community_id=r.community_id::uuid
    JOIN session s ON s.id=r.session_id AND s."userId"=m.user_id AND s."userId"=r.user_id
      AND s.token=r.token AND s."expiresAt">now()
    LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.member_id=m.id`,
};

function kindOf(principal: Principal): Kind {
  if (principal.kind === 'agent') return 'agent';
  return principal.credentialKind === 'grant' ? 'grant' : 'cookie';
}

function valuesOf(kind: Kind, batch: readonly Request[]): string[][] {
  const column = (pick: (request: Request) => string) => batch.map(pick);
  const shared = [
    column((r) => r.principal.id),
    column((r) => r.channelId),
    column((r) => r.principal.community_id),
  ];
  if (kind === 'agent')
    return [
      ...shared,
      column((r) => r.principal.credentialHash!),
      column((r) => r.principal.ownerMemberId),
    ];
  if (kind === 'grant') return [...shared, column((r) => r.principal.credentialHash!)];
  return [
    ...shared,
    column((r) => r.openedSession!.session.id),
    column((r) => r.openedSession!.user.id),
    column((r) => r.openedSession!.session.token),
  ];
}

/** The batcher for one pool. */
class StreamAccessBatcher {
  private readonly waiting: Record<Kind, Request[]> = { agent: [], grant: [], cookie: [] };
  private scheduled = false;

  constructor(private readonly pool: Pool) {}

  read(principal: Principal, openedSession: OpenedSession, channelId: string) {
    return new Promise<StreamAccess | undefined>((resolve, reject) => {
      this.waiting[kindOf(principal)].push({
        principal,
        openedSession,
        channelId,
        resolve,
        reject,
      });
      if (this.scheduled) return;
      this.scheduled = true;
      // Everything asked in this turn of the event loop shares the queries.
      setImmediate(() => this.flush());
    });
  }

  private flush(): void {
    this.scheduled = false;
    for (const kind of ['agent', 'grant', 'cookie'] as const) {
      const all = this.waiting[kind];
      this.waiting[kind] = [];
      for (let from = 0; from < all.length; from += BATCH_MAX)
        void this.run(kind, all.slice(from, from + BATCH_MAX));
    }
  }

  private async run(kind: Kind, batch: Request[]): Promise<void> {
    try {
      const result = await this.pool.query<StreamAccess & { i: string }>(
        SQL[kind],
        valuesOf(kind, batch)
      );
      const found = new Map(result.rows.map(({ i, ...state }) => [Number(i), state]));
      batch.forEach((request, index) => request.resolve(found.get(index + 1)));
    } catch (error) {
      for (const request of batch) request.reject(error);
    }
  }
}

const batchers = new WeakMap<Pool, StreamAccessBatcher>();

/**
 * Check one stream's access, in a query it shares with every other stream that asks in the same
 * turn of the event loop. Resolves to the stream's access, or undefined when its credential no
 * longer sees the channel at all.
 *
 * @param pool - Database pool.
 * @param principal - The member or agent the stream belongs to.
 * @param openedSession - The browser session the stream opened with; required for a cookie.
 * @param channelId - The stream's channel.
 */
export function readStreamAccessBatched(
  pool: Pool,
  principal: Principal,
  openedSession: OpenedSession,
  channelId: string
): Promise<StreamAccess | undefined> {
  let batcher = batchers.get(pool);
  if (!batcher) batchers.set(pool, (batcher = new StreamAccessBatcher(pool)));
  return batcher.read(principal, openedSession, channelId);
}
