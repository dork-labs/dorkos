import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { transaction } from '../data.js';
import { sweepExpiredAttachments } from '../routes/attachments.js';
import { sweepExpiredExports } from '../exports/sweep.js';
import { discardManagedBlob, FileSystemBlobStore } from '../storage/index.js';
import { MANAGED_BLOB_RESERVATION_TTL_MS } from '../storage/managed-blobs.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { hashSecret } from '../security.js';
import { bootstrapFirstHost, seedCredentialAccount } from './bootstrap-test-helper.js';
import { drainExports, expireReadyExports, openArchive } from './export-test-helpers.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for attachment HTTP tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_files_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let directory: string;
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let ownerCookie: string;
let bobCookie: string;
let channelId: string;
let ownerId: string;
let bobId: string;
let communityId: string;
let blobStore: FileSystemBlobStore;
let app: ReturnType<typeof createCommunityApp>;
let config: ReturnType<typeof parseConfig>;

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}
function post(path: string, body: unknown, cookie: string) {
  return request(path, {
    method: 'POST',
    headers: { cookie, origin: config.publicUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function upload(
  channel: string,
  cookie: string,
  key: string,
  body = 'hello',
  name = 'notes.txt',
  size = Buffer.byteLength(body)
) {
  return request(`/api/v1/channels/${channel}/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      origin: config.publicUrl,
      'content-type': 'text/plain',
      'idempotency-key': key,
      'x-file-name': encodeURIComponent(name),
      'x-file-size': String(size),
    },
    body,
  });
}

async function waitForBlockedQuery(fragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1
         AND cardinality(pg_blocking_pids(pid))>0) AS blocked`,
      [`%${fragment}%`]
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Request did not block on ${fragment}`);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-files-'));
  blobStore = new FileSystemBlobStore(directory);
  config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: directory,
    COMMUNITY_ATTACHMENT_BYTES: '32',
    COMMUNITY_UPLOAD_BYTES_PER_DAY: '40',
  });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  app = createCommunityApp({ config, pool, blobStore });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  baseUrl = `http://localhost:${address.port}`;
  const setup = await bootstrapFirstHost(post, {
    secret: config.bootstrapSecret,
    accountName: 'Owner',
    email: 'files-owner@example.test',
    password: 'password1234',
    communityName: 'Files',
  });
  ownerCookie = setup.cookie;
  await seedCredentialAccount(pool, {
    name: 'Bob',
    email: 'files-bob@example.test',
    password: 'password1234',
  });
  const bobSignin = await post(
    '/api/auth/sign-in/email',
    { email: 'files-bob@example.test', password: 'password1234' },
    ''
  );
  bobCookie = cookieOf(bobSignin);
  const owner = await pool.query<{ id: string; community_id: string }>(
    "SELECT id,community_id FROM members WHERE role='owner'"
  );
  ownerId = owner.rows[0].id;
  communityId = owner.rows[0].community_id;
  const bob = await pool.query<{ id: string }>(
    `INSERT INTO members(community_id,user_id,display_name,handle,role)
     SELECT $1,id,name,'bob','member' FROM "user" WHERE email='files-bob@example.test' RETURNING id`,
    [owner.rows[0].community_id]
  );
  bobId = bob.rows[0].id;
  const channel = await post('/api/v1/channels', { name: 'Files' }, ownerCookie);
  expect(channel.status).toBe(201);
  channelId = (await channel.json()).channel.id;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('attachments over real HTTP and Postgres', () => {
  it('locks the channel before reconciliation state so cursor writes cannot deadlock uploads', async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      const blockedUpload = upload(channelId, ownerCookie, 'cursor-lock-order');
      await waitForBlockedQuery('SELECT c.* FROM channels');
      await blocker.query(
        `INSERT INTO read_cursors(community_id,channel_id,member_id,seq)
         VALUES($1,$2,$3,1)
         ON CONFLICT(channel_id,member_id) DO UPDATE SET seq=EXCLUDED.seq,updated_at=now()`,
        [communityId, channelId, ownerId]
      );
      await blocker.query('COMMIT');
      expect((await blockedUpload).status).toBe(201);
      await pool.query('UPDATE owner_quota_windows SET upload_bytes=0 WHERE owner_member_id=$1', [
        ownerId,
      ]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('serializes an expiring reservation cleanup against its in-flight completion', async () => {
    let storedReady!: () => void;
    let releaseStored!: () => void;
    const ready = new Promise<void>((resolve) => {
      storedReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStored = resolve;
    });
    const originalPut = blobStore.put.bind(blobStore);
    const heldPut = vi.spyOn(blobStore, 'put').mockImplementation(async (input) => {
      const stored = await originalPut(input);
      storedReady();
      await released;
      return stored;
    });
    const channelBlocker = await pool.connect();
    const cleanup = await pool.connect();
    let reservationKey: string | undefined;
    try {
      const pendingUpload = upload(channelId, ownerCookie, 'lease-boundary', 'lease');
      await ready;
      const reservation = (
        await pool.query<{ blob_key: string }>(
          `SELECT blob_key FROM managed_blobs
           WHERE state='reserved' AND purpose='attachment'
           ORDER BY created_at DESC LIMIT 1`
        )
      ).rows[0];
      expect(reservation).toBeDefined();
      reservationKey = reservation.blob_key;
      await pool.query(
        `UPDATE managed_blobs
         SET created_at=clock_timestamp()-($2 * interval '1 millisecond')+interval '500 milliseconds'
         WHERE blob_key=$1`,
        [reservation.blob_key, MANAGED_BLOB_RESERVATION_TTL_MS]
      );

      await channelBlocker.query('BEGIN');
      await channelBlocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      releaseStored();
      await waitForBlockedQuery('SELECT c.* FROM channels');
      await new Promise((resolve) => setTimeout(resolve, 650));

      await cleanup.query('BEGIN');
      await cleanup.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1 FOR UPDATE', [
        reservation.blob_key,
      ]);
      await channelBlocker.query('COMMIT');
      await waitForBlockedQuery('UPDATE managed_blobs');
      await cleanup.query(
        "UPDATE managed_blobs SET state='pending_delete' WHERE blob_key=$1 AND state IN ('reserved','stored')",
        [reservation.blob_key]
      );
      await cleanup.query(
        `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
         VALUES($1,0,now()+interval '1 minute') ON CONFLICT(blob_key) DO NOTHING`,
        [reservation.blob_key]
      );
      await cleanup.query('COMMIT');

      expect((await pendingUpload).status).toBe(409);
      expect(
        (
          await pool.query<{ state: string }>('SELECT state FROM managed_blobs WHERE blob_key=$1', [
            reservation.blob_key,
          ])
        ).rows[0]
      ).toEqual({ state: 'pending_delete' });
    } finally {
      releaseStored();
      await channelBlocker.query('ROLLBACK').catch(() => undefined);
      await cleanup.query('ROLLBACK').catch(() => undefined);
      channelBlocker.release();
      cleanup.release();
      heldPut.mockRestore();
      if (reservationKey) {
        await blobStore.delete(reservationKey).catch(() => undefined);
        await transaction(pool, async (client) => {
          await client.query("SELECT set_config('dorkos.tenant_reconciliation','backfill',true)");
          await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
            reservationKey,
          ]);
          await client.query('DELETE FROM managed_blobs WHERE blob_key=$1', [reservationKey]);
        });
      }
    }
  });

  it('streams a verified upload, retries by bytes, binds once, and returns metadata in history', async () => {
    const first = await upload(channelId, ownerCookie, 'files-one');
    expect(first.status).toBe(201);
    const metadata = (await first.json()).attachment;
    expect(metadata.name).toBe('notes.txt');
    expect(metadata.contentType).toBe('text/plain; charset=utf-8');
    expect(
      (
        await pool.query(
          `SELECT m.state,m.community_id,m.purpose
           FROM managed_blobs m JOIN attachments a ON a.blob_key=m.blob_key WHERE a.id=$1`,
          [metadata.id]
        )
      ).rows[0]
    ).toEqual({ state: 'committed', community_id: communityId, purpose: 'attachment' });
    const committedKey = (
      await pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
        metadata.id,
      ])
    ).rows[0].blob_key;
    await pool.query(
      `INSERT INTO pending_blob_deletions(blob_key,next_attempt_at)
       VALUES($1,now()-interval '1 second')`,
      [committedKey]
    );
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM pending_blob_deletions WHERE blob_key=$1',
          [committedKey]
        )
      ).rows[0].count
    ).toBe(0);
    const committedBlob = await blobStore.get(committedKey);
    expect(committedBlob.byteSize).toBe(5);
    committedBlob.body.destroy();
    const originalDelete = blobStore.delete.bind(blobStore);
    const failDelete = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('disposable deletion interruption'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await upload(channelId, ownerCookie, 'files-one')).status).toBe(200);
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM pending_blob_deletions')).rows[0]
          .count
      ).toBe(1);
      expect(
        (
          await pool.query<{ attempts: number; delayed: boolean }>(
            'SELECT attempts,next_attempt_at>now() AS delayed FROM pending_blob_deletions'
          )
        ).rows[0]
      ).toEqual({ attempts: 1, delayed: true });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM managed_blobs WHERE state='pending_delete'"
          )
        ).rows[0].count
      ).toBe(1);
    } finally {
      failDelete.mockRestore();
      errorLog.mockRestore();
    }
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    await pool.query("UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second'");
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_blobs WHERE state='pending_delete'"
        )
      ).rows[0].count
    ).toBe(0);
    expect((await upload(channelId, ownerCookie, 'files-one', 'world')).status).toBe(409);
    const posted = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'attached', idempotencyKey: 'entry-file', attachmentIds: [metadata.id] },
      ownerCookie
    );
    expect(posted.status).toBe(201);
    expect((await posted.json()).entry.attachments).toEqual([metadata]);
    const page = await request(`/api/v1/channels/${channelId}/entries`, {
      headers: { cookie: ownerCookie },
    });
    expect((await page.json()).entries[0].attachments).toEqual([metadata]);
    const events = await app.request(`/api/v1/channels/${channelId}/events`, {
      headers: { cookie: ownerCookie },
    });
    const eventReader = events.body!.getReader();
    const snapshot = new TextDecoder().decode((await eventReader.read()).value);
    expect(snapshot).toContain(`"id":"${metadata.id}"`);
    await eventReader.cancel();
    expect(
      (
        await post(
          `/api/v1/channels/${channelId}/entries`,
          { text: 'another', idempotencyKey: 'entry-two', attachmentIds: [metadata.id] },
          ownerCookie
        )
      ).status
    ).toBe(409);
    const download = await request(`/api/v1/attachments/${metadata.id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello');
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(
      (await request(`/api/v1/attachments/${metadata.id}`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(403);
  });

  it('reclaims a stored upload when the community lifecycle changes before metadata commit', async () => {
    const originalPut = blobStore.put.bind(blobStore);
    const originalDelete = blobStore.delete.bind(blobStore);
    const put = vi.spyOn(blobStore, 'put').mockImplementationOnce(async (input) => {
      expect(
        (
          await pool.query('SELECT state,community_id FROM managed_blobs WHERE blob_key=$1', [
            input.key,
          ])
        ).rows[0]
      ).toEqual({ state: 'reserved', community_id: communityId });
      const stored = await originalPut(input);
      await pool.query(
        "UPDATE communities SET lifecycle='suspended',lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [communityId]
      );
      return stored;
    });
    const remove = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('cleanup interrupted after storage'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await upload(channelId, ownerCookie, 'lifecycle-race');
      expect(response.status).toBe(503);
      expect(
        (
          await pool.query(
            "SELECT state,community_id FROM managed_blobs WHERE state='pending_delete'"
          )
        ).rows[0]
      ).toEqual({ state: 'pending_delete', community_id: communityId });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM attachments WHERE idempotency_key='lifecycle-race'"
          )
        ).rows[0].count
      ).toBe(0);
      expect(
        (
          await pool.query<{
            outcome_uncertain: boolean;
            attempts: number;
            byte_size: string | null;
          }>(
            `SELECT p.last_error_at IS NULL AS outcome_uncertain,p.attempts,m.byte_size
             FROM pending_blob_deletions p JOIN managed_blobs m USING(blob_key)
             WHERE m.state='pending_delete'`
          )
        ).rows[0]
      ).toEqual({ outcome_uncertain: true, attempts: 1, byte_size: null });
    } finally {
      put.mockRestore();
      remove.mockRestore();
      errorLog.mockRestore();
      await pool.query(
        "UPDATE communities SET lifecycle='active',lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [communityId]
      );
    }
    await pool.query("UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second'");
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    await expect(
      blobStore.get(
        (
          await pool.query<{ blob_key: string }>(
            "SELECT blob_key FROM managed_blobs WHERE state='pending_delete'"
          )
        ).rows[0].blob_key
      )
    ).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_blobs WHERE state<>'committed'"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it('keeps active reservations and repeatedly reconciles an uncertain expired writer', async () => {
    const key = 'd'.repeat(64);
    const lifecycle = (
      await pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [communityId]
      )
    ).rows[0].lifecycle_version;
    await pool.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version)
       VALUES($1,$2,'attachment',$3)`,
      [key, communityId, lifecycle]
    );
    const stored = await blobStore.put({
      key,
      source: Readable.from([Buffer.from('reserved bytes')]),
      displayName: 'reserved.txt',
      maxBytes: 1024,
    });

    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    expect(
      (await pool.query('SELECT state FROM managed_blobs WHERE blob_key=$1', [key])).rows[0]
    ).toEqual({ state: 'reserved' });
    const active = await blobStore.get(key);
    active.body.destroy();

    await pool.query(
      `CREATE FUNCTION reject_pending_blob_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'test queue failure'; END $$`
    );
    await pool.query(
      `CREATE TRIGGER reject_pending_blob_test_insert
       BEFORE INSERT ON pending_blob_deletions
       FOR EACH ROW EXECUTE FUNCTION reject_pending_blob_test_insert()`
    );
    await expect(
      discardManagedBlob(
        pool,
        blobStore,
        { key, communityId, purpose: 'attachment', lifecycleVersion: lifecycle },
        stored
      )
    ).rejects.toThrow('test queue failure');
    expect(
      (await pool.query('SELECT state FROM managed_blobs WHERE blob_key=$1', [key])).rows[0]
    ).toEqual({ state: 'reserved' });
    await pool.query('DROP TRIGGER reject_pending_blob_test_insert ON pending_blob_deletions');
    await pool.query('DROP FUNCTION reject_pending_blob_test_insert()');

    await pool.query(
      "UPDATE managed_blobs SET created_at=now()-interval '2 hours' WHERE blob_key=$1",
      [key]
    );
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    expect(
      (
        await pool.query<{ state: string; delayed: boolean }>(
          `SELECT m.state,p.next_attempt_at>now() AS delayed
           FROM managed_blobs m JOIN pending_blob_deletions p USING(blob_key)
           WHERE m.blob_key=$1`,
          [key]
        )
      ).rows[0]
    ).toEqual({ state: 'pending_delete', delayed: true });
    const quarantined = await blobStore.get(key);
    quarantined.body.destroy();

    await pool.query(
      "UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second' WHERE blob_key=$1",
      [key]
    );
    const originalDelete = blobStore.delete.bind(blobStore);
    const failDelete = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('uncertain cleanup interruption'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 1 });
      expect(
        (
          await pool.query<{ attempts: number; outcome_uncertain: boolean; delayed: boolean }>(
            `SELECT attempts,last_error_at IS NULL AS outcome_uncertain,
                    next_attempt_at>now() AS delayed
             FROM pending_blob_deletions WHERE blob_key=$1`,
            [key]
          )
        ).rows[0]
      ).toEqual({ attempts: 1, outcome_uncertain: true, delayed: true });
    } finally {
      failDelete.mockRestore();
      errorLog.mockRestore();
    }
    await pool.query(
      "UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second' WHERE blob_key=$1",
      [key]
    );
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    await expect(blobStore.get(key)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    expect(
      (
        await pool.query<{ state: string; delayed: boolean }>(
          `SELECT m.state,p.next_attempt_at>now() AS delayed
           FROM managed_blobs m JOIN pending_blob_deletions p USING(blob_key)
           WHERE m.blob_key=$1`,
          [key]
        )
      ).rows[0]
    ).toEqual({ state: 'pending_delete', delayed: true });

    await blobStore.put({
      key,
      source: Readable.from([Buffer.from('late reserved bytes')]),
      displayName: 'late-reserved.txt',
      maxBytes: 1024,
    });
    await pool.query(
      "UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second' WHERE blob_key=$1",
      [key]
    );
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    await expect(blobStore.get(key)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    expect(
      (await pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1', [key])).rowCount
    ).toBe(1);
    await pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [key]);
    await pool.query('DELETE FROM managed_blobs WHERE blob_key=$1', [key]);
  });

  it.each(['successful', 'failed'] as const)(
    'keeps a rejected writer tombstone after the immediate %s delete and removes its late publish',
    async (firstDelete) => {
      const originalPut = blobStore.put.bind(blobStore);
      const originalDelete = blobStore.delete.bind(blobStore);
      let key: string | undefined;
      const put = vi
        .spyOn(blobStore, 'put')
        .mockImplementationOnce(async (input) => {
          key = input.key;
          throw new Error('provider rejected before late publish');
        })
        .mockImplementation(originalPut);
      const remove =
        firstDelete === 'failed'
          ? vi
              .spyOn(blobStore, 'delete')
              .mockRejectedValueOnce(new Error('immediate cleanup failed'))
              .mockImplementation(originalDelete)
          : null;
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect((await upload(channelId, ownerCookie, `rejected-late-${firstDelete}`)).status).toBe(
          503
        );
      } finally {
        put.mockRestore();
        remove?.mockRestore();
        errorLog.mockRestore();
      }
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(
        (
          await pool.query<{
            state: string;
            outcome_uncertain: boolean;
            attempts: number;
          }>(
            `SELECT m.state,p.last_error_at IS NULL AS outcome_uncertain,p.attempts
             FROM managed_blobs m JOIN pending_blob_deletions p USING(blob_key)
             WHERE m.blob_key=$1`,
            [key!]
          )
        ).rows[0]
      ).toEqual({
        state: 'pending_delete',
        outcome_uncertain: true,
        attempts: 1,
      });

      await blobStore.put({
        key: key!,
        source: Readable.from([Buffer.from('late rejected-writer bytes')]),
        displayName: 'late-rejected.txt',
        maxBytes: 1024,
      });
      await pool.query(
        "UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second' WHERE blob_key=$1",
        [key!]
      );
      expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
      await expect(blobStore.get(key!)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
      expect(
        (
          await pool.query<{ state: string; outcome_uncertain: boolean }>(
            `SELECT m.state,p.last_error_at IS NULL AS outcome_uncertain
             FROM managed_blobs m JOIN pending_blob_deletions p USING(blob_key)
             WHERE m.blob_key=$1`,
            [key!]
          )
        ).rows[0]
      ).toEqual({ state: 'pending_delete', outcome_uncertain: true });
      await pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [key!]);
      await pool.query('DELETE FROM managed_blobs WHERE blob_key=$1', [key!]);
    }
  );

  it('refuses a late reference commit after the reservation lease expires', async () => {
    const originalPut = blobStore.put.bind(blobStore);
    const put = vi.spyOn(blobStore, 'put').mockImplementationOnce(async (input) => {
      const stored = await originalPut(input);
      await pool.query(
        "UPDATE managed_blobs SET created_at=now()-interval '2 hours' WHERE blob_key=$1",
        [input.key]
      );
      return stored;
    });
    try {
      expect((await upload(channelId, ownerCookie, 'expired-reservation')).status).toBe(409);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM attachments WHERE idempotency_key='expired-reservation'"
          )
        ).rows[0].count
      ).toBe(0);
    } finally {
      put.mockRestore();
    }
    await pool.query("UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second'");
    await sweepPendingBlobDeletions(pool, blobStore);
  });

  it('discovers pending cleanup inventory even when its queue write was interrupted', async () => {
    const key = 'e'.repeat(64);
    const lifecycle = (
      await pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [communityId]
      )
    ).rows[0].lifecycle_version;
    await pool.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state)
       VALUES($1,$2,'attachment',$3,'pending_delete')`,
      [key, communityId, lifecycle]
    );

    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
    expect(
      (await pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1', [key])).rowCount
    ).toBe(1);
    expect(
      (
        await pool.query<{ delayed: boolean }>(
          'SELECT next_attempt_at>now() AS delayed FROM pending_blob_deletions WHERE blob_key=$1',
          [key]
        )
      ).rows[0]
    ).toEqual({ delayed: true });
    await pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [key]);
    await pool.query('DELETE FROM managed_blobs WHERE blob_key=$1', [key]);
  });

  it('lets due blob cleanup work pass an older backed-off row', async () => {
    const delayedKey = 'a'.repeat(64);
    const dueKey = 'b'.repeat(64);
    const failingKey = 'c'.repeat(64);
    await pool.query(
      `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at,created_at)
       VALUES($1,7,now()+interval '1 hour',now()-interval '1 day'),
             ($2,0,now()-interval '1 second',now()),
             ($3,6,now()-interval '1 second',now())`,
      [delayedKey, dueKey, failingKey]
    );
    const remove = vi.spyOn(blobStore, 'delete').mockResolvedValue();
    try {
      expect(await sweepPendingBlobDeletions(pool, blobStore, 1)).toEqual({
        deleted: 1,
        failed: 0,
      });
      expect(remove).toHaveBeenCalledExactlyOnceWith(dueKey);
      expect(
        (await pool.query('SELECT 1 FROM pending_blob_deletions WHERE blob_key=$1', [delayedKey]))
          .rowCount
      ).toBe(1);
    } finally {
      remove.mockRestore();
    }
    const fail = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValue(new Error('persistent deletion interruption'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await sweepPendingBlobDeletions(pool, blobStore, 1)).toEqual({
        deleted: 0,
        failed: 1,
      });
      expect(
        (
          await pool.query<{ attempts: number; backoff_seconds: number }>(
            'SELECT attempts,EXTRACT(EPOCH FROM next_attempt_at-last_error_at)::int AS backoff_seconds FROM pending_blob_deletions WHERE blob_key=$1',
            [failingKey]
          )
        ).rows[0]
      ).toEqual({ attempts: 7, backoff_seconds: 3600 });
    } finally {
      fail.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('rejects wrong byte claims and forbidden types without keeping rows', async () => {
    expect(
      (await upload(channelId, ownerCookie, 'wrong-size', 'hello', 'notes.txt', 4)).status
    ).toBe(400);
    const script = await upload(
      channelId,
      ownerCookie,
      'script',
      '<script>alert(1)</script>',
      'evil.txt'
    );
    expect(script.status).toBe(415);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM attachments WHERE idempotency_key IN ('wrong-size','script')"
        )
      ).rows[0].count
    ).toBe(0);
  });

  it('charges unbound bytes once and sweeps only expired orphans', async () => {
    const uploadResult = await upload(channelId, ownerCookie, 'orphan');
    expect(uploadResult.status).toBe(201);
    const orphan = (await uploadResult.json()).attachment;
    await pool.query("UPDATE attachments SET uploaded_at=now()-interval '2 hours' WHERE id=$1", [
      orphan.id,
    ]);
    expect(
      (
        await post(
          `/api/v1/channels/${channelId}/entries`,
          { text: 'too late', idempotencyKey: 'expired-file', attachmentIds: [orphan.id] },
          ownerCookie
        )
      ).status
    ).toBe(409);
    const result = await sweepExpiredAttachments(pool, blobStore);
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect((await pool.query('SELECT 1 FROM attachments WHERE id=$1', [orphan.id])).rowCount).toBe(
      0
    );
    expect(
      (
        await pool.query(
          'SELECT upload_bytes::int AS bytes FROM owner_quota_windows WHERE owner_member_id=$1',
          [ownerId]
        )
      ).rows[0].bytes
    ).toBeGreaterThanOrEqual(10);
  });

  it('refuses another uploader or channel and allows only one parallel bind', async () => {
    await pool.query(
      'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3)',
      [communityId, channelId, bobId]
    );
    const uploaded = await upload(channelId, ownerCookie, 'bind-race', 'bind');
    expect(uploaded.status).toBe(201);
    const id = (await uploaded.json()).attachment.id;
    expect(
      (
        await post(
          `/api/v1/channels/${channelId}/entries`,
          { text: 'steal', idempotencyKey: 'steal', attachmentIds: [id] },
          bobCookie
        )
      ).status
    ).toBe(409);
    const another = await post('/api/v1/channels', { name: 'Elsewhere' }, ownerCookie);
    const otherId = (await another.json()).channel.id;
    expect(
      (
        await post(
          `/api/v1/channels/${otherId}/entries`,
          { text: 'wrong channel', idempotencyKey: 'wrong-channel', attachmentIds: [id] },
          ownerCookie
        )
      ).status
    ).toBe(409);
    const results = await Promise.all([
      post(
        `/api/v1/channels/${channelId}/entries`,
        { text: 'race one', idempotencyKey: 'race-one', attachmentIds: [id] },
        ownerCookie
      ),
      post(
        `/api/v1/channels/${channelId}/entries`,
        { text: 'race two', idempotencyKey: 'race-two', attachmentIds: [id] },
        ownerCookie
      ),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      (await pool.query('SELECT entry_id FROM attachments WHERE id=$1', [id])).rows[0].entry_id
    ).toBeTruthy();
  });

  it('enforces a shared owner quota for agent and human concurrent uploads', async () => {
    const community = await pool.query<{ community_id: string }>(
      'SELECT community_id FROM members WHERE id=$1',
      [ownerId]
    );
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle) VALUES($1,$2,'Helper','helper') RETURNING id`,
      [community.rows[0].community_id, ownerId]
    );
    const agentId = agent.rows[0].id;
    const token = 'agent-files-token';
    await pool.query(
      'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
      [communityId, agentId, hashSecret(token)]
    );
    await pool.query(
      'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
      [communityId, channelId, agentId]
    );
    const agentUpload = await request(`/api/v1/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: config.publicUrl,
        'content-type': 'text/plain',
        'idempotency-key': 'agent-file',
        'x-file-name': 'agent.txt',
        'x-file-size': '5',
      },
      body: 'agent',
    });
    expect(agentUpload.status).toBe(201);
    const agentFileId = (await agentUpload.json()).attachment.id;
    expect(
      (
        await pool.query(
          'SELECT uploader_agent_id,uploader_member_id FROM attachments WHERE id=$1',
          [agentFileId]
        )
      ).rows[0]
    ).toMatchObject({ uploader_agent_id: agentId, uploader_member_id: null });
    const [one, two] = await Promise.all([
      upload(channelId, ownerCookie, 'quota-human', 'a'.repeat(20)),
      upload(channelId, ownerCookie, 'quota-human-2', 'b'.repeat(20)),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 429]);
    expect((await upload(channelId, ownerCookie, 'too-big', 'c'.repeat(33))).status).toBe(413);
    const charged = await pool.query<{ upload_bytes: string }>(
      'SELECT upload_bytes FROM owner_quota_windows WHERE owner_member_id=$1',
      [ownerId]
    );
    expect(Number(charged.rows[0].upload_bytes)).toBeLessThanOrEqual(40);
    await pool.query('UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1', [agentId]);
    const revoked = await request(`/api/v1/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: config.publicUrl,
        'content-type': 'text/plain',
        'idempotency-key': 'agent-revoked',
        'x-file-name': 'agent.txt',
        'x-file-size': '5',
      },
      body: 'agent',
    });
    expect(revoked.status).toBe(401);
    await pool.query("UPDATE attachments SET uploaded_at=now()-interval '2 hours' WHERE id=$1", [
      agentFileId,
    ]);
    const originalDelete = blobStore.delete.bind(blobStore);
    const failOnce = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('disposable object store interruption'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await sweepExpiredAttachments(pool, blobStore)).toEqual({ deleted: 0, failed: 1 });
      expect(
        (await pool.query('SELECT 1 FROM attachments WHERE id=$1', [agentFileId])).rowCount
      ).toBe(1);
      expect(
        (
          await pool.query<{ attempts: number; delayed: boolean }>(
            'SELECT cleanup_attempts AS attempts,cleanup_next_attempt_at>now() AS delayed FROM attachments WHERE id=$1',
            [agentFileId]
          )
        ).rows[0]
      ).toEqual({ attempts: 1, delayed: true });
      expect(await sweepExpiredAttachments(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
      await pool.query(
        "UPDATE attachments SET cleanup_next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [agentFileId]
      );
      expect(await sweepExpiredAttachments(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
      expect(
        (await pool.query('SELECT 1 FROM attachments WHERE id=$1', [agentFileId])).rowCount
      ).toBe(0);
      expect(
        (await pool.query("SELECT 1 FROM attachments WHERE idempotency_key='files-one'")).rowCount
      ).toBe(1);
    } finally {
      failOnce.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('checks export authority before dirtying reconciliation state', async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM members WHERE id=$1 FOR UPDATE', [ownerId]);
      const blockedExport = post('/api/v1/me/export', {}, ownerCookie);
      await waitForBlockedQuery('SELECT role FROM members WHERE id=');
      const quotaWrite = await blocker.query(
        'UPDATE owner_quota_windows SET upload_bytes=upload_bytes WHERE owner_member_id=$1',
        [ownerId]
      );
      expect(quotaWrite.rowCount).toBeGreaterThan(0);
      await blocker.query('COMMIT');
      expect((await blockedExport).status).toBe(202);
      await drainExports(pool, blobStore);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('stops an in-flight download when channel membership is revoked', async () => {
    const file = (
      await pool.query<{ id: string; blob_key: string }>(
        "SELECT id,blob_key FROM attachments WHERE idempotency_key='files-one'"
      )
    ).rows[0];
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const originalGet = blobStore.get.bind(blobStore);
    const spy = vi.spyOn(blobStore, 'get').mockImplementation(async (key, options) => {
      if (key !== file.blob_key) return originalGet(key, options);
      return {
        byteSize: 5,
        body: Readable.from(
          (async function* () {
            yield Buffer.from('he');
            await second;
            yield Buffer.from('llo');
          })()
        ),
      };
    });
    try {
      const response = await app.request(`/api/v1/attachments/${file.id}`, {
        headers: { cookie: bobCookie },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('he');
      await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        channelId,
        bobId,
      ]);
      releaseSecond();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      releaseSecond();
      spy.mockRestore();
      await pool.query(
        'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [communityId, channelId, bobId]
      );
    }
  });

  // Access that ends after the last byte went out must not error the response: the client has
  // already read it in full, and an errored stream resets the kept-alive connection under the
  // client's next request (DOR-2250). The held end of the stream makes the ordering exact.
  async function readAllThenEndAfterRevocation(
    blobKey: string,
    path: string,
    cookie: string,
    revoke: () => Promise<unknown>
  ) {
    let releaseEnd!: () => void;
    const end = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const originalGet = blobStore.get.bind(blobStore);
    const spy = vi.spyOn(blobStore, 'get').mockImplementation(async (key, options) => {
      const read = await originalGet(key, options);
      if (key !== blobKey) return read;
      const chunks: Buffer[] = [];
      for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
      return {
        byteSize: read.byteSize,
        body: Readable.from(
          (async function* () {
            yield Buffer.concat(chunks);
            await end;
          })()
        ),
      };
    });
    try {
      const response = await app.request(path, { headers: { cookie } });
      expect(response.status).toBe(200);
      const size = Number(response.headers.get('content-length'));
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.value?.byteLength).toBe(size);
      await revoke();
      releaseEnd();
      return await reader.read();
    } finally {
      releaseEnd();
      spy.mockRestore();
    }
  }

  it('ends a fully sent file download cleanly when access ends after the last byte', async () => {
    const file = (
      await pool.query<{ id: string; blob_key: string }>(
        "SELECT id,blob_key FROM attachments WHERE idempotency_key='files-one'"
      )
    ).rows[0];
    try {
      const last = await readAllThenEndAfterRevocation(
        file.blob_key,
        `/api/v1/attachments/${file.id}`,
        bobCookie,
        () =>
          pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
            channelId,
            bobId,
          ])
      );
      expect(last).toEqual({ done: true, value: undefined });
    } finally {
      await pool.query(
        'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [communityId, channelId, bobId]
      );
    }
  });

  it('keeps the connection usable when access ends after a download was read in full', async () => {
    const file = (
      await pool.query<{ id: string; blob_key: string }>(
        "SELECT id,blob_key FROM attachments WHERE idempotency_key='files-one'"
      )
    ).rows[0];
    let releaseEnd!: () => void;
    const end = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const originalGet = blobStore.get.bind(blobStore);
    // A slow end of stream, as a loaded disk gives: every byte is out, the stream is not done.
    const spy = vi.spyOn(blobStore, 'get').mockImplementation(async (key, options) => {
      const read = await originalGet(key, options);
      if (key !== file.blob_key) return read;
      const chunks: Buffer[] = [];
      for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
      return {
        byteSize: read.byteSize,
        body: Readable.from(
          (async function* () {
            yield Buffer.concat(chunks);
            await end;
          })()
        ),
      };
    });
    try {
      const downloaded = await request(`/api/v1/attachments/${file.id}`, {
        headers: { cookie: bobCookie },
      });
      expect(await downloaded.text()).toBe('hello');
      await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        channelId,
        bobId,
      ]);
      // The client saw a complete response, so its next request reuses the same connection.
      const next = request('/health');
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseEnd();
      expect((await next).status).toBe(200);
    } finally {
      releaseEnd();
      spy.mockRestore();
      await pool.query(
        'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [communityId, channelId, bobId]
      );
    }
  });

  /** Create a personal archive that includes `channelId`, then run `use` on it. */
  async function withPersonalArchive(
    use: (archive: { id: string; firstKey: string; lastKey: string }) => Promise<void>
  ) {
    await expireReadyExports(pool, ownerId);
    const created = await post('/api/v1/me/export', {}, ownerCookie);
    expect(created.status).toBe(202);
    const id = (await created.json()).export.id;
    await drainExports(pool, blobStore);
    const channels = (
      await pool.query<{ channel_id: string }>(
        'SELECT channel_id FROM export_archive_channels WHERE export_archive_id=$1',
        [id]
      )
    ).rows.map((row) => row.channel_id);
    expect(channels).toContain(channelId);
    const keys = (
      await pool.query<{ blob_key: string }>(
        'SELECT blob_key FROM export_segments WHERE export_id=$1 ORDER BY segment_no',
        [id]
      )
    ).rows.map((row) => row.blob_key);
    // The owner reaches the channel directly and through the agent it owns; both have to go.
    const ownedAgents = (
      await pool.query<{ agent_id: string }>(
        `SELECT acm.agent_id FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
         WHERE acm.channel_id=$1 AND a.owner_member_id=$2`,
        [channelId, ownerId]
      )
    ).rows.map((row) => row.agent_id);
    try {
      await use({ id, firstKey: keys[0], lastKey: keys[keys.length - 1] });
    } finally {
      await pool.query(
        'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [communityId, channelId, ownerId]
      );
      for (const agentId of ownedAgents)
        await pool.query(
          'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [communityId, channelId, agentId]
        );
    }
  }
  async function revokeOwnerChannelAccess() {
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      channelId,
      ownerId,
    ]);
    await pool.query(
      `DELETE FROM agent_channel_members acm USING agents a
       WHERE a.id=acm.agent_id AND acm.channel_id=$1 AND a.owner_member_id=$2`,
      [channelId, ownerId]
    );
  }

  it('ends a fully sent archive download cleanly when access ends after the last byte', async () => {
    await withPersonalArchive(async (archive) => {
      let releaseEnd!: () => void;
      const end = new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
      const originalGet = blobStore.get.bind(blobStore);
      // The archive's last piece sends its bytes, then holds the stream open.
      const spy = vi.spyOn(blobStore, 'get').mockImplementation(async (key, options) => {
        const read = await originalGet(key, options);
        if (key !== archive.lastKey) return read;
        const chunks: Buffer[] = [];
        for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
        return {
          byteSize: read.byteSize,
          body: Readable.from(
            (async function* () {
              yield Buffer.concat(chunks);
              await end;
            })()
          ),
        };
      });
      try {
        const response = await app.request(`/api/v1/exports/${archive.id}/archive`, {
          headers: { cookie: ownerCookie },
        });
        expect(response.status).toBe(200);
        const size = Number(response.headers.get('content-length'));
        const reader = response.body!.getReader();
        let received = 0;
        while (received < size) received += (await reader.read()).value!.byteLength;
        expect(received).toBe(size);
        await revokeOwnerChannelAccess();
        releaseEnd();
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      } finally {
        releaseEnd();
        spy.mockRestore();
      }
    });
  });

  it('stops an in-flight archive download when channel access ends', async () => {
    await withPersonalArchive(async (archive) => {
      let releaseRest!: () => void;
      const rest = new Promise<void>((resolve) => {
        releaseRest = resolve;
      });
      const originalGet = blobStore.get.bind(blobStore);
      const spy = vi.spyOn(blobStore, 'get').mockImplementation(async (key, options) => {
        const read = await originalGet(key, options);
        if (key !== archive.firstKey) return read;
        const chunks: Buffer[] = [];
        for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        return {
          byteSize: read.byteSize,
          body: Readable.from(
            (async function* () {
              yield bytes.subarray(0, 1);
              await rest;
              yield bytes.subarray(1);
            })()
          ),
        };
      });
      const realNow = Date.now.bind(Date);
      const clock = vi.spyOn(Date, 'now');
      try {
        const response = await app.request(`/api/v1/exports/${archive.id}/archive`, {
          headers: { cookie: ownerCookie },
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect((await reader.read()).value?.byteLength).toBe(1);
        await revokeOwnerChannelAccess();
        // Access is re-checked every 16 MiB or 10 seconds; this archive is small, so let time pass.
        clock.mockImplementation(() => realNow() + 11_000);
        releaseRest();
        await expect(reader.read()).rejects.toThrow('Export access has ended.');
      } finally {
        releaseRest();
        clock.mockRestore();
        spy.mockRestore();
      }
    });
  });
});

