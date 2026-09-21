import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { inspectBackout } from '../backout.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for backout tests');
const admin = new Pool({ connectionString: adminUrl });
let database: string;
let pool: Pool;

beforeEach(async () => {
  database = `community_backout_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  await migrate(url.toString());
  pool = new Pool({ connectionString: url.toString() });
});

afterEach(async () => {
  if (pool) {
    let remaining = pool.totalCount;
    const disconnected =
      remaining === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            pool.on('remove', () => {
              if (--remaining === 0) resolve();
            });
          });
    await Promise.all([pool.end(), disconnected]);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
});
afterAll(async () => {
  await admin.end();
});

async function createCommunity(name: string): Promise<string> {
  return (await pool.query('INSERT INTO communities(name) VALUES($1) RETURNING id', [name])).rows[0]
    .id;
}

it('accepts one community without modifying its data, and refuses an empty host', async () => {
  expect(await inspectBackout(pool)).toEqual({ eligible: false, reason: 'community-count' });
  const id = await createCommunity('First');
  const before = (await pool.query('SELECT * FROM community_backout_fence')).rows;
  expect(await inspectBackout(pool)).toEqual({ eligible: true, reason: 'single-community' });
  expect((await pool.query('SELECT * FROM community_backout_fence')).rows).toEqual(before);
  expect((await pool.query('SELECT id FROM communities')).rows).toEqual([{ id }]);
});

it('never reopens backout after a second community is removed', async () => {
  await createCommunity('First');
  const second = await createCommunity('Second');
  expect((await inspectBackout(pool)).eligible).toBe(false);
  await pool.query('DELETE FROM communities WHERE id=$1', [second]);
  expect(await inspectBackout(pool)).toEqual({
    eligible: false,
    reason: 'multiple-communities-used',
  });
});

it('serializes simultaneous first communities without losing recovery history', async () => {
  await Promise.all([createCommunity('First'), createCommunity('Second')]);
  expect(await inspectBackout(pool)).toEqual({
    eligible: false,
    reason: 'multiple-communities-used',
  });
});

it('rolls back recovery history with a failed community creation', async () => {
  await createCommunity('First');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO communities(name) VALUES('Rolled back')");
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect(await inspectBackout(pool)).toEqual({ eligible: true, reason: 'single-community' });
});

it('refuses a second identity even after the original community was deleted', async () => {
  const first = await createCommunity('First');
  await pool.query('DELETE FROM communities WHERE id=$1', [first]);
  await createCommunity('Replacement');
  expect(await inspectBackout(pool)).toEqual({
    eligible: false,
    reason: 'multiple-communities-used',
  });
});

it('rejects attempts to reset, delete, or truncate the irreversible history', async () => {
  await createCommunity('First');
  await createCommunity('Second');
  await expect(
    pool.query('UPDATE community_backout_fence SET multiple_communities_used=false')
  ).rejects.toThrow('cannot be reset');
  await expect(
    pool.query('UPDATE community_backout_fence SET first_community_id=NULL')
  ).rejects.toThrow('cannot be reset');
  await expect(pool.query('DELETE FROM community_backout_fence')).rejects.toThrow(
    'cannot be removed'
  );
  await expect(pool.query('TRUNCATE community_backout_fence')).rejects.toThrow('cannot be removed');
  expect(await inspectBackout(pool)).toEqual({
    eligible: false,
    reason: 'multiple-communities-used',
  });
});
