/**
 * Direct messages with an agent (DOR-2955, specs/everything-is-a-space C6), on a real server.
 *
 * A person starts one with an agent whose owner turned direct messages on, and only that owner
 * can. It holds the person and the agent and nobody else: no one joins, leaves, adds, removes,
 * edits or invites into it, no third person reads it (a space owner or admin included), and the
 * agent's owner reads it only through the agent's own credential. `GET /channels`, which
 * installed apps parse strictly, never lists one. Erasure, takedowns and exports reach it like
 * any channel, and an import brings it back as a direct message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityWireAgentDirectMessagesResponseSchema,
  CommunityWireDirectMessageListResponseSchema,
  CommunityWireDirectMessageResponseSchema,
  type CommunityWireDirectMessage,
} from '@dorkos/shared/community-wire';
import { eraseMembership } from '../erasure/erasure.js';
import { uuidv5 } from '../imports/derived-id.js';
import { sweepImports } from '../imports/worker.js';
import { banEmailKey } from '../moderation/bans.js';
import { EXPORT_SETTINGS, drainExports } from './export-test-helpers.js';
import { createImport, issueKey, uploadArchive } from './import-fixture.js';
import { body, drainCleanup, post } from './member-erasure-fixture.js';
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
/** The space's owner, who is also its host operator. */
let olga: TenancyMember;
/** An admin. */
let ada: TenancyMember;
/** Ana's owner. */
let alice: TenancyMember;
/** The person who messages Ana. */
let bob: TenancyMember;
/** A third person in the space. */
let carol: TenancyMember;
let ana: { id: string; token: string; grant: string };
let keyCounter = 0;

type Auth = { cookie?: string; bearer?: string };

async function person(name: string): Promise<TenancyMember> {
  const slug = name.toLowerCase().replaceAll(' ', '-');
  return admit(h, communityId, olga.cookie, { name, email: `${slug}@dms.test` });
}

