/**
 * Where each agent runs and whether it is there (specs/server-merge D4, step 3a, DOR-2877). A
 * paired app reports for the agents its installation enrolled; the channel member list shows
 * them as available, offline since the last report, or unknown when no app ever reported. A
 * report for anyone else's agent records nothing. Reports change no count a host reads.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
  COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
  CommunityWireAgentAvailabilityReportResponseSchema,
  CommunityWireMemberListResponseSchema,
} from '@dorkos/shared/community-wire';
import { readUsage } from '../host/limits.js';
import { hashSecret } from '../security.js';
import {
  admit,
  bootstrapHost,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { AVAILABILITY_RECORD_AFTER_SECONDS } from '../routes/community/agents/availability.js';

let h: TenancyHarness;
let communityId = '';
let channelId = '';
let owner: TenancyMember;
/** The owner's laptop installation, and the agent it enrolled and placed in the channel. */
let laptop = '';
let agentId = '';

const tenant = () => `/api/v1/communities/${communityId}`;

async function enroll(grant: string, localAgentId: string) {
  const response = await expectStatus(
    await h.call(`${tenant()}/agents`, {
      bearer: grant,
      body: { localAgentId, displayName: `Agent ${localAgentId}` },
    }),
    201,
    `enroll ${localAgentId}`
  );
  const id = ((await response.json()) as { agent: { memberId: string } }).agent.memberId;
  await expectStatus(
    await h.call(`${tenant()}/channels/${channelId}/agents`, {
      bearer: grant,
      body: { agentId: id },
    }),
    200,
    `place ${localAgentId}`
  );
  return id;
}

function report(grant: string, agents: Array<{ agentId: string; runsOn: string }>) {
  return h.call(`${tenant()}/agents/availability`, { bearer: grant, body: { agents } });
}

async function reported(grant: string, agents: Array<{ agentId: string; runsOn: string }>) {
  const response = await expectStatus(await report(grant, agents), 200, 'report');
  return CommunityWireAgentAvailabilityReportResponseSchema.parse(await response.json());
}

/** The channel's member list as the owner's browser reads it, asking for availability. */
async function roster(query = '?include=availability') {
  const response = await expectStatus(
    await h.call(`${tenant()}/channels/${channelId}/members${query}`, { cookie: owner.cookie }),
    200,
    'roster'
  );
  return CommunityWireMemberListResponseSchema.parse(await response.json()).members;
}

async function rowOf(id: string) {
  const members = await roster();
  const row = members.find((member) => member.memberId === id);
  if (!row) throw new Error(`no roster row for ${id}`);
  return row;
}

async function stored(id: string) {
  const row = await h.pool.query<{ runs_on: string | null; last_seen_at: Date | null }>(
    'SELECT runs_on,last_seen_at FROM agents WHERE id=$1',
    [id]
  );
  return row.rows[0]!;
}

/** Move an agent's last report into the past, as if its app had stopped reporting since. */
async function lastReportedSecondsAgo(id: string, seconds: number): Promise<Date> {
  const row = await h.pool.query<{ last_seen_at: Date }>(
    `UPDATE agents SET last_seen_at=now() - make_interval(secs => $2) WHERE id=$1
     RETURNING last_seen_at`,
    [id, seconds]
  );
  return row.rows[0]!.last_seen_at;
}

beforeAll(async () => {
  h = await startTenancyHarness('agent_availability');
  const host = await bootstrapHost(h, 'Owner', 'owner@availability.test');
  communityId = host.communityId;
  channelId = host.channelId;
  owner = { cookie: host.cookie, memberId: host.memberId };
  laptop = await pairInstall(h, communityId, owner.cookie);
  agentId = await enroll(laptop, 'researcher');
});

afterAll(async () => {
  await h?.close();
});

describe('an agent no app has reported for', () => {
  it('reads as unknown, never offline', async () => {
    // Purpose: fails if an agent enrolled by an app from before reports (no last report) shows
    // as offline, which would mark every launch-era agent as gone.
    const fresh = await enroll(laptop, 'never-reported');
    expect(await rowOf(fresh)).toMatchObject({
      kind: 'agent',
      runsOn: null,
      lastSeenAt: null,
      availability: 'unknown',
    });
  });
});

