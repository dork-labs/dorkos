import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { migrate } from '../migrate.js';
import { recoverPassword } from '../recover-password.js';
import { createCommunityAuth } from '../auth.js';
import { parseConfig } from '../config.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for recovery tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_recovery_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let pool: Pool;
let communityId: string;
let ownerId: string;
let otherId: string;
let agentId: string;
let auth: ReturnType<typeof createCommunityAuth>;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString(), max: 1 });
  auth = createCommunityAuth(
    pool,
    parseConfig({
      COMMUNITY_DATABASE_URL: dbUrl.toString(),
      COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
      COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
      COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
      COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
      COMMUNITY_STORAGE_PATH: '/tmp/community-recovery-unused',
    })
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    communityId = (
      await client.query("INSERT INTO communities(name) VALUES('Recovery') RETURNING id")
    ).rows[0].id;
    for (const [id, role] of [
      ['owner', 'owner'],
      ['other', 'member'],
    ]) {
      await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [
        id,
        `${id}@example.test`,
      ]);
      await client.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$1,'credential',$1,$2)`,
        [id, await hashPassword('old-password-123')]
      );
      const member = (
        await client.query(
          'INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$2,$2,$3) RETURNING id',
          [communityId, id, role]
        )
      ).rows[0].id;
      if (id === 'owner') ownerId = member;
      else otherId = member;
      await client.query(
        `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes) VALUES($1,$2,$3,'{read,post}')`,
        [communityId, member, id]
      );
      await client.query(
        `INSERT INTO connection_pairings(community_id,verifier_hash,member_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,
        [communityId, id, member]
      );
    }
    agentId = (
      await client.query(
        "INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id) VALUES($1,$2,'Agent','agent','local-agent') RETURNING id",
        [communityId, ownerId]
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,'agent-token')",
      [communityId, agentId]
    );
    await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [communityId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () => {
  if (pool) await endRecoveryPool(pool);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

async function endRecoveryPool(pool: Pool) {
  const disconnected = pool.totalCount === 0 ? Promise.resolve() : once(pool, 'remove');
  await Promise.all([pool.end(), disconnected]);
}

type CloseablePoolClient = PoolClient & {
  end(callback: (error: Error) => void): void;
};

function signIn(email: string, password: string) {
  return auth.handler(
    new Request('http://localhost:6481/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:6481' },
      body: JSON.stringify({ email, password }),
    })
  );
}

