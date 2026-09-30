/**
 * Each agent records the connection grant (installation) that enrolled it (DOR-2612). A request
 * made with a grant sees, recovers, rotates and removes only that grant's agents, so two
 * installations of one person that share a local agent id get one agent each and never take
 * over or remove the other's. The person in the Community's own pages, and moderators, can
 * always remove an agent, whatever became of the grant that enrolled it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoverPassword } from '../recover-password.js';
import { responseCookies } from './bootstrap-test-helper.js';
import {
  admit,
  createChannel,
  bootstrapHost,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { hashSecret } from '../security.js';

let h: TenancyHarness;
let communityId = '';
let owner: TenancyMember;

const tenant = () => `/api/v1/communities/${communityId}`;

interface Enrolled {
  token: string;
  agent: { memberId: string; handle: string; ownerMemberId: string };
}

async function enroll(grant: string, localAgentId: string, displayName = 'Researcher') {
  const response = await expectStatus(
    await h.call(`${tenant()}/agents`, { bearer: grant, body: { localAgentId, displayName } }),
    201,
    `enroll ${localAgentId}`
  );
  return (await response.json()) as Enrolled;
}

async function listed(grant: string): Promise<string[]> {
  const response = await expectStatus(
    await h.call(`${tenant()}/agents`, { bearer: grant }),
    200,
    'list agents'
  );
  return ((await response.json()).agents as Array<{ memberId: string }>).map((a) => a.memberId);
}

/** Whether an agent's own credential still reads the community. */
async function credentialWorks(agentToken: string): Promise<boolean> {
  const status = (await h.call(`${tenant()}/channels`, { bearer: agentToken })).status;
  if (status !== 200 && status !== 401) throw new Error(`unexpected status ${status}`);
  return status === 200;
}

async function isActive(agentId: string): Promise<boolean> {
  const row = await h.pool.query<{ active: boolean }>('SELECT active FROM agents WHERE id=$1', [
    agentId,
  ]);
  return row.rows[0]!.active;
}

async function grantIdOf(token: string): Promise<string> {
  const row = await h.pool.query<{ id: string }>(
    'SELECT id FROM connection_grants WHERE token_hash=$1',
    [hashSecret(token)]
  );
  return row.rows[0]!.id;
}

async function enrolledBy(agentId: string): Promise<string | null> {
  const row = await h.pool.query<{ enrolled_by_grant_id: string | null }>(
    'SELECT enrolled_by_grant_id FROM agents WHERE id=$1',
    [agentId]
  );
  return row.rows[0]!.enrolled_by_grant_id;
}

const remove = (agentId: string, auth: { bearer?: string; cookie?: string }) =>
  h.call(`${tenant()}/agents/${agentId}`, { method: 'DELETE', ...auth });

const recover = (grant: string, localAgentId: string) =>
  h.call(`${tenant()}/agents/recover`, {
    bearer: grant,
    body: { localAgentId, displayName: 'Researcher' },
  });

