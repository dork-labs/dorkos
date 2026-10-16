/**
 * Agents as members (specs/server-merge/03-agents-as-members.md; DOR-2876).
 *
 * Every agent has its own `members` row with the agent's id, written by migration 0042's trigger
 * when the agent is enrolled, and every message an agent writes names that row as its
 * `author_member_id`. This file runs on a real server with those rows in place and pins that
 * nothing a person sees changes: no list of people shows an agent, an agent's id answers every
 * member route as it did before, no count a host reads includes agents, a message an agent wrote
 * still counts as its owner's, and the version 2 export still names one author per message. It
 * also pins how the rows follow their agents: enrolment, removal, a person leaving or being
 * erased, a version 2 import, and takedown evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityWireMemberListResponseSchema } from '@dorkos/shared/community-wire';
import { inspectBackout } from '../backout.js';
import { checkNewPosts } from '../decisions/worker.js';
import { readUsage } from '../host/limits.js';
import { ERASED_AGENT_NAME, eraseMembership } from '../erasure/erasure.js';
import { uuidv5 } from '../imports/derived-id.js';
import { sweepImports } from '../imports/worker.js';
import { banEmailKey } from '../moderation/bans.js';
import { readEvidenceAuthor } from '../takedown/evidence/record.js';
import { EXPORT_SETTINGS, drainExports, openArchive } from './export-test-helpers.js';
import { createImport, issueKey, uploadArchive } from './import-fixture.js';
import { drainCleanup } from './member-erasure-fixture.js';
import { body, post } from './member-erasure-fixture.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let communityId = '';
let channelId = '';
let base = '';
let owner: TenancyMember;
let ada: TenancyMember;
let abe: TenancyMember;
let mo: TenancyMember;
/** One agent each for the owner, the admin Abe and the member Mo. */
let ownerAgent: Agent;
let abeAgent: Agent;
let moAgent: Agent;
let keyCounter = 0;

interface Agent {
  id: string;
  token: string;
  /** The installation that enrolled it. */
  grant: string;
}

async function join(cookie: string) {
  await expectStatus(
    await h.call(`${base}/channels/${channelId}/join`, { cookie, body: {} }),
    200,
    'join'
  );
}

async function person(name: string): Promise<TenancyMember> {
  const slug = name.toLowerCase().replaceAll(' ', '-');
  const member = await admit(h, communityId, owner.cookie, { name, email: `${slug}@agents.test` });
  await join(member.cookie);
  return member;
}

async function makeAdmin(member: TenancyMember) {
  await expectStatus(
    await h.call(`${base}/members/${member.memberId}/role`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { role: 'admin' },
    }),
    200,
    'make admin'
  );
}

/** Pair an install for `who`, enroll an agent through it, and put the agent in the channel. */
async function enroll(who: TenancyMember, label: string, displayName = `Bot ${label}`) {
  const grant = await pairInstall(
    h,
    communityId,
    who.cookie,
    ['read', 'post', 'enroll-agent'],
    label
  );
  const enrolled = await body<{ token: string; agent: { memberId: string } }>(
    await h.call(`${base}/agents`, {
      bearer: grant,
      body: { localAgentId: `local-${label}`, displayName },
    }),
    201,
    `enroll ${label}`
  );
  await expectStatus(
    await h.call(`${base}/channels/${channelId}/agents`, {
      bearer: grant,
      body: { agentId: enrolled.agent.memberId },
    }),
    200,
    `place ${label}`
  );
  return { id: enrolled.agent.memberId, token: enrolled.token, grant };
}

async function say(auth: { cookie?: string; bearer?: string }, text = `hello ${++keyCounter}`) {
  return (
    await post(h, communityId, channelId, auth, { text, idempotencyKey: `k-${++keyCounter}` })
  ).id;
}

async function personCount(): Promise<number> {
  const result = await h.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM members WHERE community_id=$1 AND kind='person' AND active",
    [communityId]
  );
  return result.rows[0].n;
}