describe('reporting', () => {
  it('records the agents its installation enrolled, and they read as available', async () => {
    // Purpose: fails if a report from the enrolling installation is not recorded or the member
    // list does not show the agent as there.
    const answer = await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    expect(answer).toEqual({
      accepted: [agentId],
      refused: [],
      reportEverySeconds: COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
    });
    const row = await stored(agentId);
    expect(row.runs_on).toBe('computer');
    expect(row.last_seen_at).not.toBeNull();
    expect(await rowOf(agentId)).toMatchObject({
      runsOn: 'computer',
      lastSeenAt: row.last_seen_at!.toISOString(),
      availability: 'available',
    });
  });

  it('writes nothing for a report soon after the last, unless the computer changed', async () => {
    // Purpose: fails if every heartbeat rewrites the row (no coalescing), or if coalescing
    // swallows a move to another kind of computer.
    await lastReportedSecondsAgo(agentId, 5);
    const before = (await stored(agentId)).last_seen_at!;
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    expect((await stored(agentId)).last_seen_at).toEqual(before);
    await reported(laptop, [{ agentId, runsOn: 'agent-computer' }]);
    const moved = await stored(agentId);
    expect(moved.runs_on).toBe('agent-computer');
    expect(moved.last_seen_at!.getTime()).toBeGreaterThan(before.getTime());
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
  });

  it('writes no agent row and no grant row for reports inside the window', async () => {
    // Purpose: fails if a report sooner than half the interval after the last recorded one
    // rewrites the agent's row, or if every call rewrites the grant's last-used time.
    const versions = async () => ({
      agent: (await h.pool.query('SELECT xmin::text FROM agents WHERE id=$1', [agentId])).rows[0],
      grant: (
        await h.pool.query('SELECT xmin::text FROM connection_grants WHERE token_hash=$1', [
          hashSecret(laptop),
        ])
      ).rows[0],
    });
    // Recorded inside the window; this report may still date the grant's last use.
    await lastReportedSecondsAgo(agentId, AVAILABILITY_RECORD_AFTER_SECONDS / 2);
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    const before = await versions();
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    expect(await versions()).toEqual(before);
    // Past the window, the next report writes again.
    await lastReportedSecondsAgo(agentId, AVAILABILITY_RECORD_AFTER_SECONDS + 5);
    const stale = await versions();
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    expect((await versions()).agent).not.toEqual(stale.agent);
  });

  it('carries availability only: a report with anything more is refused whole', async () => {
    // Purpose: fails if a report could carry names, runtime or model details into the space.
    const before = await stored(agentId);
    const response = await h.call(`${tenant()}/agents/availability`, {
      bearer: laptop,
      body: { agents: [{ agentId, runsOn: 'computer', model: 'any' }] },
    });
    expect(response.status).toBe(400);
    expect(await stored(agentId)).toEqual(before);
  });

  it('needs a connection grant that may enroll agents', async () => {
    // Purpose: fails if a read-only installation, a signed-in browser or no credential at all
    // can record availability.
    const readOnly = await pairInstall(h, communityId, owner.cookie, ['read']);
    expect((await report(readOnly, [{ agentId, runsOn: 'computer' }])).status).toBe(401);
    const signedIn = await h.call(`${tenant()}/agents/availability`, {
      cookie: owner.cookie,
      body: { agents: [{ agentId, runsOn: 'computer' }] },
    });
    expect(signedIn.status).toBe(401);
  });
});

describe('overlapping reports', () => {
  it('naming the same agents in opposite orders all succeed', async () => {
    // Purpose: fails if two reports lock the same agents in different orders and one dies in a
    // deadlock. Timing-dependent, so it can pass by luck without the id-order lock; it is here so
    // a regression that makes the deadlock likely shows up.
    const many = await pairInstall(h, communityId, owner.cookie);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await enroll(many, `crowd-${i}`));
    for (let round = 0; round < 5; round++) {
      await h.pool.query('UPDATE agents SET last_seen_at=NULL WHERE id=ANY($1::uuid[])', [ids]);
      const forward = ids.map((id) => ({ agentId: id, runsOn: 'computer' }));
      const answers = await Promise.all(
        Array.from({ length: 6 }, (_, i) => report(many, i % 2 ? [...forward].reverse() : forward))
      );
      expect(answers.map((answer) => answer.status)).toEqual(Array(6).fill(200));
    }
  });
});

