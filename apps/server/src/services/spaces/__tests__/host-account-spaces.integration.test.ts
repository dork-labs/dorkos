/**
 * A host listing the spaces an account belongs to (DOR-2954): the `accounts:read` scope, the
 * single sign-on refusals, which memberships and which spaces count, roles and states, the sort,
 * the cap, and the log line. Every test drives the real route on a real server and database;
 * spaces and memberships are seeded straight into the database, so each state the route must
 * leave out can be built exactly, including ones the ordinary routes would never leave behind.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HOST_ACCOUNT_SPACES_MAX,
  CommunityAdminAccountSpacesResponseSchema,
  CommunityAdminHostApiKeyScopeSchema,
} from '@dorkos/shared/community-admin-wire';
import { runHostKeyCommand } from '../host-keys.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const SCOPE = 'accounts:read';
const ISSUER = 'https://issuer.spaces.test';

let h: TenancyHarness;
let bare: TenancyHarness;
let readKey = '';
/** The account every space here is owned by unless a test says otherwise. */
let landlord = '';

type Lifecycle =
  'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
type Role = 'owner' | 'admin' | 'member';

async function issueKey(target: TenancyHarness, scopes: string[]): Promise<string> {
  const issued = await runHostKeyCommand(target.pool, {
    kind: 'issue',
    label: scopes.join(' ').slice(0, 80),
    scopes: scopes as never,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return issued.secret;
}

/** A new account, and the single sign-on identity it signs in with. */
async function account(label: string): Promise<{ userId: string; subject: string }> {
  const userId = `${label}-${randomUUID()}`;
  const subject = `sub-${randomUUID()}`;
  await h.pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)`, [
    userId,
    label,
    `${userId}@x.test`,
  ]);
  await h.pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,$2,'oidc',$3)`,
    [randomUUID(), subject, userId]
  );
  return { userId, subject };
}

/** The columns each lifecycle's checks need beside `lifecycle` itself. */
const STATE_COLUMNS: Record<Lifecycle, string> = {
  pending_owner: '',
  active: '',
  archived: ',archived_at=now()',
  suspended: ",suspended_from_state='active',suspended_at=now()",
  held: ",held_from_state='active',held_at=now()",
  deletion_pending:
    ",delete_requested_at=now(),delete_after=now()+interval '7 days',delete_requested_by_host_actor='person:host'",
};

/**
 * A space in `lifecycle`, owned by the landlord unless `userId` is its owner, with `userId` as a
 * person member in `role`. Returns the space and the person's membership.
 */
