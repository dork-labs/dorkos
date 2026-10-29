/**
 * What a person's paired DorkOS app can read about their space through its `read` grant, and
 * what every member can see of who is in it (DOR-3005).
 *
 * - The settings, the person's own membership, the member directory and the rules answer a
 *   person's browser session and that person's `read` grant alike, under the same role checks.
 * - Invitations and mutes are not a `read` grant's: it is refused. Only the browser, or the separate
 *   `administer` credential (administer-grants.integration.test.ts), reads them.
 * - An agent's credential, a grant without `read`, and a grant from another space are refused.
 * - Every member sees the directory: names, handles and roles. Only an owner or admin sees when
 *   someone joined, and only in their own browser who is muted.
 * - `include=agents,availability` lists each person's agents beside them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityWireMemberDirectoryPageSchema,
  type CommunityWireMemberDirectoryPage,
} from '@dorkos/shared/community-wire';
import {
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  TENANCY_PASSWORD,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { hashSecret } from '../security.js';

let h: TenancyHarness;
let communityId = '';
let otherCommunityId = '';
const people = {} as Record<'owner' | 'admin' | 'member', TenancyMember & { grant: string }>;
/** A grant from the other space's owner, which this space never issued. */
let otherGrant = '';
/** An agent the owner enrolled, and its credential. */
let agentId = '';
let agentToken = '';
/** The owner's grant that may enroll agents but not read. */
let enrollOnlyGrant = '';

const ROLES = ['owner', 'admin', 'member'] as const;
const tenant = (id = communityId) => `/api/v1/communities/${id}`;

/** One read as a role, by its browser session or by its paired app's `read` grant. */
function read(path: string, role: (typeof ROLES)[number], via: 'cookie' | 'grant') {
  const person = people[role];
  return h.call(
    `${tenant()}${path}`,
    via === 'cookie' ? { cookie: person.cookie } : { bearer: person.grant }
  );
}

async function directory(
  role: (typeof ROLES)[number],
  via: 'cookie' | 'grant',
  query = ''
): Promise<CommunityWireMemberDirectoryPage> {
  const response = await expectStatus(await read(`/members${query}`, role, via), 200, 'directory');
  return CommunityWireMemberDirectoryPageSchema.parse(await response.json());
}

beforeAll(async () => {
  h = await startTenancyHarness('paired_app_reads');
  const host = await bootstrapHost(h, 'Owner', 'owner@reads.test');
  communityId = host.communityId;
  const owner = { cookie: host.cookie, memberId: host.memberId };
  const admin = await admit(h, communityId, owner.cookie, {
    name: 'Admin',
    email: 'admin@reads.test',
  });
  const member = await admit(h, communityId, owner.cookie, {
    name: 'Member',
    email: 'member@reads.test',
  });
  await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [admin.memberId]);
  for (const [role, who] of [
    ['owner', owner],
    ['admin', admin],
    ['member', member],
  ] as const) {
    people[role] = { ...who, grant: await pairInstall(h, communityId, who.cookie, ['read']) };
  }
  // The admin is muted, so a list that leaks mutes has one to leak.
  await h.pool.query("UPDATE members SET muted_until=now()+interval '1 hour' WHERE id=$1", [
    admin.memberId,
  ]);

  const enrolling = await pairInstall(h, communityId, owner.cookie);
  const enrolled = await expectStatus(
    await h.call(`${tenant()}/agents`, {
      bearer: enrolling,
      body: { localAgentId: randomUUID(), displayName: 'Researcher' },
    }),
    201,
    'enroll agent'
  );
  const body = (await enrolled.json()) as { token: string; agent: { memberId: string } };
  agentId = body.agent.memberId;
  agentToken = body.token;
  enrollOnlyGrant = await pairInstall(h, communityId, owner.cookie, ['enroll-agent']);

  const other = await createPendingCommunity(h, owner.cookie, 'Elsewhere');
  otherCommunityId = other.communityId;
  const otherOwner = await claimAsNewAccount(h, other.token, 'Other', 'other@reads.test');
  otherGrant = await pairInstall(h, otherCommunityId, otherOwner.cookie, ['read']);
});

afterAll(async () => {
  await h?.close();
});