describe('private archives and recoverable leave', () => {
  /** Start a fresh personal export (an earlier ready one is expired first), build it, and return its id. */
  async function personalExport(cookie: string, memberId: string): Promise<string> {
    await expireReadyExports(pool, memberId);
    const created = await post('/api/v1/me/export', {}, cookie);
    expect(created.status).toBe(202);
    const id = (await created.json()).export.id as string;
    await drainExports(pool, blobStore);
    return id;
  }
  async function downloadExport(id: string, cookie: string): Promise<Buffer> {
    const response = await request(`/api/v1/exports/${id}/archive`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  }

  it('includes owned-agent posts and files in an agent-only channel until its last access ends', async () => {
    const created = await post('/api/v1/channels', { name: 'Agent archive room' }, ownerCookie);
    expect(created.status).toBe(201);
    const id = (await created.json()).channel.id;
    const community = await pool.query<{ community_id: string }>(
      'SELECT community_id FROM members WHERE id=$1',
      [ownerId]
    );
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle)
       VALUES($1,$2,'Archive Helper','archive-helper') RETURNING id`,
      [community.rows[0].community_id, ownerId]
    );
    const agentId = agent.rows[0].id;
    const token = 'agent-archive-token';
    await pool.query(
      'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
      [communityId, agentId, hashSecret(token)]
    );
    await pool.query(
      'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
      [communityId, id, agentId]
    );
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      id,
      ownerId,
    ]);
    await pool.query('UPDATE owner_quota_windows SET upload_bytes=0 WHERE owner_member_id=$1', [
      ownerId,
    ]);
    const uploaded = await request(`/api/v1/channels/${id}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: config.publicUrl,
        'content-type': 'text/plain',
        'idempotency-key': 'archive-agent-file',
        'x-file-name': 'agent-note.txt',
        'x-file-size': '6',
      },
      body: 'secret',
    });
    expect(uploaded.status).toBe(201);
    const fileId = (await uploaded.json()).attachment.id;
    const entry = await request(`/api/v1/channels/${id}/entries`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: config.publicUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Owned agent memory',
        idempotencyKey: 'archive-agent-entry',
        attachmentIds: [fileId],
      }),
    });
    expect(entry.status).toBe(201);
    const exported = await personalExport(ownerCookie, ownerId);
    const archive = await openArchive(await downloadExport(exported, ownerCookie));
    expect(archive.rows<{ id: string }>('channels').some((channel) => channel.id === id)).toBe(
      true
    );
    expect(
      archive.rows<{ text: string }>('entries').some((item) => item.text === 'Owned agent memory')
    ).toBe(true);
    const file = archive
      .rows<{ id: string; archivePath: string }>('attachments')
      .find((item) => item.id === fileId);
    expect(file?.archivePath).toBe(`files/${fileId}/agent-note.txt`);
    expect(archive.files.get(file!.archivePath)?.toString()).toBe('secret');
    await pool.query('DELETE FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2', [
      id,
      agentId,
    ]);
    expect(
      (
        await request(`/api/v1/exports/${exported}/archive`, {
          headers: { cookie: ownerCookie },
        })
      ).status
    ).toBe(403);
    const after = await personalExport(ownerCookie, ownerId);
    const afterArchive = await openArchive(await downloadExport(after, ownerCookie));
    expect(afterArchive.rows<{ text: string }>('entries').map((item) => item.text)).not.toContain(
      'Owned agent memory'
    );
  });

  it('exports only the requester’s posts and owned file bytes, with owner reauthentication for full archive', async () => {
    await pool.query(
      'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [communityId, channelId, bobId]
    );
    const bobPost = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'Bob private sentence', idempotencyKey: 'bob-sentence' },
      bobCookie
    );
    expect(bobPost.status).toBe(201);
    const personalId = await personalExport(ownerCookie, ownerId);
    const personalKeys = (
      await pool.query<{ blob_key: string }>(
        'SELECT blob_key FROM export_segments WHERE export_id=$1',
        [personalId]
      )
    ).rows.map((row) => row.blob_key);
    expect(
      (
        await pool.query(
          'SELECT DISTINCT state,community_id,purpose FROM managed_blobs WHERE blob_key=ANY($1::text[])',
          [personalKeys]
        )
      ).rows
    ).toEqual([{ state: 'committed', community_id: communityId, purpose: 'export' }]);
    const archive = await openArchive(await downloadExport(personalId, ownerCookie));
    expect(archive.manifest.version).toBe(2);
    expect(archive.manifest.scope).toBe('personal');
    expect(archive.rows<{ id: string }>('members').map((member) => member.id)).toEqual([ownerId]);
    const texts = archive.rows<{ text: string }>('entries').map((entry) => entry.text);
    expect(texts).not.toContain('Bob private sentence');
    expect(texts).toContain('attached');
    const attachments = archive.rows<{ name: string; byteSize: number; archivePath: string }>(
      'attachments'
    );
    expect(attachments).toHaveLength(2);
    const note = attachments.find((item) => item.name === 'notes.txt' && item.byteSize === 5)!;
    expect(archive.files.get(note.archivePath)?.toString()).toBe('hello');
    const everything = [...archive.files.values()].map((bytes) => bytes.toString()).join('');
    expect(everything).not.toContain('blob_key');
    expect(everything).not.toContain('files-bob@example.test');
    expect(everything).not.toContain('token_hash');

    const unauthorized = await post('/api/v1/owner/export', { password: 'wrong' }, ownerCookie);
    expect(unauthorized.status).toBe(403);
    const full = await post('/api/v1/owner/export', { password: 'password1234' }, ownerCookie);
    expect(full.status).toBe(202);
    const fullId = (await full.json()).export.id;
    await drainExports(pool, blobStore);
    expect(
      (await request(`/api/v1/exports/${fullId}/archive`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(404);
    const fullArchive = await openArchive(await downloadExport(fullId, ownerCookie));
    expect(fullArchive.manifest.scope).toBe('owner');
    expect(fullArchive.rows('members')).toHaveLength(2);
    expect(fullArchive.rows<{ text: string }>('entries').map((entry) => entry.text)).toContain(
      'Bob private sentence'
    );
    const fullText = [...fullArchive.files.values()].map((bytes) => bytes.toString()).join('');
    expect(fullText).not.toContain('token_hash');
    expect(fullText).not.toContain('request_hash');
    expect(fullArchive.files.get(note.archivePath)?.toString()).toBe('hello');

    const bobArchiveId = await personalExport(bobCookie, bobId);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      channelId,
      bobId,
    ]);
    expect(
      (await request(`/api/v1/exports/${bobArchiveId}/archive`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(403);
    await pool.query(
      'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3)',
      [communityId, channelId, bobId]
    );
    await pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE id=$1",
      [personalId]
    );
    await sweepExpiredExports(pool, blobStore);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_blobs WHERE blob_key=ANY($1::text[]) AND state<>'pending_delete'",
          [personalKeys]
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await request(`/api/v1/exports/${personalId}/archive`, {
          headers: { cookie: ownerCookie },
        })
      ).status
    ).toBe(404);
  });

  it('retries the deletion of an expired version 1 archive until it succeeds', async () => {
    // A version 1 archive (one blob, written before background exports) as old code left it.
    const stored = await blobStore.put({
      source: (async function* () {
        yield Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
      })(),
      displayName: 'community-export.zip',
      maxBytes: 1024,
      kind: 'export',
    });
    await pool.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,
         byte_size,checksum,stored_at,committed_at)
       SELECT $1,$2,'export',lifecycle_version,'committed',$3,$4,now(),now() FROM communities WHERE id=$2`,
      [stored.key, communityId, stored.byteSize, stored.sha256]
    );
    const retryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO export_archives(community_id,requester_member_id,scope,blob_key,byte_size,expires_at)
         VALUES($1,$2,'personal',$3,$4,now()-interval '1 second') RETURNING id`,
        [communityId, ownerId, stored.key, stored.byteSize]
      )
    ).rows[0].id;
    const originalDelete = blobStore.delete.bind(blobStore);
    const failOnce = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('disposable archive deletion interruption'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deletedAt = async () =>
      (await pool.query('SELECT deleted_at FROM export_archives WHERE id=$1', [retryId])).rows[0]
        .deleted_at;
    try {
      expect(await sweepExpiredExports(pool, blobStore)).toEqual({ deleted: 0, failed: 1 });
      expect(
        (
          await pool.query<{ attempts: number; delayed: boolean }>(
            'SELECT cleanup_attempts AS attempts,cleanup_next_attempt_at>now() AS delayed FROM export_archives WHERE id=$1',
            [retryId]
          )
        ).rows[0]
      ).toEqual({ attempts: 1, delayed: true });
      await sweepExpiredExports(pool, blobStore);
      expect(await deletedAt()).toBeNull();
      await pool.query(
        "UPDATE export_archives SET cleanup_next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [retryId]
      );
      expect(await sweepExpiredExports(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
      expect(await deletedAt()).not.toBeNull();
      expect(
        (await pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1', [stored.key])).rowCount
      ).toBe(0);
    } finally {
      failOnce.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('requires ownership transfer before leave, then revokes the former member’s session', async () => {
    expect(
      (
        await post(
          '/api/v1/me/leave',
          { password: 'password1234', communityName: 'Files' },
          ownerCookie
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          '/api/v1/me/leave',
          { password: 'password1234', communityName: 'Files' },
          bobCookie
        )
      ).status
    ).toBe(204);
    expect((await post('/api/v1/me/export', {}, bobCookie)).status).toBe(403);
    expect(
      (await request(`/api/v1/channels/${channelId}/entries`, { headers: { cookie: ownerCookie } }))
        .status
    ).toBe(200);
    const attributed = await pool.query('SELECT 1 FROM entries WHERE author_member_id=$1', [bobId]);
    expect(attributed.rowCount).toBe(1);
  });

  it('accepts the exact configured file cap and rejects the next byte', async () => {
    await pool.query('UPDATE owner_quota_windows SET upload_bytes=0 WHERE owner_member_id=$1', [
      ownerId,
    ]);
    expect((await upload(channelId, ownerCookie, 'exact-file-cap', 'z'.repeat(32))).status).toBe(
      201
    );
    expect((await upload(channelId, ownerCookie, 'over-file-cap', 'z'.repeat(33))).status).toBe(
      413
    );
  });

  it('commits cookie and agent uploads with a one-client database pool', async () => {
    await pool.query('UPDATE owner_quota_windows SET upload_bytes=0 WHERE owner_member_id=$1', [
      ownerId,
    ]);
    const onePool = new Pool({ connectionString: dbUrl.toString(), max: 1 });
    const oneApp = createCommunityApp({ config, pool: onePool, blobStore });
    try {
      const ownerUpload = await oneApp.request(`/api/v1/channels/${channelId}/attachments`, {
        method: 'POST',
        headers: {
          cookie: ownerCookie,
          origin: config.publicUrl,
          'content-type': 'text/plain',
          'idempotency-key': 'one-pool-human',
          'x-file-name': 'human.txt',
          'x-file-size': '5',
        },
        body: 'human',
      });
      expect(ownerUpload.status).toBe(201);
      const agent = await pool.query<{ id: string }>("SELECT id FROM agents WHERE handle='helper'");
      const token = 'agent-one-pool-token';
      await pool.query(
        'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
        [communityId, agent.rows[0].id, hashSecret(token)]
      );
      const agentUpload = await oneApp.request(`/api/v1/channels/${channelId}/attachments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          origin: config.publicUrl,
          'content-type': 'text/plain',
          'idempotency-key': 'one-pool-agent',
          'x-file-name': 'agent.txt',
          'x-file-size': '5',
        },
        body: 'agent',
      });
      expect(agentUpload.status).toBe(201);
    } finally {
      await onePool.end();
    }
  });
});
