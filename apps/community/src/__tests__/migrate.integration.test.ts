import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { inspectBackout } from '../backout.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_foundation_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

it('creates all owner, conversation, credential and auth tables in fresh Postgres', async () => {
  await migrate(testUrl.toString());
  const db = new Pool({ connectionString: testUrl.toString() });
  try {
    const result = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const names = result.rows.map((row) => row.tablename);
    for (const name of [
      'communities',
      'user',
      'session',
      'members',
      'bootstrap_grants',
      'channels',
      'channel_members',
      'entries',
      'read_cursors',
      'agents',
      'agent_credentials',
      'invites',
      'invite_uses',
      'pending_admissions',
      'connection_pairings',
      'connection_grants',
      'attachments',
      'pending_blob_deletions',
      'export_archives',
      'owner_quota_windows',
      'audit_events',
      'host_operators',
      'managed_blobs',
      'tenant_reconciliation',
      'community_backout_fence',
      'entry_mentions',
      'export_archive_channels',
    ]) {
      expect(names).toContain(name);
    }
    await migrate(testUrl.toString());
  } finally {
    await db.end();
  }
});

it('upgrades a populated foundation database without changing human authors', async () => {
  const upgradeName = `community_upgrade_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    const foundation = await readFile(
      fileURLToPath(new URL('../../migrations/0001_foundation.sql', import.meta.url)),
      'utf8'
    );
    await db.query(foundation);
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    await db.query('INSERT INTO community_migrations(version) VALUES(1)');
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Upgrade') RETURNING id")
    ).rows[0].id;
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('upgrade-user','Upgrade','upgrade@example.test')"
    );
    const member = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'upgrade-user','Upgrade','upgrade','owner') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const channel = (
      await db.query(
        "INSERT INTO channels(community_id,name,visibility,last_seq) VALUES($1,'General','public',1) RETURNING id",
        [community]
      )
    ).rows[0].id;
    const entry = (
      await db.query(
        "INSERT INTO entries(channel_id,seq,author_member_id,author_display_name,text,idempotency_key,payload_hash) VALUES($1,1,$2,'Upgrade','old','key','hash') RETURNING id",
        [channel, member]
      )
    ).rows[0].id;
    await migrate(upgradeUrl.toString());
    expect(await inspectBackout(db)).toEqual({ eligible: true, reason: 'single-community' });
    const row = (
      await db.query(
        'SELECT author_member_id,author_agent_id,community_id FROM entries WHERE id=$1',
        [entry]
      )
    ).rows[0];
    expect(row).toEqual({
      author_member_id: member,
      author_agent_id: null,
      community_id: community,
    });
    expect(
      (
        await db.query('SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1', [
          community,
        ])
      ).rows[0]
    ).toEqual({ lifecycle: 'active', lifecycle_version: 1 });
    expect(
      (
        await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='managed_blobs'
           ORDER BY ordinal_position`
        )
      ).rows.map((item) => item.column_name)
    ).toEqual([
      'blob_key',
      'community_id',
      'purpose',
      'community_lifecycle_version',
      'state',
      'byte_size',
      'checksum',
      'created_at',
      'stored_at',
      'committed_at',
    ]);
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows.map(
        (item) => item.version
      )
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await migrate(upgradeUrl.toString());
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});