describe('a role by browser session or by read grant', () => {
  // Purpose: fails if a person's grant reads less or more than their browser under the same role.
  for (const role of ROLES) {
    for (const via of ['cookie', 'grant'] as const) {
      it(`${role} by ${via} reads the settings, their membership, the directory and the rules`, async () => {
        const settings = await expectStatus(await read('/settings', role, via), 200, 'settings');
        expect(await settings.json()).toMatchObject({ communityId, name: 'Owner Community' });
        const me = await expectStatus(await read('/me', role, via), 200, 'me');
        expect((await me.json()).member).toMatchObject({
          memberId: people[role].memberId,
          role,
        });
        const page = await directory(role, via);
        expect(page.members.map((row) => row.memberId).sort()).toEqual(
          ROLES.map((r) => people[r].memberId).sort()
        );
        await expectStatus(await read('/rules', role, via), 200, 'rules');
      });
    }
  }
});

describe('what stays in the browser', () => {
  it('refuses invitations and mutes to every grant, even an owner’s', async () => {
    // Purpose: fails if the grant path is widened past the four reads security approved.
    for (const role of ROLES) {
      for (const path of ['/invites', '/mutes']) {
        const response = await read(path, role, 'grant');
        expect(response.status, `${role} ${path}`).toBe(401);
      }
    }
    await expectStatus(await read('/invites', 'owner', 'cookie'), 200, 'owner invites');
    await expectStatus(await read('/mutes', 'admin', 'cookie'), 200, 'admin mutes');
  });
});

describe('credentials that are not a person’s read grant', () => {
  it('refuses an agent’s credential with a plain sentence', async () => {
    // Purpose: fails if an agent token is read as its owner on these person-only reads.
    for (const path of ['/settings', '/me', '/members']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: agentToken });
      expect(response.status, path).toBe(403);
      expect((await response.json()).message).toBe('Only a person can do this, not an agent.');
    }
  });

  it('refuses a grant without read', async () => {
    // Purpose: fails if the scope check is dropped from the grant path.
    for (const path of ['/settings', '/me', '/members']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: enrollOnlyGrant });
      expect(response.status, path).toBe(403);
    }
  });

  it('refuses a grant from another space', async () => {
    // Purpose: fails if a grant reaches a space that never issued it.
    for (const path of ['/settings', '/me', '/members']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: otherGrant });
      expect(response.status, path).toBe(401);
    }
    const own = await h.call(`${tenant(otherCommunityId)}/members`, { bearer: otherGrant });
    const ids = CommunityWireMemberDirectoryPageSchema.parse(await own.json()).members.map(
      (row) => row.memberId
    );
    for (const role of ROLES) expect(ids).not.toContain(people[role].memberId);
  });

  it('refuses a revoked grant', async () => {
    // Purpose: fails if the grant path reads a grant row without checking revocation.
    const grant = await pairInstall(h, communityId, people.member.cookie, ['read']);
    await expectStatus(await h.call(`${tenant()}/settings`, { bearer: grant }), 200, 'live grant');
    await h.pool.query('UPDATE connection_grants SET revoked_at=now() WHERE token_hash=$1', [
      hashSecret(grant),
    ]);
    const response = await h.call(`${tenant()}/settings`, { bearer: grant });
    expect(response.status).toBe(401);
  });
});

