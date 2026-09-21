import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for bootstrap HTTP tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_bootstrap_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const storagePath = `/tmp/${dbName}-blobs`;
const config = parseConfig({
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: storagePath,
});
let server: ReturnType<typeof serve>;
let pool: Pool;
let baseUrl: string;

async function preflight() {
  return fetch(`${baseUrl}/api/v1/bootstrap/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: config.bootstrapSecret }),
  });
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const app = createCommunityApp({ config, pool });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  await rm(storagePath, { recursive: true, force: true });
});

describe('first-install eligibility', () => {
  it('issues a grant only for a truly empty host', async () => {
    expect((await preflight()).status).toBe(200);
    await pool.query('DELETE FROM bootstrap_grants');

    const pending = await pool.query<{ id: string }>(
      "INSERT INTO communities(name,lifecycle) VALUES('Unclaimed','pending_owner') RETURNING id"
    );
    expect((await preflight()).status).toBe(409);
    await pool.query('DELETE FROM communities WHERE id=$1', [pending.rows[0].id]);

    await pool.query(
      `INSERT INTO "user"(id,name,email) VALUES('operator','Operator','operator@bootstrap.test')`
    );
    await pool.query("INSERT INTO host_operators(user_id) VALUES('operator')");
    expect((await preflight()).status).toBe(409);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM bootstrap_grants')).rows[0].count
    ).toBe(0);
  });
});
