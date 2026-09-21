import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for administration tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_administration_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const db = new Pool({ connectionString: testUrl.toString() });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl.toString());
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

async function createClaimedCommunity(name: string, userId: string): Promise<string> {
  return db.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
        userId,
        name,
        `${userId}@example.test`,
      ]);
      const community = await client.query<{ id: string }>(
        "INSERT INTO communities(name,lifecycle) VALUES($1,'pending_owner') RETURNING id",
        [name]
      );
      await client.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,$3,$4,'owner')`,
        [community.rows[0].id, userId, name, userId]
      );
      await client.query(
        `UPDATE communities SET lifecycle='active',activated_at=now(),lifecycle_version=2
         WHERE id=$1`,
        [community.rows[0].id]
      );
      await client.query('COMMIT');
      return community.rows[0].id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

it('migrates active settings and constrains every lifecycle resume combination', async () => {
  const communityId = await createClaimedCommunity('Administration', 'admin-owner');
  expect(
    (
      await db.query(
        `SELECT admission_policy,settings_version,lifecycle,lifecycle_version,
                suspended_from_state,delete_after
         FROM communities WHERE id=$1`,
        [communityId]
      )
    ).rows[0]
  ).toEqual({
    admission_policy: 'invite_only',
    settings_version: 1,
    lifecycle: 'active',
    lifecycle_version: 2,
    suspended_from_state: null,
    delete_after: null,
  });

  await expect(
    db.query("UPDATE communities SET lifecycle='suspended' WHERE id=$1", [communityId])
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    db.query("UPDATE communities SET lifecycle='suspended',suspended_at=now() WHERE id=$1", [
      communityId,
    ])
  ).rejects.toMatchObject({ code: '23514' });
  await db.query(
    `UPDATE communities SET lifecycle='suspended',suspended_from_state='active',suspended_at=now()
     WHERE id=$1`,
    [communityId]
  );
  await db.query(
    `UPDATE communities SET lifecycle='active',suspended_from_state=NULL,suspended_at=NULL
     WHERE id=$1`,
    [communityId]
  );
  await expect(
    db.query(
      `UPDATE communities SET lifecycle='deletion_pending',delete_requested_at=now(),
              delete_after=now()+interval '6 days',delete_requested_by=(
                SELECT id FROM members WHERE community_id=$1 AND role='owner'
              ) WHERE id=$1`,
      [communityId]
    )
  ).rejects.toMatchObject({ code: '23514' });
});

it('binds icon inventory and deletion progress to the exact tenant', async () => {
  const first = await createClaimedCommunity('First', 'first-owner');
  const second = await createClaimedCommunity('Second', 'second-owner');
  const key = 'a'.repeat(64);
  await db.query(
    `INSERT INTO managed_blobs(
       blob_key,community_id,purpose,community_lifecycle_version,state,byte_size,checksum,stored_at,committed_at
     ) VALUES($1,$2,'icon',2,'committed',8,$3,now(),now())`,
    [key, first, 'b'.repeat(64)]
  );
  await expect(
    db.query('UPDATE communities SET icon_blob_key=$2 WHERE id=$1', [first, key])
  ).rejects.toMatchObject({ code: '23514' });
  await db.query(
    "UPDATE communities SET icon_blob_key=$2,icon_content_type='image/png' WHERE id=$1",
    [first, key]
  );
  await expect(
    db.query("UPDATE communities SET icon_blob_key=$2,icon_content_type='image/png' WHERE id=$1", [
      second,
      key,
    ])
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    db.query(
      `INSERT INTO community_deletion_blob_progress(community_id,blob_key)
       VALUES($1,$2)`,
      [second, key]
    )
  ).rejects.toThrow('deletion blob is not owned by community');
  await db.query(
    `INSERT INTO community_deletion_blob_progress(community_id,blob_key)
     VALUES($1,$2)`,
    [first, key]
  );
});

it('uses community then member locks, avoiding the lifecycle-pairing deadlock cycle', async () => {
  const communityId = await createClaimedCommunity('Lock order', 'lock-order-owner');
  const memberId = (
    await db.query<{ id: string }>(
      "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
      [communityId]
    )
  ).rows[0]!.id;
  const administration = await db.connect();
  const pairing = await db.connect();
  try {
    await administration.query('BEGIN');
    await administration.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    const pairingCommunity = pairing
      .query('BEGIN')
      .then(() => pairing.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [communityId]));
    await administration.query('SELECT 1 FROM members WHERE id=$1 FOR SHARE', [memberId]);
    await administration.query('COMMIT');
    await pairingCommunity;
    await pairing.query('SELECT 1 FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    await pairing.query('COMMIT');

    await administration.query("SET deadlock_timeout='50ms'");
    await pairing.query("SET deadlock_timeout='50ms'");
    await administration.query('BEGIN');
    await pairing.query('BEGIN');
    await administration.query('SELECT 1 FROM members WHERE id=$1 FOR SHARE', [memberId]);
    await pairing.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [communityId]);
    const reverseOrder = Promise.allSettled([
      administration.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]),
      pairing.query('SELECT 1 FROM members WHERE id=$1 FOR UPDATE', [memberId]),
    ]);
    const outcome = await Promise.race([
      reverseOrder,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Reverse lock order did not resolve in time.')), 2_000);
      }),
    ]);
    expect(outcome.some((result) => result.status === 'rejected')).toBe(true);
    expect(
      outcome.some(
        (result) =>
          result.status === 'rejected' && (result.reason as { code?: string }).code === '40P01'
      )
    ).toBe(true);
  } finally {
    await administration.query('ROLLBACK').catch(() => undefined);
    await pairing.query('ROLLBACK').catch(() => undefined);
    administration.release();
    pairing.release();
  }
});

it('uses community then deletion job locks across worker and cancellation', async () => {
  const communityId = await createClaimedCommunity('Deletion lock order', 'deletion-lock-owner');
  const memberId = (
    await db.query<{ id: string }>(
      "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
      [communityId]
    )
  ).rows[0]!.id;
  await db.query(
    `UPDATE communities SET lifecycle='deletion_pending',delete_requested_at=now(),
       delete_after=now()+interval '7 days',delete_requested_by=$2,lifecycle_version=3
     WHERE id=$1`,
    [communityId, memberId]
  );
  await db.query(
    `INSERT INTO community_deletion_jobs(
       community_id,requested_by_member_id,lifecycle_version,delete_after,next_attempt_at
     ) SELECT id,$2,lifecycle_version,delete_after,now() FROM communities WHERE id=$1`,
    [communityId, memberId]
  );
  const worker = await db.connect();
  const cancellation = await db.connect();
  try {
    await worker.query('BEGIN');
    await worker.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    const cancelledCommunity = cancellation
      .query('BEGIN')
      .then(() =>
        cancellation.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId])
      );
    await worker.query('SELECT 1 FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE', [
      communityId,
    ]);
    await worker.query('COMMIT');
    await cancelledCommunity;
    await cancellation.query('SELECT 1 FROM members WHERE id=$1 FOR SHARE', [memberId]);
    await cancellation.query(
      'SELECT 1 FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE',
      [communityId]
    );
    await cancellation.query('COMMIT');

    await worker.query("SET deadlock_timeout='50ms'");
    await cancellation.query("SET deadlock_timeout='50ms'");
    await worker.query('BEGIN');
    await cancellation.query('BEGIN');
    await worker.query('SELECT 1 FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE', [
      communityId,
    ]);
    await cancellation.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    await cancellation.query('SELECT 1 FROM members WHERE id=$1 FOR SHARE', [memberId]);
    const reverseOrder = Promise.allSettled([
      worker.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]),
      cancellation.query('SELECT 1 FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE', [
        communityId,
      ]),
    ]);
    const outcome = await Promise.race([
      reverseOrder,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Reverse deletion lock order did not resolve in time.')),
          2_000
        );
      }),
    ]);
    expect(outcome.some((result) => result.status === 'rejected')).toBe(true);
    expect(
      outcome.some(
        (result) =>
          result.status === 'rejected' && (result.reason as { code?: string }).code === '40P01'
      )
    ).toBe(true);
  } finally {
    await worker.query('ROLLBACK').catch(() => undefined);
    await cancellation.query('ROLLBACK').catch(() => undefined);
    worker.release();
    cancellation.release();
  }
});

it('keeps completed deletion tombstones content-free by schema', async () => {
  const columns = (
    await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='community_deletion_tombstones'
       ORDER BY ordinal_position`
    )
  ).rows.map(({ column_name }) => column_name);
  expect(columns).toEqual([
    'community_id',
    'requested_at',
    'completed_at',
    'outcome',
    'retry_count',
    'expires_at',
  ]);
});
