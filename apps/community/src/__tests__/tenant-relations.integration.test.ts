import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for tenant relation tests');
const admin = new Pool({ connectionString: adminUrl });
let dbName: string;
let testUrl: URL;
let pool: Pool | undefined;

beforeEach(async () => {
  dbName = `community_relations_${randomUUID().replaceAll('-', '')}`;
  testUrl = new URL(adminUrl);
  testUrl.pathname = `/${dbName}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new Pool({ connectionString: testUrl.toString() });
  await applyMigrationsThroughSix(pool);
});

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
});

afterAll(async () => {
  await admin.end();
});

async function applyMigrationsThroughSix(db: Pool): Promise<void> {
  await db.query(
    'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  for (const [version, filename] of [
    [1, '0001_foundation.sql'],
    [2, '0002_admission.sql'],
    [3, '0003_files.sql'],
    [4, '0004_cleanup_backoff.sql'],
    [5, '0005_tenant_expand.sql'],
    [6, '0006_tenant_backfill.sql'],
  ] as const) {
    const source = await readFile(
      fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
      'utf8'
    );
    await db.query(source);
    await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
  }
}

async function seedTenant(db: Pool) {
  const community = (
    await db.query("INSERT INTO communities(name) VALUES('Relations') RETURNING id")
  ).rows[0].id as string;
  await db.query(
    "INSERT INTO \"user\"(id,name,email) VALUES('relations-user','Relations','relations@example.test')"
  );
  const member = (
    await db.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,'relations-user','Relations','relations','owner') RETURNING id`,
      [community]
    )
  ).rows[0].id as string;
  const channel = (
    await db.query(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,'General','private') RETURNING id",
      [community]
    )
  ).rows[0].id as string;
  const agent = (
    await db.query(
      "INSERT INTO agents(community_id,owner_member_id,display_name,handle) VALUES($1,$2,'Helper','helper') RETURNING id",
      [community, member]
    )
  ).rows[0].id as string;
  return { community, member, channel, agent };
}

async function seedEntryAndExport(db: Pool) {
  const tenant = await seedTenant(db);
  const entry = (
    await db.query(
      `INSERT INTO entries(
         community_id,channel_id,seq,author_member_id,author_display_name,text,
         idempotency_key,payload_hash,mentions
       ) VALUES($1,$2,1,$3,'Relations','hello','entry-key','entry-hash',$4) RETURNING id`,
      [
        tenant.community,
        tenant.channel,
        tenant.member,
        [tenant.member, tenant.agent, tenant.member],
      ]
    )
  ).rows[0].id as string;
  const archive = (
    await db.query(
      `INSERT INTO export_archives(
         community_id,requester_member_id,scope,channel_ids,blob_key,byte_size,expires_at
       ) VALUES($1,$2,'owner',$3,$4,8,now()+interval '1 hour') RETURNING id`,
      [tenant.community, tenant.member, [tenant.channel, tenant.channel], 'a'.repeat(64)]
    )
  ).rows[0].id as string;
  return { ...tenant, entry, archive };
}

it('backfills ordered human, agent, duplicate, and export-channel relations', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedEntryAndExport(pool);

  await migrate(testUrl.toString());

  expect(
    (
      await pool.query(
        `SELECT position,mentioned_member_id,mentioned_agent_id
         FROM entry_mentions WHERE entry_id=$1 ORDER BY position`,
        [fixture.entry]
      )
    ).rows
  ).toEqual([
    { position: 1, mentioned_member_id: fixture.member, mentioned_agent_id: null },
    { position: 2, mentioned_member_id: null, mentioned_agent_id: fixture.agent },
    { position: 3, mentioned_member_id: fixture.member, mentioned_agent_id: null },
  ]);
  expect(
    (
      await pool.query(
        `SELECT position,channel_id FROM export_archive_channels
         WHERE export_archive_id=$1 ORDER BY position`,
        [fixture.archive]
      )
    ).rows
  ).toEqual([
    { position: 1, channel_id: fixture.channel },
    { position: 2, channel_id: fixture.channel },
  ]);
  await migrate(testUrl.toString());
});