async function enroll(who: TenancyMember, label: string) {
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
      body: { localAgentId: `local-${label}`, displayName: `Agent ${label}` },
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

function setDms(auth: Auth, agentId: string, accepts: boolean) {
  return h.call(`${base}/agents/${agentId}/dms`, { ...auth, method: 'PUT', body: { accepts } });
}

function startDm(auth: Auth, agentId: string) {
  return h.call(`${base}/dms`, { ...auth, body: { agentId } });
}

async function dm(auth: Auth, agentId: string, status = 201): Promise<CommunityWireDirectMessage> {
  return CommunityWireDirectMessageResponseSchema.parse(
    await body(await startDm(auth, agentId), status, 'start dm')
  ).dm;
}

async function listDms(auth: Auth) {
  return CommunityWireDirectMessageListResponseSchema.parse(
    await body(await h.call(`${base}/dms`, auth), 200, 'list dms')
  ).dms;
}

async function channelIds(auth: Auth): Promise<string[]> {
  const listed = await body<{ channels: Array<{ id: string }> }>(
    await h.call(`${base}/channels`, auth),
    200,
    'list channels'
  );
  return listed.channels.map((channel) => channel.id);
}

async function say(channel: string, auth: Auth, text = `hello ${++keyCounter}`) {
  return (await post(h, communityId, channel, auth, { text, idempotencyKey: `k-${++keyCounter}` }))
    .id;
}

async function code(response: Response): Promise<{ status: number; code: string | undefined }> {
  const parsed = (await response.json().catch(() => ({}))) as { code?: string };
  return { status: response.status, code: parsed.code };
}

beforeAll(async () => {
  h = await startTenancyHarness('direct_messages');
  const host = await bootstrapHost(h, 'Olga Owner', 'olga@dms.test');
  olga = { cookie: host.cookie, memberId: host.memberId };
  communityId = host.communityId;
  channelId = host.channelId;
  base = `/api/v1/communities/${communityId}`;
  ada = await person('Ada Admin');
  alice = await person('Alice Owner');
  bob = await person('Bob Person');
  carol = await person('Carol Person');
  await expectStatus(
    await h.call(`${base}/members/${ada.memberId}/role`, {
      method: 'PATCH',
      cookie: olga.cookie,
      body: { role: 'admin' },
    }),
    200,
    'make admin'
  );
  ana = await enroll(alice, 'ana');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('the owner’s switch', { timeout: 60_000 }, () => {
  it('is off for a new agent, so nobody can start a direct message with it', async () => {
    // Purpose: fails if a direct message reaches an agent whose owner never allowed them.
    expect(await code(await startDm({ cookie: bob.cookie }, ana.id))).toEqual({
      status: 409,
      code: 'AGENT_NOT_TAKING_DMS',
    });
    expect(await listDms({ cookie: bob.cookie })).toEqual([]);
  });

  it('is the agent’s owner’s alone: no other person, admin or space owner can flip it', async () => {
    // Purpose: fails if anyone but the agent's owner decides who reaches the owner's computer.
    for (const who of [bob, carol, ada, olga]) {
      expect((await setDms({ cookie: who.cookie }, ana.id, true)).status).toBe(403);
    }
    const stored = await h.pool.query('SELECT accepts_dms FROM agents WHERE id=$1', [ana.id]);
    expect(stored.rows[0]).toEqual({ accepts_dms: false });
  });

  it('turns on from the owner’s browser or from the installation that enrolled the agent', async () => {
    const byGrant = CommunityWireAgentDirectMessagesResponseSchema.parse(
      await body(await setDms({ bearer: ana.grant }, ana.id, true), 200, 'grant turns on')
    );
    expect(byGrant).toEqual({ agentId: ana.id, acceptsDms: true });
    await expectStatus(await setDms({ cookie: alice.cookie }, ana.id, true), 200, 'owner');
  });
});

describe('a direct message', { timeout: 60_000 }, () => {
  let bobsDm: CommunityWireDirectMessage;

  beforeAll(async () => {
    await expectStatus(await setDms({ cookie: alice.cookie }, ana.id, true), 200, 'turn on');
    bobsDm = await dm({ cookie: bob.cookie }, ana.id);
  });

  it('is started once: asking again finds the same one', async () => {
    expect(bobsDm).toMatchObject({
      member: { memberId: bob.memberId, displayName: 'Bob Person' },
      agent: {
        memberId: ana.id,
        displayName: 'Agent ana',
        ownerMemberId: alice.memberId,
        ownerDisplayName: 'Alice Owner',
      },
      unreadCount: 0,
    });
    const again = await dm({ cookie: bob.cookie }, ana.id, 200);
    expect(again.id).toBe(bobsDm.id);
    const rows = await h.pool.query(
      "SELECT count(*)::int AS n FROM channels WHERE community_id=$1 AND kind='dm'",
      [communityId]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('is listed for its person and for its agent, and only them', async () => {
    expect((await listDms({ cookie: bob.cookie })).map((row) => row.id)).toEqual([bobsDm.id]);
    expect((await listDms({ bearer: ana.token })).map((row) => row.id)).toEqual([bobsDm.id]);
    for (const who of [carol, ada, olga, alice]) {
      expect(await listDms({ cookie: who.cookie })).toEqual([]);
    }
  });

  it('never appears in GET /channels, which installed apps parse strictly', async () => {
    // Purpose: fails if a direct message reaches the channel list, as an older app would show it.
    expect(await channelIds({ cookie: bob.cookie })).not.toContain(bobsDm.id);
    expect(await channelIds({ bearer: ana.token })).not.toContain(bobsDm.id);
    expect(await channelIds({ bearer: ana.token })).toContain(channelId);
  });

  it('is read and written by its two members, and nobody else', async () => {
    // Purpose: fails if a third person, an admin, the space owner, or the agent's owner by their
    // own account, reads a direct message.
    const bobSaid = await say(bobsDm.id, { cookie: bob.cookie });
    await say(bobsDm.id, { bearer: ana.token });
    const read = await body<{ entries: Array<{ id: string }> }>(
      await h.call(`${base}/channels/${bobsDm.id}/entries`, { bearer: ana.token }),
      200,
      'agent reads'
    );
    expect(read.entries.map((entry) => entry.id)).toContain(bobSaid);
    for (const who of [carol, ada, olga, alice]) {
      const response = await h.call(`${base}/channels/${bobsDm.id}/entries`, {
        cookie: who.cookie,
      });
      expect(response.status).toBe(404);
    }
    const third = await h.call(`${base}/channels/${bobsDm.id}/entries`, {
      cookie: carol.cookie,
      body: { text: 'let me in', idempotencyKey: `third-${++keyCounter}` },
    });
    expect(third.status).toBe(404);
  });

  it('cannot be joined, left, edited, invited into, or have members or agents changed', async () => {
    // Purpose: fails if any route that reshapes a channel reshapes a direct message. Ada starts
    // her own, so the admin-only routes reach it as one of its members.
    const adas = await dm({ cookie: ada.cookie }, ana.id);
    const refused = { status: 409, code: 'STATE_CONFLICT' };
    expect(
      await code(
        await h.call(`${base}/channels/${bobsDm.id}/join`, { cookie: bob.cookie, body: {} })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${bobsDm.id}/leave`, { cookie: bob.cookie, body: {} })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${adas.id}/members`, {
          cookie: ada.cookie,
          body: { memberId: carol.memberId },
        })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${adas.id}/members/${ada.memberId}`, {
          method: 'DELETE',
          cookie: ada.cookie,
        })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${adas.id}`, {
          method: 'PATCH',
          cookie: ada.cookie,
          body: { name: 'Not a DM' },
        })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${adas.id}/agents`, {
          cookie: ada.cookie,
          body: { agentId: ana.id },
        })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/channels/${adas.id}/agents/${ana.id}`, {
          method: 'DELETE',
          cookie: ada.cookie,
        })
      )
    ).toEqual(refused);
    expect(
      await code(
        await h.call(`${base}/invites`, {
          cookie: ada.cookie,
          body: { seats: 1, channelId: adas.id },
        })
      )
    ).toEqual(refused);
    // And somebody outside it learns nothing about it.
    expect(
      (await h.call(`${base}/channels/${bobsDm.id}/join`, { cookie: carol.cookie, body: {} }))
        .status
    ).toBe(404);
    const members = await h.pool.query(
      `SELECT (SELECT array_agg(member_id::text ORDER BY member_id) FROM channel_members WHERE channel_id=$1) AS people,
              (SELECT array_agg(agent_id::text) FROM agent_channel_members WHERE channel_id=$1) AS agents`,
      [adas.id]
    );
    expect(members.rows[0]).toEqual({ people: [ada.memberId], agents: [ana.id] });
  });

  it('cannot be started with an agent its owner removed, even one that took them', async () => {
    const bo = await enroll(alice, 'bo');
    await expectStatus(await setDms({ cookie: alice.cookie }, bo.id, true), 200, 'turn on');
    await expectStatus(
      await h.call(`${base}/agents/${bo.id}`, { method: 'DELETE', cookie: alice.cookie }),
      204,
      'remove agent'
    );
    expect(await code(await startDm({ cookie: carol.cookie }, bo.id))).toEqual({
      status: 409,
      code: 'AGENT_NOT_TAKING_DMS',
    });
  });

  it('is started only by a person', async () => {
    expect((await startDm({ bearer: ana.token }, ana.id)).status).toBe(403);
  });

  it('cannot be started once the owner turns them off, while one already started still reads', async () => {
    await expectStatus(await setDms({ cookie: alice.cookie }, ana.id, false), 200, 'turn off');
    expect(await code(await startDm({ cookie: carol.cookie }, ana.id))).toEqual({
      status: 409,
      code: 'AGENT_NOT_TAKING_DMS',
    });
    expect(await code(await startDm({ cookie: bob.cookie }, ana.id))).toEqual({
      status: 409,
      code: 'AGENT_NOT_TAKING_DMS',
    });
    await expectStatus(
      await h.call(`${base}/channels/${bobsDm.id}/entries`, { cookie: bob.cookie }),
      200,
      'still reads'
    );
    await expectStatus(await setDms({ cookie: alice.cookie }, ana.id, true), 200, 'turn on');
  });
});

describe('the schema', () => {
  it('holds a direct message to its shape: private, never joined on arrival, one per pair', async () => {
    const insert = (visibility: string, autoJoin: boolean, agent = ana.id) =>
      h.pool.query(
        `INSERT INTO channels(community_id,name,visibility,auto_join,kind,dm_member_id,dm_agent_id)
         VALUES($1,'x',$2,$3,'dm',$4,$5)`,
        [communityId, visibility, autoJoin, carol.memberId, agent]
      );
    await expect(insert('public', false)).rejects.toThrow(/channels_dm_shape/);
    await expect(insert('private', true)).rejects.toThrow(/channels_dm_shape/);
    await expect(insert('private', false, carol.memberId)).rejects.toThrow(/channels_dm_shape/);
    await expect(
      h.pool.query(
        `INSERT INTO channels(community_id,name,visibility,dm_member_id) VALUES($1,'x','private',$2)`,
        [communityId, carol.memberId]
      )
    ).rejects.toThrow(/channels_dm_shape/);
    await insert('private', false);
    await expect(insert('private', false)).rejects.toThrow(/channels_one_dm/);
    await h.pool.query("DELETE FROM channels WHERE kind='dm' AND dm_member_id=$1", [
      carol.memberId,
    ]);
  });
});

describe('the rest of the space reaches a direct message', { timeout: 120_000 }, () => {
  it('erases a person’s messages in their direct messages', async () => {
    const erin = await person('Erin Person');
    const erins = await dm({ cookie: erin.cookie }, ana.id);
    const said = await say(erins.id, { cookie: erin.cookie });
    expect(
      await eraseMembership(h.pool, communityId, erin.memberId, { log: () => undefined })
    ).toBe('erased');
    const row = await h.pool.query(
      'SELECT erased_at IS NOT NULL AS erased FROM entries WHERE id=$1',
      [said]
    );
    expect(row.rows[0]).toEqual({ erased: true });
  });

  it('lets the host take down a message in one', async () => {
    const dave = await person('Dave Person');
    const daves = await dm({ cookie: dave.cookie }, ana.id);
    const said = await say(daves.id, { cookie: dave.cookie });
    await expectStatus(
      await h.call(`/api/v1/host/communities/${communityId}/takedowns`, {
        cookie: olga.cookie,
        body: {
          idempotencyKey: `takedown-${++keyCounter}`,
          category: 'illegal_content',
          reference: null,
          target: { kind: 'entry', entryId: said },
          password: TENANCY_PASSWORD,
        },
      }),
      201,
      'takedown'
    );
    const row = await h.pool.query('SELECT removed_by FROM entries WHERE id=$1', [said]);
    expect(row.rows[0]).toEqual({ removed_by: 'host' });
  });

  it('exports a direct message as one, and an import brings it back as one', async () => {
    const fay = await person('Fay Person');
    const fays = await dm({ cookie: fay.cookie }, ana.id);
    const said = await say(fays.id, { cookie: fay.cookie });
    await drainExports(h.pool, h.blobStore);
    await h.pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE state='ready'"
    );
    const created = await body<{ export: { id: string } }>(
      await h.call(`${base}/owner/export`, {
        cookie: olga.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      202,
      'owner export'
    );
    await drainExports(h.pool, h.blobStore, { settings: EXPORT_SETTINGS });
    const archive = Buffer.from(
      await (
        await h.call(`${base}/exports/${created.export.id}/archive`, { cookie: olga.cookie })
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
    expect((await stateOf()).rows[0].state).toBe('ready');
    const derive = (id: string) => uuidv5(imported.importId, id);
    const restored = await h.pool.query(
      `SELECT kind,visibility,auto_join,dm_member_id,dm_agent_id,
         (SELECT array_agg(member_id) FROM channel_members WHERE channel_id=c.id) AS people,
         (SELECT array_agg(agent_id) FROM agent_channel_members WHERE channel_id=c.id) AS agents
       FROM channels c WHERE id=$1`,
      [derive(fays.id)]
    );
    expect(restored.rows[0]).toEqual({
      kind: 'dm',
      visibility: 'private',
      auto_join: false,
      dm_member_id: derive(fay.memberId),
      dm_agent_id: derive(ana.id),
      // An import restores only the importing owner's memberships, in every channel alike: Fay
      // and Ana come back as people and agents who must rejoin, and so does their seat here.
      people: null,
      agents: null,
    });
    const message = await h.pool.query('SELECT channel_id FROM entries WHERE id=$1', [
      derive(said),
    ]);
    expect(message.rows[0]).toEqual({ channel_id: derive(fays.id) });
    // The importing owner, who had no channel of their own, is placed in every channel but this.
    const ownerIn = await h.pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2',
      [derive(fays.id), derive(olga.memberId)]
    );
    expect(ownerIn.rowCount).toBe(0);
  });
});
