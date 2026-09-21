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
import { sweepExpiredExports } from '../routes/exports.js';
import { discardManagedBlob, FileSystemBlobStore } from '../storage/index.js';
import { MANAGED_BLOB_RESERVATION_TTL_MS } from '../storage/managed-blobs.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { hashSecret } from '../security.js';

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
  const preflight = await post(
    '/api/v1/bootstrap/preflight',
    { secret: config.bootstrapSecret },
    ''
  );
  expect(preflight.status).toBe(200);
  const grant = cookieOf(preflight);
  const ownerSignup = await post(
    '/api/auth/sign-up/email',
    { name: 'Owner', email: 'files-owner@example.test', password: 'password1234' },
    grant
  );
  ownerCookie = `${grant}; ${cookieOf(ownerSignup)}`;
  const bobSignup = await post(
    '/api/auth/sign-up/email',
    { name: 'Bob', email: 'files-bob@example.test', password: 'password1234' },
    grant
  );
  bobCookie = `${grant}; ${cookieOf(bobSignup)}`;
  expect(
    (
      await post(
        '/api/v1/bootstrap/claim',
        { secret: config.bootstrapSecret, name: 'Files' },
        ownerCookie
      )
    ).status
  ).toBe(200);
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
      expect(response.status).toBe(409);
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
    expect(await sweepPendingBlobDeletions(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_blobs WHERE state<>'committed'"
        )
      ).rows[0].count
    ).toBe(0);
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
      expect((await blockedExport).status).toBe(201);
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
});