it('uses normalized relations after removing the legacy arrays and synchronization triggers', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedEntryAndExport(pool);
  await migrate(testUrl.toString());

  await pool.query('DELETE FROM entry_mentions WHERE entry_id=$1', [fixture.entry]);
  await pool.query(
    `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_agent_id)
     VALUES($1,1,$2,$3)`,
    [fixture.entry, fixture.community, fixture.agent]
  );
  await pool.query('DELETE FROM export_archive_channels WHERE export_archive_id=$1', [
    fixture.archive,
  ]);
  await pool.query(
    `INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
     VALUES($1,1,$2,$3)`,
    [fixture.archive, fixture.community, fixture.channel]
  );

  expect(
    (
      await pool.query(
        `SELECT position,mentioned_member_id,mentioned_agent_id
         FROM entry_mentions WHERE entry_id=$1 ORDER BY position`,
        [fixture.entry]
      )
    ).rows
  ).toEqual([{ position: 1, mentioned_member_id: null, mentioned_agent_id: fixture.agent }]);
  expect(
    (
      await pool.query(
        'SELECT position,channel_id FROM export_archive_channels WHERE export_archive_id=$1',
        [fixture.archive]
      )
    ).rows
  ).toEqual([{ position: 1, channel_id: fixture.channel }]);
});

it('contracts tenant ownership and enforces lifecycle owner invariants', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedEntryAndExport(pool);
  await migrate(testUrl.toString());

  const contracted = [
    'invite_uses',
    'pending_admissions',
    'connection_pairings',
    'connection_grants',
    'channel_members',
    'agent_credentials',
    'agent_channel_members',
    'entries',
    'attachments',
    'export_archives',
    'read_cursors',
    'owner_quota_windows',
  ];
  expect(
    (
      await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND column_name='community_id'
           AND table_name=ANY($1::text[]) AND is_nullable='NO'
         ORDER BY table_name`,
        [contracted]
      )
    ).rows.map((row) => row.table_name)
  ).toEqual([...contracted].sort());
  expect(
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND (
           (table_name='communities' AND column_name='singleton')
           OR (table_name='entries' AND column_name='mentions')
           OR (table_name='export_archives' AND column_name='channel_ids')
         )`
      )
    ).rows
  ).toEqual([]);

  const second = (await pool.query("INSERT INTO communities(name) VALUES('Pending') RETURNING id"))
    .rows[0].id as string;
  await expect(
    pool.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [second])
  ).rejects.toThrow('claimed community requires exactly one active owner');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,'relations-user','Relations elsewhere','relations','owner')`,
      [second]
    );
    await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [second]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  expect(
    (await pool.query(`SELECT count(*)::int AS count FROM members WHERE user_id='relations-user'`))
      .rows[0]
  ).toEqual({ count: 2 });
  const moveSource = (
    await pool.query("INSERT INTO communities(name) VALUES('Move source') RETURNING id")
  ).rows[0].id as string;
  const moveTarget = (
    await pool.query("INSERT INTO communities(name) VALUES('Move target') RETURNING id")
  ).rows[0].id as string;
  const moveUser = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
    moveUser,
    'Move Owner',
    `${moveUser}@example.test`,
  ]);
  const moveClient = await pool.connect();
  let moveMember: string;
  try {
    await moveClient.query('BEGIN');
    moveMember = (
      await moveClient.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,'Move Owner',$3,'owner') RETURNING id`,
        [moveSource, moveUser, `move-${moveUser.slice(0, 8)}`]
      )
    ).rows[0]!.id;
    await moveClient.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [moveSource]);
    await moveClient.query('COMMIT');

    await moveClient.query('BEGIN');
    await moveClient.query('UPDATE members SET community_id=$1 WHERE id=$2', [
      moveTarget,
      moveMember,
    ]);
    await moveClient.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [moveTarget]);
    await expect(moveClient.query('COMMIT')).rejects.toThrow('member community is immutable');
    await moveClient.query('ROLLBACK');
  } finally {
    moveClient.release();
  }
  expect(
    (await pool.query('SELECT community_id FROM members WHERE id=$1', [moveMember])).rows[0]
  ).toEqual({ community_id: moveSource });
  await expect(
    pool.query("UPDATE communities SET lifecycle='pending_owner' WHERE id=$1", [fixture.community])
  ).rejects.toThrow('pending_owner community cannot have an active owner');
});