describe('the member directory', () => {
  it('shows an ordinary member names and roles, never when anyone joined', async () => {
    // Purpose: fails if a plain member's rows carry joinedAt or any field beyond the directory's.
    for (const via of ['cookie', 'grant'] as const) {
      const page = await directory('member', via);
      for (const row of page.members) {
        expect(Object.keys(row).sort()).toEqual(
          ['displayName', 'handle', 'kind', 'memberId', 'ownerMemberId', 'role'].sort()
        );
      }
      expect(page.members.find((row) => row.memberId === people.admin.memberId)?.role).toBe(
        'admin'
      );
    }
  });

  it('keeps an owner’s and admin’s default page exactly as before', async () => {
    // Purpose: fails if the default page changes shape for apps that parse it strictly.
    for (const role of ['owner', 'admin'] as const) {
      const page = await directory(role, 'cookie');
      expect(page.agents).toBeUndefined();
      for (const row of page.members) {
        expect(Object.keys(row).sort()).toEqual(
          ['displayName', 'handle', 'joinedAt', 'kind', 'memberId', 'ownerMemberId', 'role'].sort()
        );
      }
    }
  });

  it('lists each person’s agents beside them, with availability when asked', async () => {
    // Purpose: fails if include=agents drops the agents, misses the owner link or availability.
    const page = await directory('member', 'grant', '?include=agents,availability');
    expect(page.agents).toEqual([
      {
        memberId: agentId,
        kind: 'agent',
        displayName: 'Researcher',
        handle: expect.any(String),
        role: null,
        ownerMemberId: people.owner.memberId,
        runsOn: null,
        lastSeenAt: null,
        availability: 'unknown',
      },
    ]);
    const bare = await directory('member', 'grant', '?include=agents');
    expect(bare.agents?.[0]).not.toHaveProperty('availability');
  });

  it('shows who is muted only to an owner or admin in their own browser', async () => {
    // Purpose: fails if mute data reaches a plain member or any paired app's grant.
    for (const role of ['owner', 'admin'] as const) {
      const page = await directory(role, 'cookie', '?include=agents');
      const admin = page.members.find((row) => row.memberId === people.admin.memberId);
      expect(admin?.mutedUntil, role).toEqual(expect.any(String));
      const owner = page.members.find((row) => row.memberId === people.owner.memberId);
      expect(owner?.mutedUntil, role).toBeNull();
      const viaGrant = await directory(role, 'grant', '?include=agents');
      for (const row of viaGrant.members) expect(row).not.toHaveProperty('mutedUntil');
    }
    const member = await directory('member', 'cookie', '?include=agents');
    for (const row of member.members) expect(row).not.toHaveProperty('mutedUntil');
  });
});

describe('a grant behaves like the browser beside it', () => {
  it('refuses a live grant once its member has left', async () => {
    // Purpose: fails if a grant outlives the membership it was approved from.
    const leaver = await admit(h, communityId, people.owner.cookie, {
      name: 'Leaver',
      email: 'leaver@reads.test',
    });
    const grant = await pairInstall(h, communityId, leaver.cookie, ['read']);
    await expectStatus(await h.call(`${tenant()}/members`, { bearer: grant }), 200, 'before');
    await h.pool.query('UPDATE members SET active=false WHERE id=$1', [leaver.memberId]);
    for (const path of ['/settings', '/me', '/members', '/rules']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: grant });
      expect(response.status, path).toBe(401);
    }
  });

  /** Move the space through the real host and owner routes, the way a person would. */
  async function lifecycle(action: 'hold' | 'release' | 'archive' | 'restore') {
    const version = (
      await h.pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [communityId]
      )
    ).rows[0]!.lifecycle_version;
    const host = action === 'hold' || action === 'release';
    await expectStatus(
      await h.call(
        host ? `/api/v1/host/communities/${communityId}/lifecycle` : `${tenant()}/owner/lifecycle`,
        {
          method: host ? 'PATCH' : 'POST',
          cookie: people.owner.cookie,
          body: host
            ? {
                action,
                lifecycleVersion: version,
                ...(action === 'hold' ? { deletionNoticeAt: null } : {}),
              }
            : {
                action,
                lifecycleVersion: version,
                password: TENANCY_PASSWORD,
                confirmName: 'Owner Community',
              },
        }
      ),
      200,
      action
    );
  }

  for (const [state, enter, leave] of [
    ['held', 'hold', 'release'],
    ['archived', 'archive', 'restore'],
  ] as const) {
    it(`answers /settings and /members on a ${state} space as the browser is answered`, async () => {
      // Purpose: fails if the grant path reads a read-only space the browser path refuses, or
      // refuses one it reads.
      await lifecycle(enter);
      const kept = { ...people };
      // An owner archive revokes every grant; an app reads an archived space only through a
      // read-only pairing made after it. A hold keeps them.
      if (state === 'archived')
        for (const role of ROLES)
          people[role] = {
            ...people[role],
            grant: await pairInstall(h, communityId, people[role].cookie, ['read']),
          };
      try {
        for (const role of ROLES) {
          for (const path of ['/settings', '/members']) {
            const byCookie = await read(path, role, 'cookie');
            const byGrant = await read(path, role, 'grant');
            expect(byGrant.status, `${role} ${path}`).toBe(byCookie.status);
          }
        }
        // The settings stay readable; the directory follows the role check's lifecycle rule.
        expect((await read('/settings', 'member', 'grant')).status).toBe(200);
        expect((await read('/members', 'member', 'grant')).status).toBe(423);
      } finally {
        await lifecycle(leave);
        Object.assign(people, kept);
      }
    });
  }
});