describe('private archives and recoverable leave', () => {
  it('includes owned-agent posts and files in an agent-only channel until its last access ends', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
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
    const archive = await post('/api/v1/me/export', {}, ownerCookie);
    expect(archive.status).toBe(201);
    const archiveId = (await archive.json()).archiveId;
    const downloaded = await request(`/api/v1/exports/${archiveId}`, {
      headers: { cookie: ownerCookie },
    });
    expect(downloaded.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    expect(manifest.channels.some((channel: { id: string }) => channel.id === id)).toBe(true);
    expect(
      manifest.entries.some((item: { text: string }) => item.text === 'Owned agent memory')
    ).toBe(true);
    expect(manifest.attachments.some((item: { id: string }) => item.id === fileId)).toBe(true);
    expect(strFromU8(zip[`attachments/${fileId}`])).toBe('secret');
    await pool.query('DELETE FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2', [
      id,
      agentId,
    ]);
    expect(
      (await request(`/api/v1/exports/${archiveId}`, { headers: { cookie: ownerCookie } })).status
    ).toBe(403);
    const after = await post('/api/v1/me/export', {}, ownerCookie);
    expect(after.status).toBe(201);
    const afterZip = unzipSync(
      new Uint8Array(
        await (
          await request(`/api/v1/exports/${(await after.json()).archiveId}`, {
            headers: { cookie: ownerCookie },
          })
        ).arrayBuffer()
      )
    );
    expect(strFromU8(afterZip['manifest.json'])).not.toContain('Owned agent memory');
  });

  it('exports only the requester’s posts and owned file bytes, with owner reauthentication for full archive', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
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
    const personal = await post('/api/v1/me/export', {}, ownerCookie);
    expect(personal.status).toBe(201);
    const personalId = (await personal.json()).archiveId;
    expect(
      (
        await pool.query(
          `SELECT m.state,m.community_id,m.purpose FROM managed_blobs m
           JOIN export_archives e ON e.blob_key=m.blob_key WHERE e.id=$1`,
          [personalId]
        )
      ).rows[0]
    ).toEqual({ state: 'committed', community_id: communityId, purpose: 'export' });
    const download = await request(`/api/v1/exports/${personalId}`, {
      headers: { cookie: ownerCookie },
    });
    expect(download.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    expect(manifest.version).toBe(1);
    expect(manifest.scope).toBe('personal');
    expect(manifest.members).toHaveLength(1);
    expect(manifest.members[0].id).toBe(ownerId);
    expect(
      manifest.entries.some((entry: { text: string }) => entry.text === 'Bob private sentence')
    ).toBe(false);
    expect(manifest.entries.some((entry: { text: string }) => entry.text === 'attached')).toBe(
      true
    );
    expect(manifest.attachments).toHaveLength(2);
    const note = manifest.attachments.find(
      (item: { name: string; byteSize: number }) => item.name === 'notes.txt' && item.byteSize === 5
    );
    expect(strFromU8(zip[`attachments/${note.id}`])).toBe('hello');
    expect(JSON.stringify(manifest)).not.toContain('blob_key');
    expect(JSON.stringify(manifest)).not.toContain('files-bob@example.test');
    expect(JSON.stringify(manifest)).not.toContain('token_hash');

    const unauthorized = await post('/api/v1/owner/export', { password: 'wrong' }, ownerCookie);
    expect(unauthorized.status).toBe(403);
    const full = await post('/api/v1/owner/export', { password: 'password1234' }, ownerCookie);
    expect(full.status).toBe(201);
    const fullId = (await full.json()).archiveId;
    expect(
      (await request(`/api/v1/exports/${fullId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(404);
    const fullDownload = await request(`/api/v1/exports/${fullId}`, {
      headers: { cookie: ownerCookie },
    });
    const fullZip = unzipSync(new Uint8Array(await fullDownload.arrayBuffer()));
    const fullManifest = JSON.parse(strFromU8(fullZip['manifest.json']));
    expect(fullManifest.scope).toBe('owner');
    expect(fullManifest.members).toHaveLength(2);
    expect(
      fullManifest.entries.some((entry: { text: string }) => entry.text === 'Bob private sentence')
    ).toBe(true);
    expect(JSON.stringify(fullManifest)).not.toContain('token_hash');
    expect(JSON.stringify(fullManifest)).not.toContain('request_hash');
    expect(strFromU8(fullZip[`attachments/${note.id}`])).toBe('hello');

    const bobArchive = await post('/api/v1/me/export', {}, bobCookie);
    expect(bobArchive.status).toBe(201);
    const bobArchiveId = (await bobArchive.json()).archiveId;
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      channelId,
      bobId,
    ]);
    expect(
      (await request(`/api/v1/exports/${bobArchiveId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(403);
    await pool.query(
      'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3)',
      [communityId, channelId, bobId]
    );
    await pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE id=$1",
      [personalId]
    );
    expect(await sweepExpiredExports(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM managed_blobs m
           JOIN export_archives e ON e.blob_key=m.blob_key WHERE e.id=$1`,
          [personalId]
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (await request(`/api/v1/exports/${personalId}`, { headers: { cookie: ownerCookie } })).status
    ).toBe(404);

    const retry = await post('/api/v1/me/export', {}, ownerCookie);
    expect(retry.status).toBe(201);
    const retryId = (await retry.json()).archiveId;
    await pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE id=$1",
      [retryId]
    );
    const originalDelete = blobStore.delete.bind(blobStore);
    const failOnce = vi
      .spyOn(blobStore, 'delete')
      .mockRejectedValueOnce(new Error('disposable archive deletion interruption'))
      .mockImplementation(originalDelete);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
      expect(await sweepExpiredExports(pool, blobStore)).toEqual({ deleted: 0, failed: 0 });
      await pool.query(
        "UPDATE export_archives SET cleanup_next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [retryId]
      );
      expect(await sweepExpiredExports(pool, blobStore)).toEqual({ deleted: 1, failed: 0 });
    } finally {
      failOnce.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('requires ownership transfer before leave, then revokes the former member’s session', async () => {
    expect((await post('/api/v1/me/leave', {}, ownerCookie)).status).toBe(403);
    expect((await post('/api/v1/me/leave', {}, bobCookie)).status).toBe(204);
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