it.each(['zero', 'multiple'] as const)(
  'rejects a preexisting active community with %s active owners',
  async (ownerCount) => {
    if (!pool) throw new Error('test database is unavailable');
    const community = (
      await pool.query("INSERT INTO communities(name) VALUES('Invalid owners') RETURNING id")
    ).rows[0].id as string;
    const count = ownerCount === 'zero' ? 0 : 2;
    if (ownerCount === 'multiple') await pool.query('DROP INDEX one_active_owner');
    for (let index = 0; index < count; index += 1) {
      const userId = randomUUID();
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
        userId,
        `Owner ${index}`,
        `${userId}@example.test`,
      ]);
      await pool.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,$3,$4,'owner')`,
        [community, userId, `Owner ${index}`, `owner-${index}`]
      );
    }

    await expect(migrate(testUrl.toString())).rejects.toThrow(
      'tenant contract found invalid community owner lifecycle'
    );
  }
);

it('rejects missing and human-agent-ambiguous mention targets during migration', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const tenant = await seedTenant(pool);
  const sharedId = randomUUID();
  await pool.query(
    "INSERT INTO \"user\"(id,name,email) VALUES('ambiguous-user','Ambiguous','ambiguous@example.test')"
  );
  await pool.query(
    `INSERT INTO members(id,community_id,user_id,display_name,handle,role)
     VALUES($1,$2,'ambiguous-user','Ambiguous','ambiguous','member')`,
    [sharedId, tenant.community]
  );
  await pool.query(
    `INSERT INTO agents(id,community_id,owner_member_id,display_name,handle)
     VALUES($1,$2,$3,'Ambiguous agent','ambiguous-agent')`,
    [sharedId, tenant.community, tenant.member]
  );
  await pool.query(
    `INSERT INTO entries(
       community_id,channel_id,seq,author_member_id,author_display_name,text,
       idempotency_key,payload_hash,mentions
     ) VALUES($1,$2,1,$3,'Relations','ambiguous','ambiguous-key','ambiguous-hash',$4)`,
    [tenant.community, tenant.channel, tenant.member, [randomUUID()]]
  );

  await expect(migrate(testUrl.toString())).rejects.toThrow(
    'tenant relation backfill found unresolved or ambiguous entry mentions'
  );
  await pool.query('UPDATE entries SET mentions=$1', [[sharedId]]);
  await expect(migrate(testUrl.toString())).rejects.toThrow(
    'tenant relation backfill found unresolved or ambiguous entry mentions'
  );
});

it('rejects unresolved export channels and cross-tenant updates without losing prior rows', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const tenant = await seedTenant(pool);
  await pool.query(
    `INSERT INTO export_archives(
       community_id,requester_member_id,scope,channel_ids,blob_key,byte_size,expires_at
     ) VALUES($1,$2,'owner',$3,$4,8,now()+interval '1 hour')`,
    [tenant.community, tenant.member, [randomUUID()], 'b'.repeat(64)]
  );
  await expect(migrate(testUrl.toString())).rejects.toThrow(
    'tenant relation backfill found unresolved export channels'
  );

  await pool.query('DELETE FROM export_archives');
  const entry = (
    await pool.query(
      `INSERT INTO entries(
         community_id,channel_id,seq,author_member_id,author_display_name,text,
         idempotency_key,payload_hash,mentions
       ) VALUES($1,$2,1,$3,'Relations','hello','entry-key','entry-hash',$4) RETURNING id`,
      [
        tenant.community,
        tenant.channel,
        tenant.member,
        [tenant.member, tenant.agent, tenant.member],
      ]
    )
  ).rows[0].id as string;
  const archive = (
    await pool.query(
      `INSERT INTO export_archives(
         community_id,requester_member_id,scope,channel_ids,blob_key,byte_size,expires_at
       ) VALUES($1,$2,'owner',$3,$4,8,now()+interval '1 hour') RETURNING id`,
      [tenant.community, tenant.member, [tenant.channel, tenant.channel], 'b'.repeat(64)]
    )
  ).rows[0].id as string;
  await migrate(testUrl.toString());
  const other = (await pool.query("INSERT INTO communities(name) VALUES('Other') RETURNING id"))
    .rows[0].id as string;
  const otherMember = (
    await pool.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,'relations-user','Other','other','member') RETURNING id`,
      [other]
    )
  ).rows[0].id as string;
  const otherChannel = (
    await pool.query(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,'Other','private') RETURNING id",
      [other]
    )
  ).rows[0].id as string;

  await expect(
    pool.query(
      `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id)
       VALUES($1,4,$2,$3)`,
      [entry, tenant.community, otherMember]
    )
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    pool.query(
      `INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
       VALUES($1,3,$2,$3)`,
      [archive, tenant.community, otherChannel]
    )
  ).rejects.toMatchObject({ code: '23503' });
  expect(
    (await pool.query(`SELECT count(*)::int AS count FROM members WHERE user_id='relations-user'`))
      .rows[0]
  ).toEqual({ count: 2 });
  expect(
    (
      await pool.query('SELECT count(*)::int AS count FROM entry_mentions WHERE entry_id=$1', [
        entry,
      ])
    ).rows[0]
  ).toEqual({ count: 3 });
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM export_archive_channels WHERE export_archive_id=$1',
        [archive]
      )
    ).rows[0]
  ).toEqual({ count: 2 });
});