it('expands a populated version-four database without changing files or cleanup work', async () => {
  const upgradeName = `community_v4_upgrade_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    for (const [version, filename] of [
      [1, '0001_foundation.sql'],
      [2, '0002_admission.sql'],
      [3, '0003_files.sql'],
      [4, '0004_cleanup_backoff.sql'],
    ] as const) {
      await db.query(
        await readFile(
          fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
          'utf8'
        )
      );
      await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
    }
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Version Four') RETURNING id")
    ).rows[0].id;
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('v4-user','Version Four','v4@example.test')"
    );
    const member = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'v4-user','Version Four','v4','owner') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const channel = (
      await db.query(
        "INSERT INTO channels(community_id,name,visibility) VALUES($1,'Files','private') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const attachment = (
      await db.query(
        `INSERT INTO attachments(channel_id,uploader_member_id,blob_key,display_name,content_type,byte_size,checksum,idempotency_key,request_hash)
         VALUES($1,$2,$3,'proof.txt','text/plain; charset=utf-8',5,'attachment-checksum','attachment-key','attachment-request') RETURNING id`,
        [channel, member, 'a'.repeat(64)]
      )
    ).rows[0].id;
    const archive = (
      await db.query(
        `INSERT INTO export_archives(requester_member_id,scope,channel_ids,blob_key,byte_size,expires_at)
         VALUES($1,'owner',ARRAY[$2::uuid],$3,8,now()+interval '1 hour') RETURNING id`,
        [member, channel, 'b'.repeat(64)]
      )
    ).rows[0].id;
    await db.query('INSERT INTO pending_blob_deletions(blob_key) VALUES($1)', ['c'.repeat(64)]);

    await migrate(upgradeUrl.toString());

    expect(
      (
        await db.query(
          `SELECT
             (SELECT count(*)::int FROM attachments WHERE id=$1) AS attachments,
             (SELECT count(*)::int FROM export_archives WHERE id=$2) AS exports,
             (SELECT count(*)::int FROM pending_blob_deletions WHERE blob_key=$3) AS pending,
             (SELECT count(*)::int FROM managed_blobs) AS inventory`,
          [attachment, archive, 'c'.repeat(64)]
        )
      ).rows[0]
    ).toEqual({ attachments: 1, exports: 1, pending: 1, inventory: 0 });
    expect(
      (
        await db.query(
          `SELECT a.community_id AS attachment_community,e.community_id AS export_community
           FROM attachments a CROSS JOIN export_archives e WHERE a.id=$1 AND e.id=$2`,
          [attachment, archive]
        )
      ).rows[0]
    ).toEqual({ attachment_community: community, export_community: community });
    expect(
      (
        await db.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname='public' AND tablename='members'
             AND indexname IN ('members_user_id_key','members_community_user_unique')
           ORDER BY indexname`
        )
      ).rows.map((item) => item.indexname)
    ).toEqual(['members_community_user_unique']);
    await db.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state)
       VALUES($1,$2,'attachment',1,'pending_delete')`,
      ['d'.repeat(64), community]
    );
    await db.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,byte_size,checksum,stored_at,committed_at)
       VALUES($1,$2,'export',1,'committed',8,'archive-checksum',now(),now())`,
      ['e'.repeat(64), community]
    );
    await db.query("UPDATE managed_blobs SET state='pending_delete' WHERE blob_key=$1", [
      'e'.repeat(64),
    ]);
    expect(
      (
        await db.query(
          'SELECT state,committed_at IS NOT NULL AS kept FROM managed_blobs WHERE blob_key=$1',
          ['e'.repeat(64)]
        )
      ).rows[0]
    ).toEqual({ state: 'pending_delete', kept: true });
    await expect(
      db.query(
        `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,checksum,stored_at)
         VALUES($1,$2,'attachment',1,'stored','incomplete',now())`,
        ['f'.repeat(64), community]
      )
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows.map(
        (item) => item.version
      )
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      (
        await db.query(
          `SELECT state,community_id,generation,reason_code
           FROM tenant_reconciliation WHERE singleton`
        )
      ).rows[0]
    ).toEqual({
      state: 'dirty',
      community_id: community,
      generation: '4',
      reason_code: 'managed_blob_write',
    });
    expect(
      (await db.query('SELECT user_id FROM host_operators WHERE user_id=$1', ['v4-user'])).rows
    ).toEqual([{ user_id: 'v4-user' }]);
    await db.query(
      `UPDATE tenant_reconciliation
       SET state='ready',validated_generation=generation,namespace_digest=$1,
           completed_at=now(),reason_code='validated'
       WHERE singleton`,
      ['0'.repeat(64)]
    );
    await db.query("UPDATE attachments SET display_name='proof-renamed.txt' WHERE id=$1", [
      attachment,
    ]);
    expect(
      (
        await db.query(
          'SELECT state,generation,validated_generation,reason_code FROM tenant_reconciliation WHERE singleton'
        )
      ).rows[0]
    ).toEqual({
      state: 'ready',
      generation: '4',
      validated_generation: '4',
      reason_code: 'validated',
    });
    await migrate(upgradeUrl.toString());
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});
