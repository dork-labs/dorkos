/**
 * Migration 0042, agents as members (specs/server-merge D3 and D10; design note
 * specs/server-merge/03-agents-as-members.md, PR 2; DOR-2876), on real-shaped data.
 *
 * Each test builds a space at migration 0041 the way the release before wrote it: people of
 * every role, a muted, a banned, an erased and an imported member, active, revoked, orphaned,
 * erased and imported agents, agent and person messages in a thread, mentions of both, a file by
 * an agent, a report, a removed and a taken-down message. Then it runs the real migration.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { COMMUNITY_MIGRATIONS, assertCompatibilityFloor, migrate } from '../migrate.js';
import { MIGRATIONS_DIR } from './space-paths.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const MIGRATION = COMMUNITY_MIGRATIONS.find(([, file]) => file.endsWith('_agents_as_members.sql'))!;

afterAll(async () => {
  await admin.end();
});

/** A fresh database with every migration before 0042 applied and recorded. */
async function databaseBefore(
  label: string
): Promise<{ db: Pool; url: string; drop: () => Promise<void> }> {
  const name = `community_${label}_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Pool({ connectionString: url.toString() });
  await db.query(
    'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  for (const [version, file] of COMMUNITY_MIGRATIONS) {
    if (version >= MIGRATION[0]) break;
    await db.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
  }
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    },
  };
}

interface Space {
  community: string;
  owner: string;
  admin: string;
  member: string;
  muted: string;
  banned: string;
  erased: string;
  imported: string;
  agents: Record<'active' | 'revoked' | 'orphaned' | 'erased' | 'imported' | 'admins', string>;
  personMessages: string[];
  agentMessages: string[];
}

/** Seed one space the way the release before 0042 wrote it, all in one transaction. */
async function seed(db: Pool): Promise<Space> {
  const client = await db.connect();
  const one = async (sql: string, params: unknown[] = []) =>
    (await client.query<{ id: string }>(sql, params)).rows[0].id;
  try {
    await client.query('BEGIN');
    const community = await one(
      "INSERT INTO communities(name,lifecycle) VALUES('Shaped','pending_owner') RETURNING id"
    );
    const users = ['owner', 'admin', 'member', 'muted', 'banned'];
    for (const user of users)
      await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1 || '@shaped.test',true)`,
        [`u-${user}`]
      );
    const person = (user: string, role: string, extra = '', values: unknown[] = []) =>
      one(
        `INSERT INTO members(community_id,user_id,display_name,handle,role${extra ? `,${extra}` : ''})
         VALUES($1,$2,$3,$4,$5${values.map((_, i) => `,$${i + 6}`).join('')}) RETURNING id`,
        [community, `u-${user}`, user, user, role, ...values]
      );
    const owner = await person('owner', 'owner');
    await client.query("UPDATE communities SET lifecycle='active',activated_at=now() WHERE id=$1", [
      community,
    ]);
    const adminId = await person('admin', 'admin');
    const member = await person('member', 'member');
    const muted = await person('muted', 'member', 'muted_until', [new Date(Date.now() + 3600_000)]);
    const banned = await person('banned', 'member', 'active,removed_at', [false, new Date()]);
    await client.query(
      'INSERT INTO bans(community_id,member_id,user_id,actor_member_id) VALUES($1,$2,$3,$4)',
      [community, banned, 'u-banned', owner]
    );
    const erased = await one(
      `INSERT INTO members(community_id,user_id,display_name,handle,role,active,removed_at,erased_at)
       VALUES($1,NULL,'Erased member','erased-1','member',false,now(),now()) RETURNING id`,
      [community]
    );
    const imported = await one(
      `INSERT INTO members(community_id,user_id,display_name,handle,role,active,origin)
       VALUES($1,NULL,'Imported','imported-1','member',false,'imported') RETURNING id`,
      [community]
    );
    const grant = await one(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes)
       VALUES($1,$2,$3,ARRAY['read','post','enroll-agent']) RETURNING id`,
      [community, member, randomUUID()]
    );
    const agent = (
      ownerId: string,
      handle: string,
      opts: { active?: boolean; grant?: string | null; name?: string } = {}
    ) =>
      one(
        `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id,
           enrolled_by_grant_id,active,revoked_at)
         VALUES($1,$2,$3,$4,$4,$5,$6,CASE WHEN $6 THEN NULL ELSE now() END) RETURNING id`,
        [
          community,
          ownerId,
          opts.name ?? `Agent ${handle}`,
          handle,
          opts.grant ?? null,
          opts.active ?? true,
        ]
      );
    const agents = {
      active: await agent(member, 'a-active', { grant }),
      revoked: await agent(member, 'a-revoked', { grant, active: false }),
      orphaned: await agent(member, 'a-orphaned'),
      erased: await agent(erased, 'a-erased', { active: false, name: 'Erased agent' }),
      imported: await agent(imported, 'a-imported', { active: false }),
      admins: await agent(adminId, 'a-admins'),
    };
    for (const [id, handle] of Object.entries(agents).map(([key, id]) => [id, `a-${key}`]))
      await client.query(
        'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
        [community, handle, id]
      );
    const channel = await one(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,'general','public') RETURNING id",
      [community]
    );
    let seq = 0;
    const entry = (author: { member?: string; agent?: string }, parent: string | null = null) =>
      one(
        `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_agent_id,
           author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
         VALUES($1,$2,$3,$4,$5,'Someone','words',$6,$6,$7,'h') RETURNING id`,
        [community, channel, ++seq, author.member ?? null, author.agent ?? null, parent, `k${seq}`]
      );
    const root = await entry({ member });
    const personMessages = [
      root,
      await entry({ member: adminId }),
      await entry({ member: erased }),
    ];
    const agentMessages = [
      await entry({ agent: agents.active }, root),
      await entry({ agent: agents.revoked }),
      await entry({ agent: agents.erased }),
      await entry({ agent: agents.imported }),
      await entry({ agent: agents.admins }),
    ];
    await client.query('UPDATE channels SET last_seq=$2 WHERE id=$1', [channel, seq]);
    await client.query(
      `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id,mentioned_agent_id)
       VALUES($1,1,$3,$4,NULL),($1,2,$3,NULL,$2)`,
      [root, agents.active, community, adminId]
    );
    await client.query(
      `INSERT INTO attachments(community_id,channel_id,uploader_agent_id,entry_id,blob_key,
         display_name,content_type,byte_size,checksum)
       VALUES($1,$2,$3,$4,$5,'f.txt','text/plain',3,'c')`,
      [community, channel, agents.active, agentMessages[0], `blob-${randomUUID()}`]
    );
    await client.query(
      `INSERT INTO reports(community_id,entry_id,reporter_member_id,reason) VALUES($1,$2,$3,'spam')`,
      [community, agentMessages[0], member]
    );
    await client.query(
      "UPDATE entries SET removed_at=now(),removed_by='moderator',text='Removed' WHERE id=$1",
      [agentMessages[1]]
    );
    await client.query(
      "UPDATE entries SET removed_at=now(),removed_by='host',text='Removed by the host' WHERE id=$1",
      [agentMessages[4]]
    );
    await client.query(
      `INSERT INTO community_takedowns(community_id,target_kind,entry_id,category,notify,actor_kind,
         actor_user_id,idempotency_key,payload_hash,evidence_state)
       VALUES($1,'entry',$2,'terms_violation',false,'person','u-owner','t1',$3,'not_configured')`,
      [community, agentMessages[4], 'a'.repeat(64)]
    );
    await client.query('COMMIT');
    return {
      community,
      owner,
      admin: adminId,
      member,
      muted,
      banned,
      erased,
      imported,
      agents,
      personMessages,
      agentMessages,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const rowsOf = async (db: Pool, sql: string) => (await db.query(sql)).rows;
const entriesSnapshot = (db: Pool) => rowsOf(db, 'SELECT * FROM entries ORDER BY id');
const membersSnapshot = (db: Pool) => rowsOf(db, 'SELECT * FROM members ORDER BY id');

// Purpose: the migration gives every agent exactly one member row with its own id, its owner and
// its standing, names that row as the author of every agent message and nothing else, leaves
// every person's row and every other column as it was, raises the floor to 42, refuses the
// release before by name, and is a no-op when started again.
it('migrates a real-shaped space completely, once, and refuses the release before', async () => {
  const { db, url, drop } = await databaseBefore('agents_members');
  try {
    const space = await seed(db);
    const entriesBefore = await entriesSnapshot(db);
    const peopleBefore = await membersSnapshot(db);
    const agentsBefore = await rowsOf(db, 'SELECT * FROM agents ORDER BY id');

    await migrate(url);

    // People: exactly as they were.
    const after = await membersSnapshot(db);
    expect(after.filter((row) => row.kind === 'person')).toEqual(peopleBefore);
    // One member row per agent, with the agent's id, owner and standing; no account, no handle.
    const agentRows = after.filter((row) => row.kind === 'agent');
    expect(agentRows).toHaveLength(agentsBefore.length);
    for (const agent of agentsBefore) {
      const row = agentRows.find((candidate) => candidate.id === agent.id);
      expect(row, agent.handle).toMatchObject({
        community_id: agent.community_id,
        owner_member_id: agent.owner_member_id,
        display_name: agent.display_name,
        active: agent.active,
        created_at: agent.created_at,
        removed_at: agent.revoked_at,
        user_id: null,
        handle: null,
        role: 'member',
        muted_until: null,
        rules_accepted_version: 0,
      });
    }
    // An imported owner's agent is imported with them; every other agent row is native.
    expect(Object.fromEntries(agentRows.map((row) => [row.id, row.origin]))).toEqual(
      Object.fromEntries(
        agentsBefore.map((agent) => [
          agent.id,
          agent.id === space.agents.imported ? 'imported' : 'native',
        ])
      )
    );
    // An erased owner's agent is erased with them; no other agent is.
    expect(agentRows.filter((row) => row.erased_at !== null).map((row) => row.id)).toEqual([
      space.agents.erased,
    ]);

    // Every agent message names the agent's member row; every other column is untouched.
    const entriesAfter = await entriesSnapshot(db);
    expect(entriesAfter).toEqual(
      entriesBefore.map((row) => ({
        ...row,
        author_member_id: row.author_member_id ?? row.author_agent_id,
      }))
    );
    expect(entriesAfter.filter((row) => row.author_member_id === null)).toEqual([]);
    expect(
      entriesAfter
        .filter((row) => space.agentMessages.includes(row.id))
        .every((row) => row.author_member_id === row.author_agent_id)
    ).toBe(true);

    // One-way: the floor names at least 42 (a later one-way migration, 0046, raises it again),
    // and the release that knows only 41 is refused by name.
    const floor = (await db.query('SELECT min_migration FROM community_compatibility_floor'))
      .rows[0].min_migration as number;
    expect(floor).toBeGreaterThanOrEqual(42);
    expect(() => assertCompatibilityFloor(floor, 41)).toThrow(
      `This database needs a release that knows community migration ${floor} or later; this release knows up to 41.`
    );
    // What that release would write is refused, not stored half-shaped: an agent post with no
    // member author.
    await expect(
      db.query(
        `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_agent_id,
           author_display_name,text,idempotency_key,payload_hash)
         SELECT community_id,channel_id,100,NULL,$1,'x','x','old-release','h' FROM entries LIMIT 1`,
        [space.agents.active]
      )
    ).rejects.toThrow(/author_member_id|entries_one_author/);

    // Started again: nothing changes.
    const membersOnce = await membersSnapshot(db);
    await migrate(url);
    expect(await membersSnapshot(db)).toEqual(membersOnce);
    expect(await entriesSnapshot(db)).toEqual(entriesAfter);
  } finally {
    await drop();
  }
});

// Purpose: after the migration the trigger keeps every new agent's member row, from any writer,
// and refuses an agent an agent owns or one that changes owner.
it('writes and keeps the member row of every agent added after it', async () => {
  const { db, url, drop } = await databaseBefore('agents_trigger');
  try {
    const space = await seed(db);
    await migrate(url);
    const added = (
      await db.query<{ id: string }>(
        `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
         VALUES($1,$2,'New','new','new') RETURNING id`,
        [space.community, space.owner]
      )
    ).rows[0].id;
    const row = async () =>
      (
        await db.query(
          'SELECT kind,owner_member_id,display_name,active,removed_at IS NOT NULL AS removed FROM members WHERE id=$1',
          [added]
        )
      ).rows[0];
    expect(await row()).toEqual({
      kind: 'agent',
      owner_member_id: space.owner,
      display_name: 'New',
      active: true,
      removed: false,
    });
    await db.query(
      "UPDATE agents SET active=false,revoked_at=now(),display_name='Gone' WHERE id=$1",
      [added]
    );
    expect(await row()).toMatchObject({ display_name: 'Gone', active: false, removed: true });
    await expect(
      db.query(
        `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
         VALUES($1,$2,'Sub','sub','sub')`,
        [space.community, added]
      )
    ).rejects.toThrow("An agent's owner must be a person in the same space.");
    await expect(
      db.query('UPDATE agents SET owner_member_id=$2 WHERE id=$1', [added, space.admin])
    ).rejects.toThrow('An agent keeps its id, its space and its owner.');
  } finally {
    await drop();
  }
});

// Purpose: on data that cannot take the new shape the migration refuses before changing
// anything, says what is wrong, and the database stays at 0041.
it('refuses, and changes nothing, when an agent id is already a member id', async () => {
  const { db, url, drop } = await databaseBefore('agents_refuse');
  try {
    const space = await seed(db);
    await db.query(
      `INSERT INTO members(id,community_id,user_id,display_name,handle,role,active,erased_at)
       VALUES($1,$2,NULL,'Clash','clash','member',false,now())`,
      [space.agents.orphaned, space.community]
    );
    const before = await membersSnapshot(db);
    await expect(migrate(url)).rejects.toThrow(
      'Agents as members (0042): an agent id is already a member id. Nothing was changed.'
    );
    expect(await membersSnapshot(db)).toEqual(before);
    expect(
      (await db.query('SELECT max(version)::int AS v FROM community_migrations')).rows
    ).toEqual([{ v: MIGRATION[0] - 1 }]);
  } finally {
    await drop();
  }
});
