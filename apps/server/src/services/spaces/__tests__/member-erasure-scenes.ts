import type { Pool } from 'pg';
import {
  admit,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { body, PASSWORD, person, post, upload, type Person } from './member-erasure-fixture.js';

let sceneCount = 0;

/** One community with an owner, the person P, and Q who mentions P. */
export interface Scene {
  slug: string;
  communityId: string;
  base: string;
  owner: TenancyMember;
  channelId: string;
  p: Person;
  q: Person;
  grant: string;
  agent: { id: string; handle: string; token: string };
  pEntryId: string;
  qMentionId: string;
}

/** A community with an owner, the person P (entry, file, agent, pairing), and Q mentioning P. */
export async function makeScene(
  h: TenancyHarness,
  hostCookie: string,
  label: string
): Promise<Scene> {
  const slug = `${label}${++sceneCount}`;
  const pending = await createPendingCommunity(h, hostCookie, `Scene ${slug}`);
  // Names repeat per label (only emails must be unique), so crash runs compare like for like.
  const owner = await claimAsNewAccount(h, pending.token, `Owner ${label}`, `owner-${slug}@x.test`);
  const communityId = pending.communityId;
  const base = `/api/v1/communities/${communityId}`;
  const p = await person(
    h,
    await admit(h, communityId, owner.cookie, { name: `Pat ${label}`, email: `pat-${slug}@x.test` })
  );
  const q = await person(
    h,
    await admit(h, communityId, owner.cookie, {
      name: `Quin ${label}`,
      email: `quin-${slug}@x.test`,
    })
  );
  const channelId = await createChannel(h, communityId, owner.cookie, 'general', [
    p.cookie,
    q.cookie,
  ]);
  const grant = await pairInstall(
    h,
    communityId,
    p.cookie,
    ['read', 'post', 'enroll-agent'],
    `laptop ${label}`
  );
  const enrolled = await body<{ token: string; agent: { memberId: string; handle: string } }>(
    await h.call(`${base}/agents`, {
      bearer: grant,
      body: { localAgentId: `local-${label}`, displayName: `Bot ${label}` },
    }),
    201,
    'enroll'
  );
  const agent = {
    id: enrolled.agent.memberId,
    handle: enrolled.agent.handle,
    token: enrolled.token,
  };
  await body(
    await h.call(`${base}/channels/${channelId}/agents`, {
      cookie: p.cookie,
      body: { agentId: agent.id },
    }),
    200,
    'agent joins'
  );
  const pEntry = await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: `hello from ${p.handle}`,
      idempotencyKey: 'p-hello',
    }
  );
  await post(
    h,
    communityId,
    channelId,
    { bearer: agent.token },
    {
      text: 'agent note',
      idempotencyKey: 'agent-note',
    }
  );
  const file = await upload(h, communityId, channelId, p.cookie, 'notes.txt', `notes of ${slug}`);
  await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: 'a file',
      idempotencyKey: 'p-file',
      attachmentIds: [file],
    }
  );
  const qMention = await post(
    h,
    communityId,
    channelId,
    { cookie: q.cookie },
    {
      text: `@${p.handle} and @${agent.handle} thanks`,
      idempotencyKey: 'q-mention',
    }
  );
  return {
    slug,
    communityId,
    base,
    owner,
    channelId,
    p,
    q,
    grant,
    agent,
    pEntryId: pEntry.id,
    qMentionId: qMention.id,
  };
}

/** Start and bind a fresh invitation for `cookie`'s account, ready to redeem. */
export async function bindInvite(
  h: TenancyHarness,
  base: string,
  ownerCookie: string,
  cookie: string
): Promise<string> {
  const invite = await body<{ token: string }>(
    await h.call(`${base}/invites`, { cookie: ownerCookie, body: { seats: 1 } }),
    201,
    'invite'
  );
  const preflight = await expectStatus(
    await h.call(`${base}/invites/preflight`, { body: { token: invite.token } }),
    200,
    'preflight'
  );
  const admission = preflight.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const session = cookie
    .split('; ')
    .filter((part) => !part.startsWith('community_admission='))
    .join('; ');
  const bound = `${session}; ${admission}`;
  await body(await h.call(`${base}/invites/bind`, { cookie: bound, body: {} }), 200, 'bind');
  return bound;
}

