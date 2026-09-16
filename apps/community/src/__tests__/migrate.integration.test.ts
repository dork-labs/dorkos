import { randomUUID } from 'node:crypto';
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
