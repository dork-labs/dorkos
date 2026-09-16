import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';

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
    const row = (
      await db.query('SELECT author_member_id,author_agent_id FROM entries WHERE id=$1', [entry])
    ).rows[0];
    expect(row).toEqual({ author_member_id: member, author_agent_id: null });
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows.map(
        (item) => item.version
      )
    ).toEqual([1, 2, 3]);
    await migrate(upgradeUrl.toString());
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});
