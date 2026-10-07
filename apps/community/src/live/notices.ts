import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/** The one Postgres `LISTEN` channel every live notice travels on. */
export const LIVE_NOTICE_CHANNEL = 'community_live';

const id = z.string().min(1).max(64);

/**
 * One live notice. It names what changed by id only, never content: Postgres caps a `NOTIFY`
 * payload at 8 kB, and a notice is a wake-up, not data. Each stream that the notice touches reads
 * what it needs itself.
 *
 * - `entry`: a new message in a channel. Wakes that channel's streams and counts as a post.
 * - `content`: messages in a channel were removed, redacted or restored in bulk. Wakes the
 *   channel's streams without counting as posts.
 * - `channel`: a channel was archived, reopened, deleted or had its history reset. Rechecks
 *   every stream on the channel.
 * - `community`: the space's lifecycle changed (held, suspended, archived, taken down, deleted).
 *   Rechecks every stream in it.
 * - `member`: a member's access changed: deactivated, banned, muted, removed from a channel, or a
 *   connection of theirs revoked. Rechecks their streams and their agents' streams.
 * - `agent`: an agent was deactivated, removed from a channel, or its credential revoked.
 * - `user`: an account's sign-in sessions ended, in every space it belongs to.
 * - `join`: someone joined a space. Counted for monitoring only.
 * - `probe`: the listener's own startup self-test.
 */
export const LiveNoticeSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('entry'), c: id, ch: id }),
  z.object({ k: z.literal('content'), c: id, ch: id }),
  z.object({ k: z.literal('channel'), c: id, ch: id }),
  z.object({ k: z.literal('community'), c: id }),
  z.object({ k: z.literal('member'), c: id, m: id }),
  z.object({ k: z.literal('agent'), c: id, a: id }),
  z.object({ k: z.literal('user'), u: id }),
  z.object({ k: z.literal('join'), c: id }),
  z.object({ k: z.literal('probe'), p: id }),
]);

/** One live notice; see {@link LiveNoticeSchema}. */
export type LiveNotice = z.infer<typeof LiveNoticeSchema>;

/** A pool or a transaction's client: anything that can run one statement. */
export type LiveNoticeTarget = Pick<Pool | PoolClient, 'query'>;

/**
 * Send live notices. Inside a transaction Postgres holds them until `COMMIT` and drops them on
 * `ROLLBACK`, so call this on the transaction's own client, beside the write it announces: a
 * stream then never wakes for a change it cannot read yet, nor for one that never happened.
 * Identical notices in one transaction are delivered once.
 */
export async function notifyLive(
  db: LiveNoticeTarget,
  ...notices: ReadonlyArray<LiveNotice | null | undefined>
): Promise<void> {
  const payloads = [
    ...new Set(
      notices.filter((notice): notice is LiveNotice => !!notice).map((n) => JSON.stringify(n))
    ),
  ];
  if (!payloads.length) return;
  await db.query('SELECT pg_notify($1, payload) FROM unnest($2::text[]) AS payload', [
    LIVE_NOTICE_CHANNEL,
    payloads,
  ]);
}

/**
 * Announce that one account's access ended everywhere: its sign-in sessions, and every
 * membership it holds, so streams opened with a connection or by one of its agents recheck too.
 * Run it before deleting the account's rows, while its memberships can still be found.
 */
export async function notifyAccountAccess(db: LiveNoticeTarget, userId: string): Promise<void> {
  await db.query(
    `SELECT pg_notify($1, notice) FROM (
       SELECT json_build_object('k','user','u',$2::text)::text AS notice
       UNION
       SELECT json_build_object('k','member','c',community_id,'m',id)::text
       FROM members WHERE user_id=$2
     ) notices`,
    [LIVE_NOTICE_CHANNEL, userId]
  );
}

/** Read one received payload, or null for anything that is not a well-formed notice. */
export function parseLiveNotice(payload: string | undefined): LiveNotice | null {
  if (!payload) return null;
  try {
    const parsed = LiveNoticeSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