/** A new ordinary member with a laptop and a desktop installation. */
async function personWithTwoInstalls(label: string) {
  const email = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}@grants.test`;
  const person = await admit(h, communityId, owner.cookie, { name: label, email });
  const laptop = await pairInstall(h, communityId, person.cookie);
  const desktop = await pairInstall(h, communityId, person.cookie);
  return { person, email, laptop, desktop };
}

async function activeAgentCount(memberId: string): Promise<number> {
  const row = await h.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agents WHERE owner_member_id=$1 AND active',
    [memberId]
  );
  return row.rows[0]!.n;
}

async function channelsOf(agentId: string): Promise<string[]> {
  const rows = await h.pool.query<{ channel_id: string }>(
    'SELECT channel_id FROM agent_channel_members WHERE agent_id=$1 ORDER BY channel_id',
    [agentId]
  );
  return rows.rows.map((row) => row.channel_id);
}

beforeAll(async () => {
  h = await startTenancyHarness('grant_agents', { env: { COMMUNITY_AGENTS_PER_OWNER: 3 } });
  const host = await bootstrapHost(h, 'Owner', 'owner@grants.test');
  communityId = host.communityId;
  owner = { cookie: host.cookie, memberId: host.memberId };
});

afterAll(async () => {
  await h?.close();
});

describe('two installations of one person sharing a local agent id', () => {
  it('get one agent each, and removing the laptop’s leaves the desktop’s running', async () => {
    const { laptop, desktop } = await personWithTwoInstalls('Sam');
    const onLaptop = await enroll(laptop, 'researcher');
    const onDesktop = await enroll(desktop, 'researcher');

    expect(onDesktop.agent.memberId).not.toBe(onLaptop.agent.memberId);
    expect(onDesktop.agent.handle).not.toBe(onLaptop.agent.handle);
    expect(await enrolledBy(onLaptop.agent.memberId)).toBe(await grantIdOf(laptop));
    expect(await enrolledBy(onDesktop.agent.memberId)).toBe(await grantIdOf(desktop));
    // Each installation sees only its own.
    expect(await listed(laptop)).toEqual([onLaptop.agent.memberId]);
    expect(await listed(desktop)).toEqual([onDesktop.agent.memberId]);

    // The laptop cannot name the desktop's agent: it is not found, not merely refused.
    const foreign = await remove(onDesktop.agent.memberId, { bearer: laptop });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).code).toBe('NOT_FOUND');

    await expectStatus(await remove(onLaptop.agent.memberId, { bearer: laptop }), 204, 'remove');
    expect(await isActive(onLaptop.agent.memberId)).toBe(false);
    expect(await isActive(onDesktop.agent.memberId)).toBe(true);
    expect(await credentialWorks(onDesktop.token)).toBe(true);
    expect(await listed(desktop)).toEqual([onDesktop.agent.memberId]);
  });

  it('counts each installation’s agent toward the person’s limit', async () => {
    const { laptop, desktop } = await personWithTwoInstalls('Lee');
    await enroll(laptop, 'one');
    await enroll(desktop, 'one');
    await enroll(laptop, 'two');
    const over = await h.call(`${tenant()}/agents`, {
      bearer: desktop,
      body: { localAgentId: 'two', displayName: 'Two' },
    });
    expect(over.status).toBe(409);
    expect((await over.json()).code).toBe('AGENT_LIMIT_REACHED');
  });

  it('still refuses a second enrollment of the same local id from the same installation', async () => {
    const { laptop } = await personWithTwoInstalls('Ari');
    await enroll(laptop, 'writer');
    const again = await h.call(`${tenant()}/agents`, {
      bearer: laptop,
      body: { localAgentId: 'writer', displayName: 'Writer' },
    });
    expect(again.status).toBe(409);
  });
});

describe('recover and rotate', () => {
  it('never let another installation take an agent over', async () => {
    const { laptop, desktop } = await personWithTwoInstalls('Kim');
    const onLaptop = await enroll(laptop, 'planner');

    // The desktop's recover does not find the laptop's agent, so the laptop keeps its credential.
    expect((await recover(desktop, 'planner')).status).toBe(404);
    const rotate = await h.call(`${tenant()}/agents/${onLaptop.agent.memberId}/rotate`, {
      bearer: desktop,
      body: {},
    });
    expect(rotate.status).toBe(404);
    expect(await credentialWorks(onLaptop.token)).toBe(true);

    // The app then enrolls the desktop's own agent, and the laptop's still works.
    const onDesktop = await enroll(desktop, 'planner');
    expect(onDesktop.agent.memberId).not.toBe(onLaptop.agent.memberId);
    expect(await credentialWorks(onLaptop.token)).toBe(true);

    // Each recovers its own, and only its own credential changes.
    const recovered = await expectStatus(await recover(laptop, 'planner'), 200, 'recover own');
    const replacement = (await recovered.json()) as Enrolled;
    expect(replacement.agent.memberId).toBe(onLaptop.agent.memberId);
    expect(await credentialWorks(onLaptop.token)).toBe(false);
    expect(await credentialWorks(replacement.token)).toBe(true);
    expect(await credentialWorks(onDesktop.token)).toBe(true);
  });

  it('reuses an installation’s let-go agent on reconnect, keeping its handle', async () => {
    const { person, laptop, desktop } = await personWithTwoInstalls('Rio');
    const first = await enroll(laptop, 'scribe');
    const onDesktop = await enroll(desktop, 'scribe');
    await expectStatus(await remove(first.agent.memberId, { bearer: laptop }), 204, 'remove');
    // The laptop disconnects and connects again: a new grant.
    await expectStatus(
      await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: laptop }),
      204,
      'disconnect laptop'
    );
    const laptopAgain = await pairInstall(h, communityId, person.cookie);
    const again = await enroll(laptopAgain, 'scribe');
    expect(again.agent.memberId).toBe(first.agent.memberId);
    expect(again.agent.handle).toBe(first.agent.handle);
    expect(await enrolledBy(again.agent.memberId)).toBe(await grantIdOf(laptopAgain));
    // The desktop's agent was never a candidate.
    expect(await credentialWorks(onDesktop.token)).toBe(true);
    expect(await enrolledBy(onDesktop.agent.memberId)).toBe(await grantIdOf(desktop));
  });
});

describe('legacy agents, enrolled before the Community recorded grants', () => {
  it('stay member-scoped until one installation recovers them, which adopts them', async () => {
    const { laptop, desktop } = await personWithTwoInstalls('Val');
    const legacy = await enroll(laptop, 'legacy');
    await h.pool.query('UPDATE agents SET enrolled_by_grant_id=NULL WHERE id=$1', [
      legacy.agent.memberId,
    ]);

    // Both installations see it and could act on it, as every agent was before.
    expect(await listed(laptop)).toEqual([legacy.agent.memberId]);
    expect(await listed(desktop)).toEqual([legacy.agent.memberId]);
    const duplicate = await h.call(`${tenant()}/agents`, {
      bearer: desktop,
      body: { localAgentId: 'legacy', displayName: 'Legacy' },
    });
    expect(duplicate.status).toBe(409);

    // The desktop recovers it and so holds its only credential: it is the desktop's now.
    const recovered = (await (
      await expectStatus(await recover(desktop, 'legacy'), 200, 'recover legacy')
    ).json()) as Enrolled;
    expect(recovered.agent.memberId).toBe(legacy.agent.memberId);
    expect(await enrolledBy(legacy.agent.memberId)).toBe(await grantIdOf(desktop));
    expect(await listed(laptop)).toEqual([]);
    expect((await remove(legacy.agent.memberId, { bearer: laptop })).status).toBe(404);
    expect(await credentialWorks(recovered.token)).toBe(true);
  });

  it('can be removed by any installation of their owner, and by no one else’s', async () => {
    const { laptop, desktop } = await personWithTwoInstalls('Jo');
    const legacy = await enroll(laptop, 'old');
    await h.pool.query('UPDATE agents SET enrolled_by_grant_id=NULL WHERE id=$1', [
      legacy.agent.memberId,
    ]);
    const stranger = await personWithTwoInstalls('Stranger');
    expect((await remove(legacy.agent.memberId, { bearer: stranger.laptop })).status).toBe(404);
    await expectStatus(
      await remove(legacy.agent.memberId, { bearer: desktop }),
      204,
      'remove legacy from the other install'
    );
    expect(await isActive(legacy.agent.memberId)).toBe(false);
  });
});

describe('an agent is never left unremovable', () => {
  it('the person removes it in the Community’s own pages, whichever install enrolled it', async () => {
    const { person, laptop } = await personWithTwoInstalls('Pat');
    const agent = await enroll(laptop, 'browser-removed');
    await expectStatus(
      await remove(agent.agent.memberId, { cookie: person.cookie }),
      204,
      'remove in the browser'
    );
    expect(await isActive(agent.agent.memberId)).toBe(false);
  });

  it('after its grant is revoked, the person still removes it in the Community', async () => {
    const { person, laptop } = await personWithTwoInstalls('Max');
    const agent = await enroll(laptop, 'orphan');
    await expectStatus(
      await h.call(`${tenant()}/me/grants/${await grantIdOf(laptop)}`, {
        method: 'DELETE',
        cookie: person.cookie,
      }),
      204,
      'revoke the laptop in the browser'
    );
    // The agent keeps running on its own credential, and the person removes it.
    expect(await credentialWorks(agent.token)).toBe(true);
    await expectStatus(
      await remove(agent.agent.memberId, { cookie: person.cookie }),
      204,
      'remove after revocation'
    );
    expect(await credentialWorks(agent.token)).toBe(false);
  });

  it('after the owner hands the community on, the old owner and the new owner can remove it', async () => {
    const successor = await admit(h, communityId, owner.cookie, {
      name: 'Successor',
      email: 'successor@grants.test',
    });
    const ownerLaptop = await pairInstall(h, communityId, owner.cookie);
    const ownerDesktop = await pairInstall(h, communityId, owner.cookie);
    const kept = await enroll(ownerLaptop, 'owner-agent-1');
    const moderated = await enroll(ownerLaptop, 'owner-agent-2');
    const version = await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    );
    await expectStatus(
      await h.call(`${tenant()}/owner/transfer`, {
        cookie: owner.cookie,
        body: {
          successorMemberId: successor.memberId,
          password: TENANCY_PASSWORD,
          lifecycleVersion: version.rows[0]!.lifecycle_version,
        },
      }),
      200,
      'transfer ownership'
    );

    // The former owner's other installation still cannot remove the laptop's agent.
    expect((await remove(kept.agent.memberId, { bearer: ownerDesktop })).status).toBe(404);
    // The former owner, now an ordinary member, removes it in the browser…
    await expectStatus(
      await remove(kept.agent.memberId, { cookie: owner.cookie }),
      204,
      'former owner removes'
    );
    // …and the new owner can remove the other one as a moderator.
    await expectStatus(
      await remove(moderated.agent.memberId, { cookie: successor.cookie }),
      204,
      'new owner removes'
    );
    expect(await isActive(kept.agent.memberId)).toBe(false);
    expect(await isActive(moderated.agent.memberId)).toBe(false);
    // Later tests invite through whoever owns the community now.
    owner = successor;
  });
});

// Purpose: revoking a grant leaves its agents running, so an installation that pairs again under
// a new grant must get its agent back (same id, handle and channels), not a second one that
// eats the person's agent limit while the first keeps its channels and answers no one.
describe('an installation that reconnects under a new grant', () => {
  const revokePaths: Array<{
    name: string;
    /** Whether the desktop's grant survives, so its agent stays out of the laptop's scope. */
    desktopLive: boolean;
    revoke: (p: { cookie: string; email: string; laptop: string }) => Promise<string>;
  }> = [
    {
      name: 'the person revokes that one installation in the browser',
      desktopLive: true,
      revoke: async ({ cookie, laptop }) => {
        await expectStatus(
          await h.call(`${tenant()}/me/grants/${await grantIdOf(laptop)}`, {
            method: 'DELETE',
            cookie,
          }),
          204,
          'revoke one'
        );
        return cookie;
      },
    },
    {
      name: 'the person disconnects every installation',
      desktopLive: false,
      revoke: async ({ cookie }) => {
        await expectStatus(
          await h.call(`${tenant()}/me/grants`, {
            method: 'DELETE',
            cookie,
            body: { password: TENANCY_PASSWORD },
          }),
          204,
          'disconnect all'
        );
        return cookie;
      },
    },
    {
      name: 'the host resets the person’s password',
      desktopLive: false,
      revoke: async ({ email }) => {
        await recoverPassword(h.pool, email, 'a-new-password-789');
        const signIn = await expectStatus(
          await h.call('/api/auth/sign-in/email', {
            body: { email, password: 'a-new-password-789' },
          }),
          200,
          'sign in again'
        );
        return responseCookies(signIn);
      },
    },
  ];

  for (const path of revokePaths) {
    it(`gets the same agent, handle and channels back after ${path.name}`, async () => {
      const { person, email, laptop, desktop } = await personWithTwoInstalls('Nia');
      const channel = await createChannel(
        h,
        communityId,
        owner.cookie,
        `room-${randomUUID().slice(0, 6)}`,
        [person.cookie]
      );
      const first = await enroll(laptop, 'researcher');
      await expectStatus(
        await h.call(`${tenant()}/channels/${channel}/agents`, {
          bearer: laptop,
          body: { agentId: first.agent.memberId },
        }),
        200,
        'join the channel'
      );
      const onDesktop = await enroll(desktop, 'researcher');
      const before = await activeAgentCount(person.memberId);

      const cookie = await path.revoke({ cookie: person.cookie, email, laptop });
      expect(await isActive(first.agent.memberId)).toBe(true);
      const laptopAgain = await pairInstall(h, communityId, cookie);

      const recovered = (await (
        await expectStatus(await recover(laptopAgain, 'researcher'), 200, 'recover after reconnect')
      ).json()) as Enrolled;
      expect(recovered.agent.memberId).toBe(first.agent.memberId);
      expect(recovered.agent.handle).toBe(first.agent.handle);
      expect(await channelsOf(first.agent.memberId)).toEqual([channel]);
      expect(await enrolledBy(first.agent.memberId)).toBe(await grantIdOf(laptopAgain));
      expect(await credentialWorks(recovered.token)).toBe(true);
      // No second agent: enrolling again is refused, and the limit is where it was.
      const again = await h.call(`${tenant()}/agents`, {
        bearer: laptopAgain,
        body: { localAgentId: 'researcher', displayName: 'Researcher' },
      });
      expect(again.status).toBe(409);
      expect(await activeAgentCount(person.memberId)).toBe(before);
      expect(await listed(laptopAgain)).toContain(first.agent.memberId);
      // The laptop took back its own agent, not the desktop's, which stays the desktop's. While
      // the desktop's grant is live its agent is out of the laptop's scope altogether; once every
      // grant was revoked it is orphaned too, and whichever installation recovers it first
      // takes it.
      expect(await enrolledBy(onDesktop.agent.memberId)).toBe(await grantIdOf(desktop));
      if (path.desktopLive) {
        expect(await listed(laptopAgain)).not.toContain(onDesktop.agent.memberId);
        expect(await credentialWorks(onDesktop.token)).toBe(true);
      }
    });
  }

  it('still refuses an agent whose enrolling grant is live', async () => {
    const { person, laptop, desktop } = await personWithTwoInstalls('Oak');
    const onDesktop = await enroll(desktop, 'critic');
    const laptopAgain = await pairInstall(h, communityId, person.cookie);
    for (const grant of [laptop, laptopAgain]) {
      expect((await recover(grant, 'critic')).status).toBe(404);
      expect((await remove(onDesktop.agent.memberId, { bearer: grant })).status).toBe(404);
      expect(
        (
          await h.call(`${tenant()}/agents/${onDesktop.agent.memberId}/rotate`, {
            bearer: grant,
            body: {},
          })
        ).status
      ).toBe(404);
    }
    expect(await credentialWorks(onDesktop.token)).toBe(true);
  });

  it('adds or removes only agents in its scope from a channel', async () => {
    const { person, laptop, desktop } = await personWithTwoInstalls('Ivy');
    const channel = await createChannel(
      h,
      communityId,
      owner.cookie,
      `room-${randomUUID().slice(0, 6)}`,
      [person.cookie]
    );
    const onDesktop = await enroll(desktop, 'editor');
    const add = await h.call(`${tenant()}/channels/${channel}/agents`, {
      bearer: laptop,
      body: { agentId: onDesktop.agent.memberId },
    });
    expect(add.status).toBe(404);
    await expectStatus(
      await h.call(`${tenant()}/channels/${channel}/agents`, {
        bearer: desktop,
        body: { agentId: onDesktop.agent.memberId },
      }),
      200,
      'desktop adds its own'
    );
    const take = await h.call(
      `${tenant()}/channels/${channel}/agents/${onDesktop.agent.memberId}`,
      {
        method: 'DELETE',
        bearer: laptop,
      }
    );
    expect(take.status).toBe(404);
    expect(await channelsOf(onDesktop.agent.memberId)).toEqual([channel]);
    // The person, in the browser, still can.
    await expectStatus(
      await h.call(`${tenant()}/channels/${channel}/agents/${onDesktop.agent.memberId}`, {
        method: 'DELETE',
        cookie: person.cookie,
      }),
      204,
      'person removes from the channel'
    );
  });
});