/** Ask to erase one's own membership, with the fixture password. */
export async function requestErasure(h: TenancyHarness, cookie: string, communityId: string) {
  return body<{ erasure: { id: string; state: string; executeAfter: string; createdAt: string } }>(
    await h.call('/api/v1/account/erasures', {
      cookie,
      body: { kind: 'membership', communityId, password: PASSWORD },
    }),
    201,
    'request membership erasure'
  );
}

/** Every row of one community, outside the given tables, as one comparable value. */
export async function communityDigest(
  pool: Pool,
  communityId: string,
  exclude: string[] = []
): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema='public' AND column_name='community_id' ORDER BY table_name`
  );
  const digest: Record<string, unknown> = {};
  for (const { table_name: table } of tables.rows) {
    if (exclude.includes(table)) continue;
    digest[table] = (
      await pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows
         FROM "${table}" t WHERE community_id=$1`,
        [communityId]
      )
    ).rows[0].rows;
  }
  return JSON.stringify(digest);
}

/** The final shape of an erased scene without ids, clocks, or counters, for crash runs. */
export async function shapeDigest(pool: Pool, s: Scene): Promise<string> {
  const q = async (sql: string) => (await pool.query(sql, [s.communityId])).rows;
  return JSON.stringify({
    entries: await q(
      `SELECT seq,author_agent_id IS NULL AS human,text,author_display_name,
              idempotency_key LIKE 'erased:%' AS erased_key,erased_at IS NOT NULL AS erased,
              (SELECT count(*) FROM entry_mentions m WHERE m.entry_id=e.id)::int AS mentions
       FROM entries e WHERE community_id=$1 ORDER BY seq`
    ),
    members: await q(
      `SELECT role,display_name,active,user_id IS NULL AS unlinked,erased_at IS NOT NULL AS erased,
              handle LIKE 'erased-%' AS husk
       FROM members WHERE community_id=$1 ORDER BY created_at,display_name`
    ),
    agents: await q(
      `SELECT display_name,active,handle LIKE 'erased-%' AS husk,local_agent_id IS NULL AS unlinked
       FROM agents WHERE community_id=$1 ORDER BY created_at`
    ),
    counts: await q(
      `SELECT (SELECT count(*) FROM attachments WHERE community_id=$1)::int AS attachments,
              (SELECT count(*) FROM connection_grants WHERE community_id=$1)::int AS grants,
              (SELECT count(*) FROM connection_pairings WHERE community_id=$1)::int AS pairings,
              (SELECT count(*) FROM agent_credentials WHERE community_id=$1)::int AS credentials,
              (SELECT count(*) FROM channel_members WHERE community_id=$1)::int AS channel_members,
              (SELECT count(*) FROM agent_channel_members WHERE community_id=$1)::int AS agent_members,
              (SELECT count(*) FROM read_cursors WHERE community_id=$1)::int AS cursors,
              (SELECT count(*) FROM export_archives WHERE community_id=$1)::int AS exports,
              (SELECT count(*) FROM entry_redactions WHERE community_id=$1)::int AS redactions,
              (SELECT count(*) FROM owner_quota_windows WHERE community_id=$1)::int AS quota,
              (SELECT count(*) FROM managed_blobs WHERE community_id=$1)::int AS blobs`
    ),
    audit: await q(
      `SELECT action,actor_kind,count(*)::int AS n FROM audit_events WHERE community_id=$1
       GROUP BY action,actor_kind ORDER BY action,actor_kind`
    ),
    requests: await q(
      `SELECT kind,state,last_error_class FROM erasure_requests WHERE community_id=$1 ORDER BY kind,state`
    ),
  });
}