describe('a report for an agent the installation did not enroll', () => {
  it("is refused for another person's agent, and records nothing", async () => {
    // Purpose: fails if one person's installation can mark someone else's agent as there.
    const other = await admit(h, communityId, owner.cookie, {
      name: 'Riley',
      email: `riley-${randomUUID().slice(0, 8)}@availability.test`,
    });
    const theirs = await pairInstall(h, communityId, other.cookie);
    const before = await stored(agentId);
    const answer = await reported(theirs, [{ agentId, runsOn: 'agent-computer' }]);
    expect(answer).toMatchObject({ accepted: [], refused: [agentId] });
    expect(await stored(agentId)).toEqual(before);
  });

  it("is refused for the same person's other live installation", async () => {
    // Purpose: fails if a desktop installation can report for the laptop's agent, which it
    // cannot run.
    const desktop = await pairInstall(h, communityId, owner.cookie);
    const before = await stored(agentId);
    const answer = await reported(desktop, [{ agentId, runsOn: 'agent-computer' }]);
    expect(answer).toMatchObject({ accepted: [], refused: [agentId] });
    expect(await stored(agentId)).toEqual(before);
  });

  it('refuses unknown and malformed ids alike, and still records the rest', async () => {
    // Purpose: fails if one stale id fails the whole report, so an app's other agents would go
    // offline, or if the answer tells an unknown id apart from someone else's agent.
    const unknown = randomUUID();
    const answer = await reported(laptop, [
      { agentId, runsOn: 'computer' },
      { agentId: unknown, runsOn: 'computer' },
      { agentId: 'not-a-uuid', runsOn: 'computer' },
    ]);
    expect(answer).toMatchObject({ accepted: [agentId], refused: [unknown, 'not-a-uuid'] });
  });

  it('is refused once the agent is removed, and a re-enrolled agent starts as unknown', async () => {
    // Purpose: fails if a removed agent keeps taking reports, or comes back with an old report
    // that would show it offline before its app has said anything.
    const leaving = await enroll(laptop, 'leaving');
    await reported(laptop, [{ agentId: leaving, runsOn: 'computer' }]);
    await expectStatus(
      await h.call(`${tenant()}/agents/${leaving}`, { method: 'DELETE', bearer: laptop }),
      204,
      'remove agent'
    );
    expect(await reported(laptop, [{ agentId: leaving, runsOn: 'computer' }])).toMatchObject({
      refused: [leaving],
    });
    const back = await enroll(laptop, 'leaving');
    expect(back).toBe(leaving);
    expect(await rowOf(back)).toMatchObject({ lastSeenAt: null, availability: 'unknown' });
  });
});

describe('an agent of the same person whose installation was disconnected', () => {
  it('is accepted from their new installation, without being taken over', async () => {
    // Purpose: fails if an orphaned agent (its enrolling grant revoked) cannot be reported by the
    // person's reconnected installation, which would show it offline after every reconnect.
    const old = await pairInstall(h, communityId, owner.cookie);
    const orphan = await enroll(old, 'orphaned');
    const oldGrant = (
      await h.pool.query<{ id: string }>('SELECT id FROM connection_grants WHERE token_hash=$1', [
        hashSecret(old),
      ])
    ).rows[0]!.id;
    await expectStatus(
      await h.call(`${tenant()}/me/grants/${oldGrant}`, { method: 'DELETE', cookie: owner.cookie }),
      204,
      'disconnect the old installation'
    );
    const fresh = await pairInstall(h, communityId, owner.cookie);
    expect(await reported(fresh, [{ agentId: orphan, runsOn: 'computer' }])).toMatchObject({
      accepted: [orphan],
    });
    const row = await h.pool.query('SELECT enrolled_by_grant_id FROM agents WHERE id=$1', [orphan]);
    expect(row.rows[0].enrolled_by_grant_id).toBe(oldGrant);
    expect((await rowOf(orphan)).availability).toBe('available');
  });
});

