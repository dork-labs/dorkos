/**
 * Migration 0049 (DOR-2730): the plain notice a confirmed account gets when someone signs up
 * through an invitation with its address, and the space an invitation's sign-up was for. Applied
 * to a database that has every earlier migration and a request of each older kind, as one
 * running before would.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { COMMUNITY_MIGRATIONS, migrate } from '../migrate.js';
import { MIGRATIONS_DIR } from './space-paths.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const MIGRATION = COMMUNITY_MIGRATIONS.find(([, file]) =>
  file.endsWith('_invite_sign_up_mail.sql')
)!;
const HASH = 'a'.repeat(64);

afterAll(async () => {
  await admin.end();
});

it('adds the existing-account notice and the space column, keeping every older request (0049)', async () => {
  // Purpose: fails if the upgrade loses or rejects a request written before it, if the new kind
  // can be written without its space or with an account, or if an older kind can carry a space.
  const name = `community_invite_mail_${randomUUID().replaceAll('-', '')}`;
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
      await db.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
      await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
    }
    const userId = randomUUID();
    await db.query(
      `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,'P','p@example.test',true)`,
      [userId]
    );
    await db.query(
      `INSERT INTO email_link_requests(kind,email_hash,email,state)
       VALUES('password_reset',$1,'p@example.test','pending')`,
      [HASH]
    );
    await db.query(
      `INSERT INTO email_link_requests(kind,email_hash,user_id,state)
       VALUES('email_confirmation',$1,$2,'pending')`,
      [HASH, userId]
    );

    await migrate(url.toString());

    const kept = await db.query<{ kind: string; community_id: string | null }>(
      'SELECT kind,community_id FROM email_link_requests ORDER BY kind'
    );
    expect(kept.rows).toEqual([
      { kind: 'email_confirmation', community_id: null },
      { kind: 'password_reset', community_id: null },
    ]);
    const space = await db.query<{ id: string }>(
      "INSERT INTO communities(name,lifecycle) VALUES('Night shift','pending_owner') RETURNING id"
    );
    const communityId = space.rows[0].id;
    const insert = (kind: string, values: { user?: string; community?: string | null }) =>
      db.query(
        `INSERT INTO email_link_requests(kind,email_hash,email,user_id,community_id,state)
         VALUES($1,$2,$3,$4,$5,'pending')`,
        [
          kind,
          HASH,
          values.user ? null : 'p@example.test',
          values.user ?? null,
          values.community ?? null,
        ]
      );
    // The new kind, and a reset made by an invitation's sign-up, may name the space.
    await insert('existing_account', { community: communityId });
    await insert('password_reset', { community: communityId });
    // The new kind must name its space and no account; older kinds never name a space.
    await expect(insert('existing_account', {})).rejects.toThrow(/email_link_requests_shape/u);
    await expect(
      insert('existing_account', { community: communityId, user: userId })
    ).rejects.toThrow(/email_link_requests_shape/u);
    await expect(
      insert('email_confirmation', { community: communityId, user: userId })
    ).rejects.toThrow(/email_link_requests_shape/u);
    // Its notice is account-level, like the other mailed links.
    await db.query(
      `INSERT INTO notice_outbox(kind,subject_id,recipient_user_id,next_attempt_at)
       VALUES('account.existing_account',$1,$2,now())`,
      [randomUUID(), userId]
    );
    // Deleting the space takes its requests with it.
    await db.query('DELETE FROM communities WHERE id=$1', [communityId]);
    const left = await db.query('SELECT 1 FROM email_link_requests WHERE community_id IS NOT NULL');
    expect(left.rowCount).toBe(0);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});