beforeAll(async () => {
  h = await startTenancyHarness('agentmembers');
  const host = await bootstrapHost(h, 'Olga Owner', 'olga@agents.test');
  owner = { cookie: host.cookie, memberId: host.memberId };
  communityId = host.communityId;
  channelId = host.channelId;
  base = `/api/v1/communities/${communityId}`;
  ada = await person('Ada Admin');
  abe = await person('Abe Admin');
  mo = await person('Mo Member');
  await makeAdmin(ada);
  await makeAdmin(abe);
  ownerAgent = await enroll(owner, 'olga');
  abeAgent = await enroll(abe, 'abe');
  moAgent = await enroll(mo, 'mo');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const agentIds = () => [ownerAgent.id, abeAgent.id, moAgent.id];

describe('agents as members: what people see does not change', { timeout: 120_000 }, () => {
  // Purpose: the member directory, the mute list and the channel roster list people only. The
  // directory hard-codes kind 'human', so without its filter an agent shows up as a person.
  it('lists no agent in any list of people', async () => {
    const directory = await body<{ members: Array<{ memberId: string; kind: string }> }>(
      await h.call(`${base}/members?limit=100`, { cookie: owner.cookie }),
      200,
      'directory'
    );
    expect(directory.members.map((row) => row.memberId).sort()).toEqual(
      [owner.memberId, ada.memberId, abe.memberId, mo.memberId].sort()
    );

    // A person-shaped channel membership an agent should never have: the roster still lists
    // the agent once, as an agent, and never as a person.
    await h.pool.query(
      'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3)',
      [communityId, channelId, moAgent.id]
    );
    try {
      const roster = CommunityWireMemberListResponseSchema.parse(
        await body(
          await h.call(`${base}/channels/${channelId}/members`, { cookie: owner.cookie }),
          200,
          'roster'
        )
      ).members;
      expect(roster.filter((row) => row.memberId === moAgent.id)).toEqual([
        expect.objectContaining({ kind: 'agent', role: null, ownerMemberId: mo.memberId }),
      ]);
      expect(roster.filter((row) => row.kind === 'human').map((row) => row.memberId)).not.toEqual(
        expect.arrayContaining([moAgent.id])
      );
    } finally {
      await h.pool.query('DELETE FROM channel_members WHERE member_id=$1', [moAgent.id]);
    }

    const mutes = await body<{ mutes: unknown[] }>(
      await h.call(`${base}/mutes`, { cookie: owner.cookie }),
      200,
      'mutes'
    );
    expect(mutes.mutes).toEqual([]);
  });

  // Purpose: every route that takes a member id from the request answers an agent's id with
  // 404, as it does while agents have no member row. Without the kind filter an agent could be
  // made owner or admin, banned, muted, removed, or put in a channel as a person.
  it("answers an agent's id with 404 on every member route", async () => {
    const lifecycle = await h.pool.query<{ v: number }>(
      'SELECT lifecycle_version AS v FROM communities WHERE id=$1',
      [communityId]
    );
    const issued = await body<{ secret: string }>(
      await h.call('/api/v1/host/api-keys', {
        cookie: owner.cookie,
        body: {
          label: 'agent-members',
          scopes: ['communities:write'],
          expiresInDays: null,
          password: TENANCY_PASSWORD,
        },
      }),
      201,
      'host key'
    );
    const agent = moAgent.id;
    const calls: Array<[string, string, string, Parameters<TenancyHarness['call']>[1]]> = [
      ['remove', 'DELETE', `${base}/members/${agent}`, {}],
      ['role', 'PATCH', `${base}/members/${agent}/role`, { body: { role: 'admin' } }],
      ['mute', 'POST', `${base}/members/${agent}/mute`, { body: { minutes: 5 } }],
      ['unmute', 'DELETE', `${base}/members/${agent}/mute`, {}],
      ['ban', 'POST', `${base}/members/${agent}/ban`, { body: {} }],
      [
        'channel add',
        'POST',
        `${base}/channels/${channelId}/members`,
        { body: { memberId: agent } },
      ],
      ['channel remove', 'DELETE', `${base}/channels/${channelId}/members/${agent}`, {}],
      [
        'transfer',
        'POST',
        `${base}/owner/transfer`,
        {
          body: {
            successorMemberId: agent,
            password: TENANCY_PASSWORD,
            lifecycleVersion: lifecycle.rows[0].v,
          },
        },
      ],
    ];
    for (const [step, method, path, init] of calls) {
      const response = await h.call(path, { method, cookie: owner.cookie, ...init });
      expect([step, response.status]).toEqual([step, 404]);
    }
    const limits = await h.call(`/api/v1/host/communities/${communityId}/members/${agent}/limits`, {
      method: 'PUT',
      bearer: issued.secret,
      body: { agentsPerMember: 3 },
    });
    expect(['host member limits', limits.status]).toEqual(['host member limits', 404]);

    const rows = await h.pool.query(`SELECT role,active,muted_until FROM members WHERE id=$1`, [
      agent,
    ]);
    expect(rows.rows).toEqual([{ role: 'member', active: true, muted_until: null }]);
    expect((await h.pool.query('SELECT 1 FROM bans WHERE member_id=$1', [agent])).rowCount).toBe(0);
    expect(
      (await h.pool.query('SELECT 1 FROM channel_members WHERE member_id=$1', [agent])).rowCount
    ).toBe(0);
  });

  // Purpose: an agent's name is checked against people and reserved names, as today, never
  // against another agent's member row.
  it("checks a new agent's name against people only", async () => {
    await enroll(mo, 'mo-twin', `Bot mo`);
  });

  // Purpose: the recovery check reads accounts with two memberships. Agent rows have no
  // account, and grouping them by a missing account must not read as one account in two places.
  it('does not read agent rows as an account with two memberships', async () => {
    expect((await inspectBackout(h.pool)).reason).not.toBe('multiple-memberships');
  });
});

describe(
  'agents as members: an agent message still counts as its owner’s',
  { timeout: 120_000 },
  () => {
    // Purpose: once an agent's message has the agent's own member id as its author, removal still
    // ranks it by the agent's owner: Mo removes his own agent's message as its author, and an
    // admin still cannot remove a message by another admin's agent.
    it('ranks a removal by the agent’s owner', async () => {
      const mine = await say({ bearer: moAgent.token });
      const abes = await say({ bearer: abeAgent.token });
      expect(
        (await h.pool.query('SELECT author_member_id FROM entries WHERE id=$1', [mine])).rows[0]
      ).toEqual({ author_member_id: moAgent.id });

      const removed = await h.call(`${base}/entries/${mine}`, {
        method: 'DELETE',
        cookie: mo.cookie,
      });
      expect(removed.status).toBe(200);
      const refused = await h.call(`${base}/entries/${abes}`, {
        method: 'DELETE',
        cookie: ada.cookie,
      });
      expect(refused.status).toBe(403);
    });

    // Purpose: a report's actions reach the agent's owner: a mute mutes the owner (never the
    // agent's row), and an admin cannot remove the owner's agent's message through a report.
    it('resolves a report against the agent’s owner', async () => {
      const reportOn = async (entryId: string) => {
        await expectStatus(
          await h.call(`${base}/entries/${entryId}/reports`, {
            cookie: abe.cookie,
            body: { reason: 'spam' },
          }),
          201,
          'report'
        );
        return (
          await h.pool.query<{ id: string }>('SELECT id FROM reports WHERE entry_id=$1', [entryId])
        ).rows[0].id;
      };
      const ownerMessage = await say({ bearer: ownerAgent.token });
      const moMessage = await say({ bearer: moAgent.token });

      const ownersReport = await reportOn(ownerMessage);
      const refused = await h.call(`${base}/reports/${ownersReport}/resolve`, {
        cookie: ada.cookie,
        body: { action: 'remove' },
      });
      expect(refused.status).toBe(403);

      const mosReport = await reportOn(moMessage);
      await expectStatus(
        await h.call(`${base}/reports/${mosReport}/resolve`, {
          cookie: ada.cookie,
          body: { action: 'mute', minutes: 5 },
        }),
        200,
        'mute through a report'
      );
      const muted = await h.pool.query<{ id: string; muted: boolean }>(
        'SELECT id,muted_until IS NOT NULL AS muted FROM members WHERE id=ANY($1) ORDER BY id',
        [[mo.memberId, moAgent.id]]
      );
      expect(Object.fromEntries(muted.rows.map((row) => [row.id, row.muted]))).toEqual({
        [mo.memberId]: true,
        [moAgent.id]: false,
      });
      await h.call(`${base}/members/${mo.memberId}/mute`, {
        method: 'DELETE',
        cookie: owner.cookie,
      });
    });

    // Purpose: the post checks keep at most five open reports per person, and an agent's
    // messages count toward its owner's five. Two orders, because two places name the owner: the
    // sweep that files a report, and the count that caps it.
    it('counts an agent message toward its owner’s five open check reports', async () => {
      const sweep = () =>
        checkNewPosts({
          pool: h.pool,
          authSecret: h.config.authSecret,
          models: [],
          dailyCallCap: 1000,
          batch: 500,
        });
      const checkReports = async (ids: string[]) =>
        (
          await h.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM reports WHERE source='check' AND entry_id=ANY($1::uuid[])",
            [ids]
          )
        ).rows[0].n;
      /** Seven copies of one text: the third and later trip the repeat rule, five flags. */
      const sevenCopies = async (auth: { cookie?: string; bearer?: string }, text: string) => {
        const ids: string[] = [];
        for (let i = 0; i < 7; i++) ids.push(await say(auth, text));
        return ids;
      };
      await sweep();

      // The person first, then their agent: the sweep must name the owner, not the agent.
      const pia = await person('Pia Person');
      const piaAgent = await enroll(pia, 'pia');
      const personal = await sevenCopies({ cookie: pia.cookie }, 'Pia says buy the thing now');
      await sweep();
      expect(await checkReports(personal)).toBe(5);
      const fromAgent = await sevenCopies(
        { bearer: piaAgent.token },
        'Pia bot says buy the thing now'
      );
      await sweep();
      expect(await checkReports(fromAgent)).toBe(0);

      // The agent first, then its owner: the cap must count the agent's reports as the owner's.
      const quinn = await person('Quinn Person');
      const quinnAgent = await enroll(quinn, 'quinn');
      const agentFirst = await sevenCopies(
        { bearer: quinnAgent.token },
        'Quinn bot says buy the thing now'
      );
      await sweep();
      expect(await checkReports(agentFirst)).toBe(5);
      const personAfter = await sevenCopies(
        { cookie: quinn.cookie },
        'Quinn says buy the thing now'
      );
      await sweep();
      expect(await checkReports(personAfter)).toBe(0);
    });

    // Purpose: a version 2 export (a job queued before format 3 existed finishes in it) names
    // exactly one author per message, the agent, and lists only people as members, so every
    // version 2 importer still reads it.
    it('exports version 2 with one author per message and only people as members', async () => {
      const entryId = await say({ bearer: moAgent.token });
      await drainExports(h.pool, h.blobStore);
      const created = await body<{ export: { id: string } }>(
        await h.call(`${base}/owner/export`, {
          cookie: owner.cookie,
          body: { password: TENANCY_PASSWORD },
        }),
        202,
        'owner export'
      );
      await h.pool.query('UPDATE export_archives SET format_version=2 WHERE id=$1', [
        created.export.id,
      ]);
      await drainExports(h.pool, h.blobStore, { settings: EXPORT_SETTINGS });
      const response = await h.call(`${base}/exports/${created.export.id}/archive`, {
        cookie: owner.cookie,
      });
      expect(response.status).toBe(200);
      const archive = await openArchive(Buffer.from(await response.arrayBuffer()));
      expect(archive.manifest.version).toBe(2);
      const members = archive.rows<{ id: string }>('members').map((row) => row.id);
      for (const id of agentIds()) expect(members).not.toContain(id);
      expect(members).toContain(mo.memberId);
      expect(
        archive
          .rows<{ id: string; author_member_id: string | null; author_agent_id: string | null }>(
            'entries'
          )
          .find((row) => row.id === entryId)
      ).toMatchObject({ author_member_id: null, author_agent_id: moAgent.id });
    });
  }
);

describe('agents as members: no count a host reads includes agents', { timeout: 120_000 }, () => {
  // Purpose: host usage and the member cap count people only. Without the filter, the agent rows
  // fill the cap and the last person is refused.
  it('counts people only, for usage and for the cap', async () => {
    const people = await personCount();
    const [usage] = await readUsage(h.pool, { communityId });
    expect(usage.activeMembers).toBe(people);
    expect(usage.activeAgents).toBeGreaterThan(0);

    await h.pool.query(
      `INSERT INTO community_limits(community_id,max_active_members) VALUES($1,$2)
       ON CONFLICT(community_id) DO UPDATE SET max_active_members=EXCLUDED.max_active_members`,
      [communityId, people + 1]
    );
    await person('Last Seat');
    await expect(person('One Too Many')).rejects.toThrow(/got 409 .*MEMBER_LIMIT_REACHED/);
    await h.pool.query('DELETE FROM community_limits WHERE community_id=$1', [communityId]);
  });
});

/** The agent's member row, as the trigger keeps it. */
async function memberRowOf(agentId: string) {
  const result = await h.pool.query(
    `SELECT kind,owner_member_id,user_id,handle,role,display_name,active,
       removed_at IS NOT NULL AS removed,erased_at IS NOT NULL AS erased
     FROM members WHERE id=$1`,
    [agentId]
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

describe('agents as members: the member row follows its agent', { timeout: 120_000 }, () => {
  // Purpose: enrolment writes the agent's member row (0042's trigger), with the agent's id, its
  // owner's membership, no account and no handle; every message it writes names that row.
  it('gives an enrolled agent its own member row, and its messages that author', async () => {
    expect(await memberRowOf(moAgent.id)).toEqual({
      kind: 'agent',
      owner_member_id: mo.memberId,
      user_id: null,
      handle: null,
      role: 'member',
      display_name: 'Bot mo',
      active: true,
      removed: false,
      erased: false,
    });
    const entryId = await say({ bearer: moAgent.token });
    expect(
      (
        await h.pool.query('SELECT author_member_id,author_agent_id FROM entries WHERE id=$1', [
          entryId,
        ])
      ).rows
    ).toEqual([{ author_member_id: moAgent.id, author_agent_id: moAgent.id }]);
  });

  // Purpose: removing an agent, enrolling it again under a new name, and an availability report
  // each reach the member row as they should: the first two copy over, the report writes nothing.
  it('follows removal and return, and ignores availability reports', async () => {
    const rex = await person('Rex Person');
    const agent = await enroll(rex, 'rex');
    await expectStatus(
      await h.call(`${base}/agents/${agent.id}`, { method: 'DELETE', cookie: rex.cookie }),
      204,
      'remove agent'
    );
    expect(await memberRowOf(agent.id)).toMatchObject({ active: false, removed: true });
    const back = await body<{ agent: { memberId: string } }>(
      await h.call(`${base}/agents`, {
        bearer: agent.grant,
        body: { localAgentId: 'local-rex', displayName: 'Rex again' },
      }),
      201,
      're-enroll'
    );
    expect(back.agent.memberId).toBe(agent.id);
    expect(await memberRowOf(agent.id)).toMatchObject({
      active: true,
      removed: false,
      display_name: 'Rex again',
    });
    const version = async () =>
      (await h.pool.query('SELECT xmin::text AS v FROM members WHERE id=$1', [agent.id])).rows[0].v;
    const before = await version();
    await expectStatus(
      await h.call(`${base}/agents/availability`, {
        bearer: agent.grant,
        body: { agents: [{ agentId: agent.id, runsOn: 'computer' }] },
      }),
      200,
      'report'
    );
    expect(await version()).toBe(before);
  });

  // Purpose: a person leaving the space, or being removed, takes their agents' member rows with
  // their agents, as removing their agents always has.
  it("ends a removed person's agent rows with their agents", async () => {
    const sid = await person('Sid Person');
    const agent = await enroll(sid, 'sid');
    await expectStatus(
      await h.call(`${base}/members/${sid.memberId}`, { method: 'DELETE', cookie: owner.cookie }),
      204,
      'remove person'
    );
    expect(await memberRowOf(agent.id)).toMatchObject({ active: false, removed: true });
  });

  // Purpose: erasing a person erases their agents' member rows too: the name goes, the row is
  // marked erased, and nothing of it stays active.
  it("erases a person's agent rows with them", async () => {
    const eve = await person('Eve Person');
    const agent = await enroll(eve, 'eve');
    await say({ bearer: agent.token });
    expect(await eraseMembership(h.pool, communityId, eve.memberId, { log: () => undefined })).toBe(
      'erased'
    );
    expect(await memberRowOf(agent.id)).toMatchObject({
      display_name: ERASED_AGENT_NAME,
      active: false,
      removed: true,
      erased: true,
    });
  });

  // Purpose: takedown evidence names the person an agent's message counts as, with the agent
  // beside them; an agent's own member row is never read as a person, even alone.
  it('records takedown evidence for an agent message against its owner', async () => {
    const client = await h.pool.connect();
    try {
      const both = await readEvidenceAuthor(client, communityId, {
        memberId: moAgent.id,
        agentId: moAgent.id,
      });
      expect(both.subjectMemberId).toBe(mo.memberId);
      expect(both.author).toMatchObject({
        memberId: mo.memberId,
        kind: 'agent',
        agent: expect.objectContaining({ id: moAgent.id }),
      });
      const alone = await readEvidenceAuthor(client, communityId, {
        memberId: moAgent.id,
        agentId: null,
      });
      expect(alone.author).toBeNull();
    } finally {
      client.release();
    }
  });

  // Purpose: a version 2 import of a space with agents writes each agent's member row through
  // the trigger, and still binds a mention of an agent to the agent: with both rows under one id,
  // the resolver must read only people from members, or the mention names both and the import
  // fails.
  it('imports a version 2 export whose message mentions an agent', async () => {
    const handle = (
      await h.pool.query<{ handle: string }>('SELECT handle FROM agents WHERE id=$1', [moAgent.id])
    ).rows[0].handle;
    const mentioning = await say({ cookie: owner.cookie }, `over to you @${handle}`);
    expect(
      (
        await h.pool.query('SELECT mentioned_agent_id FROM entry_mentions WHERE entry_id=$1', [
          mentioning,
        ])
      ).rows
    ).toEqual([{ mentioned_agent_id: moAgent.id }]);
    await drainExports(h.pool, h.blobStore);
    await h.pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE state='ready'"
    );
    const created = await body<{ export: { id: string } }>(
      await h.call(`${base}/owner/export`, {
        cookie: owner.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      202,
      'owner export'
    );
    await drainExports(h.pool, h.blobStore, { settings: EXPORT_SETTINGS });
    const archive = Buffer.from(
      await (
        await h.call(`${base}/exports/${created.export.id}/archive`, { cookie: owner.cookie })
      ).arrayBuffer()
    );

    const key = await issueKey(h, ['communities:import']);
    const imported = await createImport(h, { bearer: key }, { name: 'Moved', autoCommit: true });
    await expectStatus(
      await uploadArchive(h, imported.importId, archive, { bearer: imported.uploadToken }),
      200,
      'upload'
    );
    const limits = {
      ...h.config.limits,
      banEmailKey: (email: string) => banEmailKey(email, h.config.authSecret),
    };
    // Until the import settles: a sweep can find it briefly leased on a busy machine.
    const stateOf = () =>
      h.pool.query<{ state: string }>('SELECT state FROM community_imports WHERE id=$1', [
        imported.importId,
      ]);
    for (let round = 0; round < 200; round++) {
      if (['ready', 'failed'].includes((await stateOf()).rows[0].state)) break;
      await h.pool.query(
        'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
      );
      await drainCleanup(h);
      await sweepImports(h.pool, h.blobStore, limits, new Date());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = await stateOf();
    expect(state.rows[0].state).toBe('ready');
    const derive = (id: string) => uuidv5(imported.importId, id);
    expect(
      (
        await h.pool.query(
          'SELECT mentioned_member_id,mentioned_agent_id FROM entry_mentions WHERE entry_id=$1',
          [derive(mentioning)]
        )
      ).rows
    ).toEqual([{ mentioned_member_id: null, mentioned_agent_id: derive(moAgent.id) }]);
    expect(await memberRowOf(derive(moAgent.id))).toMatchObject({
      kind: 'agent',
      owner_member_id: derive(mo.memberId),
      active: false,
    });
    expect(
      (
        await h.pool.query(
          'SELECT author_member_id FROM entries WHERE community_id=$1 AND author_agent_id=$2 LIMIT 1',
          [imported.communityId, derive(moAgent.id)]
        )
      ).rows
    ).toEqual([{ author_member_id: derive(moAgent.id) }]);
  });
});
