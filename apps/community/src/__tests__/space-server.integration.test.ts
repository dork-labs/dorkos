import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { parseConfig } from '../config.js';
import { MIGRATIONS_DIR } from '../migrate.js';
import { createSpaceServer } from '../startup/space-server.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for space server tests');
const admin = new Pool({ connectionString: adminUrl });
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.end();
});

/** A port nothing listens on, from the system. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

it('migrates from the folder it is given, serves its web folder, and stops twice', async () => {
  // Purpose: fails if the library ignores its migrations or web folder settings, starts without
  // migrating, or a second stop throws.
  const database = `community_space_server_${randomUUID().replaceAll('-', '')}`;
  databases.push(database);
  await admin.query(`CREATE DATABASE ${database}`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  const migrationsDir = mkdtempSync(join(tmpdir(), 'space-migrations-'));
  cpSync(MIGRATIONS_DIR, migrationsDir, { recursive: true });
  // A marker only this copy carries, so the test sees which folder was read.
  appendFileSync(
    join(migrationsDir, '0001_foundation.sql'),
    '\nCREATE TABLE space_server_marker();\n'
  );
  const webDir = mkdtempSync(join(tmpdir(), 'space-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>space server test</title>');
  const port = await freePort();
  const space = createSpaceServer({
    config: parseConfig({
      COMMUNITY_DATABASE_URL: databaseUrl.toString(),
      COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
      COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
      COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
      COMMUNITY_PUBLIC_URL: `http://127.0.0.1:${port}`,
      COMMUNITY_STORAGE_PATH: mkdtempSync(join(tmpdir(), 'space-blobs-')),
      COMMUNITY_PORT: String(port),
    }),
    env: {},
    migrationsDir,
    webDir,
    paidDecisionsArmed: false,
  });
  try {
    await space.start();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({ status: 'ok' });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toContain('space server test');
    const check = new Pool({ connectionString: databaseUrl.toString() });
    const marker = await check.query("SELECT to_regclass('space_server_marker') IS NOT NULL AS ok");
    await check.end();
    expect(marker.rows[0].ok).toBe(true);
  } finally {
    await space.stop();
  }
  await expect(space.stop()).resolves.toBeUndefined();
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
});