describe('the space’s lifecycle', () => {
  async function setLifecycle(sql: string) {
    await h.pool.query(`UPDATE communities SET ${sql} WHERE id=$1`, [communityId]);
  }
  const active =
    "lifecycle='active',held_from_state=NULL,held_at=NULL,suspended_from_state=NULL,suspended_at=NULL";

  it('still takes reports while the host holds the space', async () => {
    // Purpose: fails if a hold, which stops growth, also stops presence, so every agent in a held
    // space would show offline.
    await setLifecycle("lifecycle='held',held_from_state='active',held_at=now()");
    try {
      await lastReportedSecondsAgo(agentId, AVAILABILITY_RECORD_AFTER_SECONDS + 5);
      const before = (await stored(agentId)).last_seen_at!;
      expect(await reported(laptop, [{ agentId, runsOn: 'computer' }])).toMatchObject({
        accepted: [agentId],
      });
      expect((await stored(agentId)).last_seen_at!.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      await setLifecycle(active);
    }
  });

  it('refuses reports while the space is suspended', async () => {
    // Purpose: fails if a suspended space, which answers nothing else, still records presence.
    await setLifecycle("lifecycle='suspended',suspended_from_state='active',suspended_at=now()");
    try {
      const before = await stored(agentId);
      const response = await report(laptop, [{ agentId, runsOn: 'agent-computer' }]);
      expect(response.status).toBe(503);
      expect(await stored(agentId)).toEqual(before);
    } finally {
      await setLifecycle(active);
    }
  });
});

describe('when reports stop', () => {
  it('reads as available until the threshold, then offline since the last report', async () => {
    // Purpose: fails if the threshold is dropped (an agent never goes offline), shortened so one
    // late report shows it offline, or if "offline since" is not the last report's time.
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    await lastReportedSecondsAgo(agentId, COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS - 30);
    expect((await rowOf(agentId)).availability).toBe('available');
    const last = await lastReportedSecondsAgo(
      agentId,
      COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS + 1
    );
    expect(await rowOf(agentId)).toMatchObject({
      availability: 'offline',
      lastSeenAt: last.toISOString(),
      runsOn: 'computer',
    });
  });

  it('reads as available again with the next report', async () => {
    // Purpose: fails if an old report holds an agent offline (the coalescing window must not
    // swallow a report that ends an absence).
    await lastReportedSecondsAgo(agentId, COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS * 10);
    await reported(laptop, [{ agentId, runsOn: 'computer' }]);
    expect((await rowOf(agentId)).availability).toBe('available');
  });
});

describe('what an installed app reads', () => {
  /** The member row every app released before availability parses, strict as it shipped. */
  const ReleasedMemberSchema = z.strictObject({
    memberId: z.string().min(1),
    kind: z.enum(['human', 'agent']),
    displayName: z.string().min(1),
    handle: z.string(),
    role: z.enum(['owner', 'admin', 'member']).nullable(),
    ownerMemberId: z.string().min(1).nullable(),
    ownerDisplayName: z.string().min(1).nullable().optional(),
    joinedAt: z.iso.datetime(),
  });

  it('gets the member list exactly as before unless it asks for availability', async () => {
    // Purpose: fails if the new fields reach an app that did not ask, which an installed app's
    // strict parse would reject, failing its whole member list.
    const response = await h.call(`${tenant()}/channels/${channelId}/members`, {
      bearer: laptop,
    });
    const body = (await expectStatus(response, 200, 'plain roster').then((r) => r.json())) as {
      members: unknown[];
    };
    expect(body.members.length).toBeGreaterThan(1);
    z.strictObject({ members: z.array(ReleasedMemberSchema) }).parse(body);
  });

  it('never puts availability on a person', async () => {
    // Purpose: fails if a person's row carries agent-only fields.
    const person = (await roster()).find((member) => member.memberId === owner.memberId);
    expect(person).toBeDefined();
    expect(person).not.toHaveProperty('availability');
    expect(person).not.toHaveProperty('lastSeenAt');
  });

  it('is told the space understands the report', async () => {
    // Purpose: fails if the capability flag goes, so an app would never start reporting.
    for (const path of ['/api/v1/features', `${tenant()}/features`]) {
      const response = await expectStatus(await h.call(path), 200, path);
      expect(await response.json()).toEqual({ features: { agentAvailability: true } });
    }
  });
});

describe('what a host counts', () => {
  it('is unchanged by reports', async () => {
    // Purpose: fails if availability changes any count Cloud reads (members, agents, storage).
    const usage = async () => {
      const [row] = await readUsage(h.pool, { communityId });
      return { ...row, measuredAt: '' };
    };
    const before = await usage();
    await lastReportedSecondsAgo(agentId, COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS * 2);
    await reported(laptop, [{ agentId, runsOn: 'agent-computer' }]);
    expect(await usage()).toEqual(before);
  });
});
