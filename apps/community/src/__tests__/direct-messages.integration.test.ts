/**
 * Direct messages with an agent (DOR-2955, specs/everything-is-a-space C6), on a real server.
 *
 * A person starts one with an agent whose owner turned direct messages on, and only that owner
 * can. It holds the person and the agent and nobody else: no one joins, leaves, adds, removes,
 * edits or invites into it, no third person reads it in the space (its owner and admins
 * included), and the agent's owner reads it only through the agent's own credential. A
 * moderator sees a message a participant reported, as the reporter chose. `GET /channels` and
 * `/attention`, which installed apps read, leave it out. Erasure, takedowns and the space owner's
 * full export reach it like any private channel, and an import brings it back as a direct
 * message, refusing one that was tampered with.
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
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { EXPORT_SETTINGS, drainExports, openArchive } from './export-test-helpers.js';
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

let importCounter = 0;

/** Import an archive through the host API and run it to the end; its state and failure code. */
async function importArchive(archive: Buffer) {
  const key = await issueKey(h, ['communities:import']);
  const imported = await createImport(
    h,
    { bearer: key },
    { name: `Moved ${++importCounter}`, autoCommit: true }
  );
  await expectStatus(
    await uploadArchive(h, imported.importId, archive, { bearer: imported.uploadToken }),
    200,
    'upload'
  );
  const limits = {
    ...h.config.limits,
    banEmailKey: (email: string) => banEmailKey(email, h.config.authSecret),
  };
  const stateOf = async () =>
    (
      await h.pool.query<{ state: string; failure_code: string | null }>(
        'SELECT state,failure_code FROM community_imports WHERE id=$1',
        [imported.importId]
      )
    ).rows[0];
  // Until the import settles: a sweep can find it briefly leased on a busy machine.
  for (let round = 0; round < 200; round++) {
    if (['ready', 'failed'].includes((await stateOf()).state)) break;
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    await sweepImports(h.pool, h.blobStore, limits, new Date());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const settled = await stateOf();
  return { importId: imported.importId, state: settled.state, failureCode: settled.failure_code };
}

/** The owner export a later test tampers with, and the direct message in it. */
let exported: { archive: Buffer; dmId: string; personId: string } | null = null;

type Row = Record<string, unknown>;

/** Write `archive` again with `change` applied to each NDJSON file's rows and to the manifest. */
async function tampered(
  archive: Buffer,
  change: { rows?: (key: string, rows: Row[]) => Row[]; manifest?: (manifest: Row) => void }
): Promise<Buffer> {
  const opened = await openArchive(archive);
  const keyOf = new Map<string, string>();
  for (const [key, names] of Object.entries(opened.manifest.files))
    for (const name of names ?? []) keyOf.set(name, key);
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const name of opened.names) {
    let bytes = Buffer.from(opened.files.get(name)!);
    if (name === 'manifest.json' && change.manifest) {
      const manifest = JSON.parse(bytes.toString('utf8')) as Row;
      change.manifest(manifest);
      bytes = Buffer.from(JSON.stringify(manifest));
    } else if (name.endsWith('.ndjson') && change.rows) {
      const rows = bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row);
      bytes = Buffer.from(
        change
          .rows(keyOf.get(name) ?? '', rows)
          .map((row) => `${JSON.stringify(row)}\n`)
          .join('')
      );
    }
    const file =
      name.startsWith('files/') || name === 'community/icon'
        ? new ZipPassThrough(name)
        : new ZipDeflate(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
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
    // A member who may not edit channels at all is told that first, before anything about the
    // direct message.
    expect(
      (
        await h.call(`${base}/channels/${bobsDm.id}`, {
          method: 'PATCH',
          cookie: bob.cookie,
          body: { name: 'Mine' },
        })
      ).status
    ).toBe(403);
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

  it('takes no new message from its person once the owner turns them off; the agent still reads and replies', async () => {
    // Purpose: fails if a person keeps reaching the owner's computer through a direct message the
    // owner closed, or if closing it silences the agent's own reply.
    await expectStatus(await setDms({ cookie: alice.cookie }, ana.id, false), 200, 'turn off');
    expect(
      await code(
        await h.call(`${base}/channels/${bobsDm.id}/entries`, {
          cookie: bob.cookie,
          body: { text: 'are you there?', idempotencyKey: `closed-${++keyCounter}` },
        })
      )
    ).toEqual({ status: 409, code: 'AGENT_NOT_TAKING_DMS' });
    await say(bobsDm.id, { bearer: ana.token }, 'not taking new messages here for now');
    await expectStatus(
      await h.call(`${base}/channels/${bobsDm.id}/entries`, { bearer: ana.token }),
      200,
      'agent still reads'
    );
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

    exported = { archive, dmId: fays.id, personId: fay.memberId };
    const imported = await importArchive(archive);
    expect(imported).toMatchObject({ state: 'ready', failureCode: null });
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

  it('refuses an import whose direct message was tampered with', async () => {
    // Purpose: fails if an import seats anyone in a direct message but its own two, or keeps
    // one that names someone who is not a person and an agent of the export.
    const { archive, dmId, personId } = exported!;
    const dmRow = (rows: Row[]) => rows.find((row) => row.id === dmId)!;
    const opened = await openArchive(archive);
    const seats = {
      channelMembers: opened.rows<Row>('channelMembers').filter((row) => row.channel_id === dmId)
        .length,
      agentChannelMembers: opened
        .rows<Row>('agentChannelMembers')
        .filter((row) => row.channel_id === dmId).length,
    };
    const withoutDmSeats = (key: string, rows: Row[]) =>
      key === 'channelMembers' || key === 'agentChannelMembers'
        ? rows.filter((row) => row.channel_id !== dmId)
        : rows;
    const dropDmSeatCounts = (manifest: Row) => {
      const counts = manifest.counts as Record<string, number>;
      counts.channelMembers -= seats.channelMembers;
      counts.agentChannelMembers -= seats.agentChannelMembers;
    };
    const cases: Array<[string, Parameters<typeof tampered>[1]]> = [
      [
        'the space owner planted in it',
        {
          rows: (key, rows) =>
            key === 'channelMembers'
              ? [
                  ...rows,
                  { channel_id: dmId, member_id: olga.memberId, joined_at: rows[0]!.joined_at },
                ]
              : rows,
          manifest: (manifest) => {
            (manifest.counts as Record<string, number>).channelMembers += 1;
          },
        },
      ],
      // These two drop the direct message's membership rows too, so only the check that its
      // two ids name a person and an agent of the export can catch them.
      [
        'its person and agent swapped',
        {
          rows: (key, rows) => {
            if (key === 'channels') {
              const row = dmRow(rows);
              [row.dm_member_id, row.dm_agent_id] = [row.dm_agent_id, row.dm_member_id];
            }
            return withoutDmSeats(key, rows);
          },
          manifest: dropDmSeatCounts,
        },
      ],
      [
        'an agent the export does not hold',
        {
          rows: (key, rows) => {
            if (key === 'channels') dmRow(rows).dm_agent_id = crypto.randomUUID();
            return withoutDmSeats(key, rows);
          },
          manifest: dropDmSeatCounts,
        },
      ],
      [
        'a public direct message',
        {
          rows: (key, rows) => {
            if (key === 'channels') dmRow(rows).visibility = 'public';
            return rows;
          },
        },
      ],
    ];
    for (const [label, change] of cases) {
      const outcome = await importArchive(await tampered(archive, change));
      expect({ label, ...outcome }).toMatchObject({
        label,
        state: 'failed',
        failureCode: 'IMPORT_ARCHIVE_INVALID',
      });
    }
    expect(personId).toBeTruthy();
  });

  it('places an owner with no channel of their own in every channel but another person’s DM', async () => {
    // Purpose: fails if the import's rule that gives such an owner every channel also seats them
    // in somebody else's direct message.
    const { archive, dmId } = exported!;
    const opened = await openArchive(archive);
    const owned = opened
      .rows<Row>('channelMembers')
      .filter((row) => row.member_id === olga.memberId).length;
    const outcome = await importArchive(
      await tampered(archive, {
        rows: (key, rows) =>
          key === 'channelMembers' ? rows.filter((row) => row.member_id !== olga.memberId) : rows,
        manifest: (manifest) => {
          (manifest.counts as Record<string, number>).channelMembers -= owned;
        },
      })
    );
    expect(outcome).toMatchObject({ state: 'ready' });
    const derive = (id: string) => uuidv5(outcome.importId, id);
    const seated = async (channel: string) =>
      (
        await h.pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
          derive(channel),
          derive(olga.memberId),
        ])
      ).rowCount;
    expect(await seated(channelId)).toBe(1);
    expect(await seated(dmId)).toBe(0);
  });
});