describe('offline member recovery', () => {
  it('waits for the PostgreSQL client close acknowledgement before teardown completes', async () => {
    const delayedPool = new Pool({ connectionString: dbUrl.toString(), max: 1 });
    const client = (await delayedPool.connect()) as CloseablePoolClient;
    await client.query('SELECT 1');
    const originalEnd = client.end.bind(client);
    let reportCloseAttempt!: () => void;
    const closeAttempted = new Promise<void>((resolve) => {
      reportCloseAttempt = resolve;
    });
    let acknowledgeClose!: () => void;
    const closeAcknowledged = new Promise<void>((resolve) => {
      acknowledgeClose = resolve;
    });
    client.end = (callback: (error: Error) => void) => {
      originalEnd((error) => {
        reportCloseAttempt();
        void closeAcknowledged.then(() => callback(error));
      });
    };
    client.release();

    let teardownSettled = false;
    const teardown = endRecoveryPool(delayedPool).then(() => {
      teardownSettled = true;
    });
    try {
      await closeAttempted;
      expect(teardownSettled).toBe(false);
    } finally {
      acknowledgeClose();
      await teardown;
    }
    expect(teardownSettled).toBe(true);
  });

  it('recovers one host login and revokes derived access across every membership', async () => {
    const second = await pool.connect();
    let secondCommunityId: string;
    let secondMemberId: string;
    let secondAgentId: string;
    try {
      await second.query('BEGIN');
      secondCommunityId = (
        await second.query("INSERT INTO communities(name) VALUES('Recovery Two') RETURNING id")
      ).rows[0].id;
      secondMemberId = (
        await second.query(
          `INSERT INTO members(community_id,user_id,display_name,handle,role)
           VALUES($1,'owner','Owner Two','owner-two','owner') RETURNING id`,
          [secondCommunityId]
        )
      ).rows[0].id;
      await second.query(
        `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes)
         VALUES($1,$2,'owner-second','{read,post}')`,
        [secondCommunityId, secondMemberId]
      );
      await second.query(
        `INSERT INTO connection_pairings(community_id,verifier_hash,member_id,expires_at)
         VALUES($1,'owner-second',$2,now()+interval '10 minutes')`,
        [secondCommunityId, secondMemberId]
      );
      secondAgentId = (
        await second.query(
          `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
           VALUES($1,$2,'Agent Two','agent-two','local-agent-two') RETURNING id`,
          [secondCommunityId, secondMemberId]
        )
      ).rows[0].id;
      await second.query(
        `INSERT INTO agent_credentials(community_id,agent_id,token_hash)
         VALUES($1,$2,'agent-token-two')`,
        [secondCommunityId, secondAgentId]
      );
      await second.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [
        secondCommunityId,
      ]);
      await second.query('COMMIT');
    } catch (error) {
      await second.query('ROLLBACK');
      throw error;
    } finally {
      second.release();
    }

    expect((await signIn('owner@example.test', 'old-password-123')).status).toBe(200);
    expect((await signIn('other@example.test', 'old-password-123')).status).toBe(200);
    await recoverPassword(pool, 'owner@example.test', 'new-password-456');
    expect((await signIn('owner@example.test', 'old-password-123')).status).toBe(401);
    expect((await signIn('owner@example.test', 'new-password-456')).status).toBe(200);
    expect(
      (
        await pool.query(
          `SELECT community_id,actor_member_id,subject_id FROM audit_events
           WHERE action='member.password_recovery' AND subject_id=ANY($1::text[])
           ORDER BY community_id`,
          [[ownerId, secondMemberId]]
        )
      ).rows
    ).toEqual(
      [
        { community_id: communityId, actor_member_id: null, subject_id: ownerId },
        { community_id: secondCommunityId, actor_member_id: null, subject_id: secondMemberId },
      ].sort((left, right) => left.community_id.localeCompare(right.community_id))
    );
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', ['owner']))
        .rows[0].count
    ).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', ['other']))
        .rows[0].count
    ).toBe(1);
    expect(
      (await pool.query('SELECT role,active FROM members WHERE id=$1', [ownerId])).rows[0]
    ).toEqual({ role: 'owner', active: true });
    expect(
      (await pool.query('SELECT revoked_at FROM connection_grants WHERE member_id=$1', [ownerId]))
        .rows[0].revoked_at
    ).not.toBeNull();
    expect(
      (await pool.query('SELECT revoked_at FROM connection_grants WHERE member_id=$1', [otherId]))
        .rows[0].revoked_at
    ).toBeNull();
    for (const id of [agentId, secondAgentId]) {
      expect(
        (await pool.query('SELECT revoked_at FROM agent_credentials WHERE agent_id=$1', [id]))
          .rows[0].revoked_at
      ).not.toBeNull();
    }
    expect(
      (
        await pool.query('SELECT revoked_at FROM connection_grants WHERE member_id=$1', [
          secondMemberId,
        ])
      ).rows[0].revoked_at
    ).not.toBeNull();
    expect(
      (
        await pool.query('SELECT cancelled_at FROM connection_pairings WHERE member_id=$1', [
          secondMemberId,
        ])
      ).rows[0].cancelled_at
    ).not.toBeNull();
    expect(
      (
        await pool.query('SELECT cancelled_at FROM connection_pairings WHERE member_id=$1', [
          ownerId,
        ])
      ).rows[0].cancelled_at
    ).not.toBeNull();
  });

  it('can add a password to an existing OAuth-only member without changing their identity', async () => {
    await pool.query('DELETE FROM account WHERE "userId"=\'other\'');
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES('oauth-other','external-account','github','other')`
    );
    await recoverPassword(pool, 'other@example.test', 'oauth-recovery-123');
    expect(
      (await pool.query(`SELECT "accountId","providerId" FROM account WHERE id='oauth-other'`))
        .rows[0]
    ).toEqual({ accountId: 'external-account', providerId: 'github' });
    expect((await signIn('other@example.test', 'oauth-recovery-123')).status).toBe(200);
    expect(
      (await pool.query('SELECT user_id,role FROM members WHERE id=$1', [otherId])).rows[0]
    ).toEqual({ user_id: 'other', role: 'member' });
  });

  it('recovers the host account without readmitting an inactive membership', async () => {
    await pool.query('UPDATE members SET active=false WHERE id=$1', [otherId]);
    await recoverPassword(pool, 'other@example.test', 'valid-password-123');
    expect((await signIn('other@example.test', 'valid-password-123')).status).toBe(200);
    expect((await pool.query('SELECT active FROM members WHERE id=$1', [otherId])).rows[0]).toEqual(
      {
        active: false,
      }
    );
    await expect(
      recoverPassword(pool, 'unknown@example.test', 'valid-password-123')
    ).rejects.toThrow('No host account');
    expect((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count).toBe(2);
  });

  it('rolls back a password change if access revocation fails', async () => {
    await pool.query(
      `CREATE FUNCTION reject_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recovery failure'; END $$`
    );
    await pool.query(
      'CREATE TRIGGER reject_recovery BEFORE UPDATE ON connection_grants FOR EACH ROW EXECUTE FUNCTION reject_recovery()'
    );
    await expect(recoverPassword(pool, 'owner@example.test', 'must-not-stick-123')).rejects.toThrow(
      'forced recovery failure'
    );
    await pool.query('DROP TRIGGER reject_recovery ON connection_grants');
    expect((await signIn('owner@example.test', 'new-password-456')).status).toBe(200);
    expect((await signIn('owner@example.test', 'must-not-stick-123')).status).toBe(401);
  });
});
