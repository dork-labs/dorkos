/**
 * Migration 0045 (DOR-2957): a space clears every sign-in provider token it stored before this
 * release, and nothing else on the account row. Applied to a database that has every earlier
 * migration and a provider link that still holds its tokens, as one signed in before would.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { COMMUNITY_MIGRATIONS, migrate } from '../migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const MIGRATION = COMMUNITY_MIGRATIONS.find(([, file]) =>
  file.endsWith('_no_provider_tokens.sql')
)!;

afterAll(async () => {
  await admin.end();
});

it('clears every stored provider token, and keeps the links and passwords (0045)', async () => {
  // Purpose: fails if a token stored before this release survives the upgrade, or if clearing
  // them loses a sign-in method (a provider link or a password).
  const name = `community_tokens_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Pool({ connectionString: url.toString() });
  try {
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    for (const [version, file] of COMMUNITY_MIGRATIONS) {
      if (version >= MIGRATION[0]) break;
      await db.query(
        await readFile(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), 'utf8')
      );
      await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
    }
    const userId = randomUUID();
    await db.query(
      `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,'P','p@example.test',true)`,
      [userId]
    );
    await db.query(
      `INSERT INTO account(id,"accountId","providerId","userId","accessToken","refreshToken",
         "idToken","accessTokenExpiresAt","refreshTokenExpiresAt")
       VALUES('oidc-link','sub-1','oidc',$1,'access','refresh','id',now(),now()),
             ('github-link','gh-1','github',$1,'gh-access',NULL,NULL,NULL,NULL)`,
      [userId]
    );
    await db.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password)
       VALUES('password','p','credential',$1,'hash')`,
      [userId]
    );

    await migrate(url.toString());

    const rows = await db.query(
      `SELECT id,"accountId","providerId",password,"accessToken","refreshToken","idToken",
              "accessTokenExpiresAt","refreshTokenExpiresAt" FROM account ORDER BY id`
    );
    const cleared = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    };
    expect(rows.rows).toEqual([
      { id: 'github-link', accountId: 'gh-1', providerId: 'github', password: null, ...cleared },
      { id: 'oidc-link', accountId: 'sub-1', providerId: 'oidc', password: null, ...cleared },
      { id: 'password', accountId: 'p', providerId: 'credential', password: 'hash', ...cleared },
    ]);
    const applied = await db.query('SELECT 1 FROM community_migrations WHERE version=$1', [
      MIGRATION[0],
    ]);
    expect(applied.rowCount).toBe(1);
  } finally {
    await db.end();
    // Wait for the pool's connections to finish closing: FORCE would terminate one mid-close into
    // an uncaught 57P01 (see migrate.integration.test.ts).
    for (let tries = 0; tries < 100; tries++) {
      const open = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',
        [name]
      );
      if (open.rows[0].n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});