describe('what reaches a direct message from outside it', { timeout: 60_000 }, () => {
  it('shows moderators a message a participant reported from it, and nothing else of it', async () => {
    // Purpose: fails if a reported direct-message message stays hidden from the moderators the
    // reporter asked, or if the rest of the direct message opens to them.
    const gus = await person('Gus Person');
    const gusDm = await dm({ cookie: gus.cookie }, ana.id);
    const reported = await say(gusDm.id, { bearer: ana.token }, 'a message gus reports');
    await say(gusDm.id, { bearer: ana.token }, 'a message nobody reports');
    await expectStatus(
      await h.call(`${base}/entries/${reported}/reports`, {
        cookie: gus.cookie,
        body: { reason: 'spam', note: 'look at this one' },
      }),
      201,
      'report'
    );
    const queue = await body<{
      reports: Array<{ entryId: string; excerpt: string | null; note: string | null }>;
    }>(await h.call(`${base}/reports`, { cookie: ada.cookie }), 200, 'queue');
    expect(queue.reports.find((report) => report.entryId === reported)).toMatchObject({
      excerpt: 'a message gus reports',
      note: 'look at this one',
    });
    expect(
      (await h.call(`${base}/channels/${gusDm.id}/entries`, { cookie: ada.cookie })).status
    ).toBe(404);
  });

  it('leaves direct messages out of the attention summary installed apps badge', async () => {
    // Purpose: fails if an installed app, which cannot open a direct message yet, is told of
    // unread messages in one.
    const ivy = await person('Ivy Person');
    const ivys = await dm({ cookie: ivy.cookie }, ana.id);
    const attention = async () =>
      body<{ unreadCount: number; mentionCount: number }>(
        await h.call(`${base}/attention`, { cookie: ivy.cookie }),
        200,
        'attention'
      );
    const before = await attention();
    await say(ivys.id, { bearer: ana.token });
    await say(ivys.id, { bearer: ana.token });
    expect(await attention()).toEqual(before);
  });

  it('lets a person message their own agent', async () => {
    const own = await dm({ cookie: alice.cookie }, ana.id);
    expect(own.member.memberId).toBe(alice.memberId);
    expect(own.agent.ownerMemberId).toBe(alice.memberId);
    await say(own.id, { cookie: alice.cookie });
    expect((await listDms({ cookie: alice.cookie })).map((row) => row.id)).toContain(own.id);
  });
});
