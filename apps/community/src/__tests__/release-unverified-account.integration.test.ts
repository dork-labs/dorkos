import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { releaseUnverifiedAccount } from '../host/release-unverified-account.js';

// The offline command that frees an email held by an account nobody has shown they own, so its
// real owner can sign up through single sign-on (spec: explicit linking only).
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for release tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_release_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let pool: Pool;

async function user(id: string, { verified = false, provider = 'credential' } = {}) {
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,$3)', [
    id,
    `${id}@example.com`,
    verified,
  ]);
  await pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$1,$2,$3,$4)`,
    [`${id}-${provider}`, provider, id, provider === 'credential' ? 'hash' : null]
  );
}

const exists = async (id: string) =>
  Boolean((await pool.query('SELECT 1 FROM "user" WHERE id=$1', [id])).rowCount);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
});

afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

describe('releaseUnverifiedAccount', () => {
  it('removes an unverified, password-only account with no membership, and audits it without the email', async () => {
    // Purpose: fails if the collision an invited stranger can create with someone else's email
    // cannot be cleared, if its sessions survive, or if the audit row leaks the address.
    await user('squatter');
    await pool.query(
      `INSERT INTO session(id,"expiresAt",token,"userId") VALUES('s1',now()+interval '1 day','t1','squatter')`
    );
    await releaseUnverifiedAccount(pool, 'Squatter@example.com');
    expect(await exists('squatter')).toBe(false);
    expect((await pool.query(`SELECT 1 FROM session WHERE id='s1'`)).rowCount).toBe(0);
    const audit = await pool.query(
      `SELECT actor_kind,action,prior_state,next_state,community_id FROM host_audit_events`
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'offline',
        action: 'account.unverified_released',
        prior_state: 'unverified',
        next_state: 'released',
        community_id: null,
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('squatter');
  });

  it('keeps any account someone has shown they own, or that belongs somewhere', async () => {
    // Purpose: fails if the command can delete a verified account, one linked to another
    // service, one with a membership (even ended), or a host operator.
    await user('verified', { verified: true });
    await user('linked', { provider: 'oidc' });
    await user('member');
    await user('operator');
    const community = (
      await pool.query("INSERT INTO communities(name) VALUES('Kept') RETURNING id")
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role,active)
       VALUES($1,'member','member','member','member',false)`,
      [community]
    );
    await pool.query(`INSERT INTO host_operators(user_id) VALUES('operator')`);
    for (const [email, reason] of [
      ['verified@example.com', 'verified email'],
      ['linked@example.com', 'signs in through another service'],
      ['member@example.com', 'has joined a community'],
      ['operator@example.com', 'has operated this host'],
      ['nobody@example.com', 'No host account'],
    ])
      await expect(releaseUnverifiedAccount(pool, email), email).rejects.toThrow(reason);
    for (const id of ['verified', 'linked', 'member', 'operator'])
      expect(await exists(id), id).toBe(true);
  });

  it('waits while the account is bound to a live join attempt, and clears expired ones', async () => {
    // Purpose: fails if release can race a join in progress, or if a stale attempt blocks it.
    await user('joining');
    await user('joining-owner', { verified: true });
    // A claimed community needs its owner in the same transaction that activates it.
    const client = await pool.connect();
    let community: string;
    let issuer: string;
    try {
      await client.query('BEGIN');
      community = (
        await client.query("INSERT INTO communities(name) VALUES('Joining') RETURNING id")
      ).rows[0].id as string;
      issuer = (
        await client.query(
          `INSERT INTO members(community_id,user_id,display_name,handle,role)
           VALUES($1,'joining-owner','Owner','owner','owner') RETURNING id`,
          [community]
        )
      ).rows[0].id as string;
      await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [community]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const invite = (
      await pool.query(
        `INSERT INTO invites(community_id,issuer_member_id,token_hash,expires_at,seat_limit)
         VALUES($1,$2,'invite-hash',now()+interval '1 day',1) RETURNING id`,
        [community, issuer]
      )
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO pending_admissions(community_id,invite_id,token_hash,account_id,bound_at,expires_at)
       VALUES($1,$2,'attempt-hash','joining',now(),now()+interval '10 minutes')`,
      [community, invite]
    );
    await expect(releaseUnverifiedAccount(pool, 'joining@example.com')).rejects.toThrow(
      'joining a community right now'
    );
    expect(await exists('joining')).toBe(true);
    await pool.query(
      `UPDATE pending_admissions SET expires_at=now()-interval '1 minute' WHERE token_hash='attempt-hash'`
    );
    await releaseUnverifiedAccount(pool, 'joining@example.com');
    expect(await exists('joining')).toBe(false);
    expect(
      (await pool.query(`SELECT 1 FROM pending_admissions WHERE token_hash='attempt-hash'`))
        .rowCount
    ).toBe(0);
  });
});