async function space(
  name: string,
  userId: string,
  { lifecycle = 'active', role = 'member' }: { lifecycle?: Lifecycle; role?: Role } = {}
): Promise<{ communityId: string; memberId: string }> {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const communityId = (
      await client.query<{ id: string }>(
        `INSERT INTO communities(name,lifecycle) VALUES($1,'active') RETURNING id`,
        [name]
      )
    ).rows[0].id;
    // A space waiting for its owner has none; every other one has exactly one.
    if (role !== 'owner' && lifecycle !== 'pending_owner')
      await client.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,'Landlord','landlord','owner')`,
        [communityId, landlord]
      );
    const memberId = (
      await client.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,'Person','person',$3) RETURNING id`,
        [communityId, userId, role]
      )
    ).rows[0].id;
    await client.query(
      `UPDATE communities SET lifecycle=$2${STATE_COLUMNS[lifecycle]} WHERE id=$1`,
      [communityId, lifecycle]
    );
    await client.query('COMMIT');
    return { communityId, memberId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const list = (body: unknown, bearer = readKey, target = h) =>
  target.call('/api/v1/host/accounts/spaces', { bearer, body });

async function spacesOf(subject: string) {
  const response = await expectStatus(await list({ issuer: ISSUER, subject }), 200, 'spaces');
  return CommunityAdminAccountSpacesResponseSchema.parse(await response.json());
}

beforeAll(async () => {
  h = await startTenancyHarness('acctspaces', {
    env: {
      COMMUNITY_OIDC_ISSUER_URL: ISSUER,
      COMMUNITY_OIDC_CLIENT_ID: 'community-client',
      COMMUNITY_OIDC_CLIENT_SECRET: 'community-client-secret',
    },
  });
  bare = await startTenancyHarness('acctspaces_bare');
  await bootstrapHost(h, 'Hana Host', 'hana@host.test');
  await bootstrapHost(bare, 'Otto Host', 'otto@host.test');
  readKey = await issueKey(h, [SCOPE]);
  landlord = (await account('landlord')).userId;
}, 120_000);

afterAll(async () => {
  await h?.close();
  await bare?.close();
});

describe('who may list an account’s spaces', () => {
  // Purpose: fails if any other scope, alone or all together, reaches the route (accounts:close
  // above all), or if a key with the scope is refused.
  it('needs accounts:read, which no other scope implies', async () => {
    const { subject } = await account('scoped');
    const others = CommunityAdminHostApiKeyScopeSchema.options.filter((scope) => scope !== SCOPE);
    const keys = [
      ...(await Promise.all(others.map((scope) => issueKey(h, [scope])))),
      await issueKey(h, others),
    ];
    for (const key of keys) expect((await list({ issuer: ISSUER, subject }, key)).status).toBe(403);
    expect(
      (await h.call('/api/v1/host/accounts/spaces', { body: { issuer: ISSUER, subject } })).status
    ).toBe(401);
    expect((await list({ issuer: ISSUER, subject })).status).toBe(200);
  });

  // Purpose: fails if a server with no single sign-on, or another issuer, answers anything but
  // 409, or if a trailing slash on this host's issuer is refused.
  it('answers only for this host’s own single sign-on', async () => {
    const { subject } = await account('issuer');
    expect((await list({ issuer: 'https://other.test', subject })).status).toBe(409);
    expect((await list({ issuer: `${ISSUER}/`, subject })).status).toBe(200);
    expect((await list({ issuer: ISSUER })).status).toBe(400);
    const bareKey = await issueKey(bare, [SCOPE]);
    expect((await list({ issuer: ISSUER, subject }, bareKey, bare)).status).toBe(409);
  });
});

describe('which spaces are listed', () => {
  // Purpose: fails if an identity no account signs in with is a 404 instead of an empty list, or
  // if anything but an exact single sign-on identity finds an account.
  it('answers an empty list for an identity nobody signs in with', async () => {
    const { userId, subject } = await account('unknown');
    await space('Somewhere', userId);
    for (const miss of ['nobody', subject.toUpperCase(), `${subject} `, userId])
      expect(await spacesOf(miss), miss).toEqual({ spaces: [], truncated: false });
  });

  // Purpose: fails if the role, the state, the address or the sort is wrong, if an archived
  // space is left out, or if a space the person does not belong to (another person's) appears.
  it('lists each space with the person’s role and the space’s state, sorted by name', async () => {
    const pat = await account('pat');
    const quin = await account('quin');
    const gamma = await space('gamma', pat.userId, { role: 'member' });
    const alpha = await space('alpha', pat.userId, { role: 'owner' });
    const beta = await space('Beta', pat.userId, { role: 'admin', lifecycle: 'archived' });
    await space('Aardvark', quin.userId, { role: 'owner' });
    const url = (id: string) => `${h.config.publicUrl}/c/${id}`;
    expect(await spacesOf(pat.subject)).toEqual({
      spaces: [
        {
          communityId: alpha.communityId,
          name: 'alpha',
          url: url(alpha.communityId),
          role: 'owner',
          state: 'active',
        },
        {
          communityId: beta.communityId,
          name: 'Beta',
          url: url(beta.communityId),
          role: 'admin',
          state: 'archived',
        },
        {
          communityId: gamma.communityId,
          name: 'gamma',
          url: url(gamma.communityId),
          role: 'member',
          state: 'active',
        },
      ],
      truncated: false,
    });
    expect((await spacesOf(quin.subject)).spaces.map((s) => s.name)).toEqual(['Aardvark']);
  });

  // Purpose: fails if a space that is held, suspended, waiting to be deleted or waiting for its
  // owner is listed.
  it('leaves out every space that is not open or archived', async () => {
    const { userId, subject } = await account('states');
    const kept = await space('Kept', userId);
    for (const lifecycle of ['pending_owner', 'suspended', 'held', 'deletion_pending'] as const)
      await space(`Gone ${lifecycle}`, userId, { lifecycle });
    expect((await spacesOf(subject)).spaces.map((s) => s.communityId)).toEqual([kept.communityId]);
  });

  // Purpose: fails if a membership that ended is listed: one that is no longer active, one that
  // was removed, one under a standing ban, or one that was erased. Each is built on its own, even
  // where the ordinary routes would set more than one at once, so each filter is proven alone.
  it('leaves out memberships that ended', async () => {
    const { userId, subject } = await account('ended');
    const kept = await space('Kept', userId);
    const inactive = await space('Inactive', userId);
    await h.pool.query('UPDATE members SET active=false WHERE id=$1', [inactive.memberId]);
    const removed = await space('Removed', userId);
    await h.pool.query('UPDATE members SET removed_at=now() WHERE id=$1', [removed.memberId]);
    const banned = await space('Banned', userId);
    await h.pool.query('INSERT INTO bans(community_id,member_id,user_id) VALUES($1,$2,$3)', [
      banned.communityId,
      banned.memberId,
      userId,
    ]);
    const lifted = await space('Lifted', userId);
    await h.pool.query(
      `INSERT INTO bans(community_id,member_id,user_id,lifted_at) VALUES($1,$2,$3,now())`,
      [lifted.communityId, lifted.memberId, userId]
    );
    const erased = await space('Erased', userId);
    // members_erased_husk: an erased row has no account and is not active, so the route's own
    // erased_at filter can never be the only thing that leaves one out.
    await expect(
      h.pool.query('UPDATE members SET erased_at=now() WHERE id=$1', [erased.memberId])
    ).rejects.toThrow(/members_erased_husk/);
    await h.pool.query('UPDATE members SET erased_at=now(),user_id=NULL,active=false WHERE id=$1', [
      erased.memberId,
    ]);
    expect((await spacesOf(subject)).spaces.map((s) => s.communityId)).toEqual([
      kept.communityId,
      lifted.communityId,
    ]);
  });

  // Purpose: fails if an agent's membership counts: an agent the person owns does not list a
  // space twice, or a space where only the agent is still a member, and the database's own shape
  // check refuses an agent row that names the account, so the route can never meet one.
  it('never lists a space through an agent’s membership', async () => {
    const { userId, subject } = await account('agentowner');
    const agent = (communityId: string, ownerMemberId: string, accountId: string | null) =>
      h.pool.query(
        `INSERT INTO members(community_id,user_id,display_name,role,kind,owner_member_id)
         VALUES($1,$2,'Bot','member','agent',$3)`,
        [communityId, accountId, ownerMemberId]
      );
    const both = await space('Person and agent', userId);
    await agent(both.communityId, both.memberId, null);
    const left = await space('Agent stayed', userId);
    await agent(left.communityId, left.memberId, null);
    await h.pool.query('UPDATE members SET active=false WHERE id=$1', [left.memberId]);
    // Another person's agent in a space this account is not in, wrongly naming this account.
    const other = await space('Agent elsewhere', (await account('bystander')).userId);
    await expect(agent(other.communityId, other.memberId, userId)).rejects.toThrow(
      /members_agent_shape/
    );
    expect((await spacesOf(subject)).spaces.map((s) => s.communityId)).toEqual([both.communityId]);
  });
});

describe('the cap', () => {
  /** `count` open spaces the account owns, inserted in one statement. */
  async function owns(userId: string, count: number) {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH made AS (
           INSERT INTO communities(name,lifecycle)
           SELECT 'Space ' || lpad(n::text,4,'0'),'active' FROM generate_series(1,$2) n
           RETURNING id)
         INSERT INTO members(community_id,user_id,display_name,handle,role)
         SELECT id,$1,'Owner','owner','owner' FROM made`,
        [userId, count]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  // Purpose: fails if the list is not cut at the cap, if `truncated` is wrong on either side of
  // it, or if the cut keeps anything but the first spaces by name.
  it('lists at most 500 spaces and says when there were more', async () => {
    const exact = await account('exact');
    await owns(exact.userId, HOST_ACCOUNT_SPACES_MAX);
    const atCap = await spacesOf(exact.subject);
    expect(atCap.spaces).toHaveLength(HOST_ACCOUNT_SPACES_MAX);
    expect(atCap.truncated).toBe(false);

    const over = await account('over');
    await owns(over.userId, HOST_ACCOUNT_SPACES_MAX + 1);
    const past = await spacesOf(over.subject);
    expect(past.spaces).toHaveLength(HOST_ACCOUNT_SPACES_MAX);
    expect(past.truncated).toBe(true);
    expect(past.spaces[0].name).toBe('Space 0001');
    expect(past.spaces.at(-1)?.name).toBe('Space 0500');
  }, 60_000);
});

describe('the log line', () => {
  // Purpose: fails if the route logs the sign-in identity, or logs anything but one line of ids
  // and counts.
  it('logs one line of ids and a count, never the identity', async () => {
    const { userId, subject } = await account('logged');
    await space('Logged', userId);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await spacesOf(subject);
      await spacesOf('nobody-at-all');
      const lines = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('community.account.spaces'));
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).not.toContain(subject);
        expect(line).not.toContain('nobody-at-all');
      }
      expect(JSON.parse(lines[0])).toEqual({
        event: 'community.account.spaces',
        accountId: userId,
        actorKind: 'api_key',
        actorId: expect.any(String),
        count: 1,
        truncated: false,
      });
      expect(JSON.parse(lines[1])).toMatchObject({ accountId: null, count: 0 });
    } finally {
      log.mockRestore();
    }
  });
});
