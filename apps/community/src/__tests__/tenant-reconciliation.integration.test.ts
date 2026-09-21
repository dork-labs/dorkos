import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, afterEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { transaction } from '../data.js';
import {
  BlobStoreError,
  FileSystemBlobStore,
  reconcileTenantNamespace,
  reserveManagedBlob,
  type BlobStore,
} from '../storage/index.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for reconciliation tests');
const admin = new Pool({ connectionString: adminUrl });
let dbName: string;
let testUrl: URL;
let pool: Pool | undefined;
let directory: string;
let store: FileSystemBlobStore;

beforeEach(async () => {
  dbName = `community_reconcile_${randomUUID().replaceAll('-', '')}`;
  testUrl = new URL(adminUrl);
  testUrl.pathname = `/${dbName}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl.toString());
  pool = new Pool({ connectionString: testUrl.toString() });
  directory = await mkdtemp(join(tmpdir(), 'community-reconcile-'));
  store = new FileSystemBlobStore(directory);
});

afterEach(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await admin.end();
});

async function seedCommunity() {
  if (!pool) throw new Error('test database is unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const community = (
      await client.query("INSERT INTO communities(name) VALUES('Legacy') RETURNING id")
    ).rows[0].id as string;
    await client.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('owner-user','Owner','owner@example.test')"
    );
    const member = (
      await client.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,'owner-user','Owner','owner','owner') RETURNING id`,
        [community]
      )
    ).rows[0].id as string;
    const channel = (
      await client.query(
        "INSERT INTO channels(community_id,name,visibility) VALUES($1,'Files','private') RETURNING id",
        [community]
      )
    ).rows[0].id as string;
    await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [community]);
    await client.query('COMMIT');
    return { community, member, channel };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedAttachment() {
  if (!pool) throw new Error('test database is unavailable');
  const owner = await seedCommunity();
  const stored = await store.put({
    source: Readable.from([Buffer.from('legacy file')]),
    displayName: 'legacy.txt',
    maxBytes: 100,
  });
  const attachment = (
    await pool.query(
      `INSERT INTO attachments(
         community_id,channel_id,uploader_member_id,blob_key,display_name,content_type,
         byte_size,checksum,idempotency_key,request_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'legacy-idempotency','legacy-request') RETURNING id`,
      [
        owner.community,
        owner.channel,
        owner.member,
        stored.key,
        stored.displayName,
        stored.contentType,
        stored.byteSize,
        stored.sha256,
      ]
    )
  ).rows[0].id as string;
  const exported = await store.put({
    source: Readable.from([Buffer.from('504b030414000000', 'hex')]),
    displayName: 'legacy.zip',
    kind: 'export',
    maxBytes: 100,
  });
  const archive = await pool.query<{ id: string }>(
    `INSERT INTO export_archives(
       community_id,requester_member_id,scope,blob_key,byte_size,expires_at
     ) VALUES($1,$2,'owner',$3,$4,now()+interval '1 hour') RETURNING id`,
    [owner.community, owner.member, exported.key, exported.byteSize]
  );
  await pool.query(
    `INSERT INTO export_archive_channels(community_id,export_archive_id,channel_id,position)
     VALUES($1,$2,$3,1)`,
    [owner.community, archive.rows[0].id, owner.channel]
  );
  return { ...owner, attachment, stored, exported };
}

async function waitForBlockedQuery(fragment: string) {
  if (!pool) throw new Error('test database is unavailable');
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
  throw new Error(`Reconciliation did not block on ${fragment}`);
}

async function expectStored(key: string, byteSize: number) {
  const read = await store.get(key);
  read.body.destroy();
  expect(read.byteSize).toBe(byteSize);
}

it('adopts verified singleton references without changing their bytes or identifiers', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedAttachment();
  const result = await reconcileTenantNamespace(pool, store);

  expect(result).toMatchObject({ ready: true, counts: { communities: 1, referenced: 2 } });
  expect(JSON.stringify(result)).not.toContain(fixture.stored.key);
  expect(
    (
      await pool.query(
        `SELECT community_id,purpose,state,byte_size::int,checksum
         FROM managed_blobs WHERE blob_key=$1`,
        [fixture.stored.key]
      )
    ).rows[0]
  ).toEqual({
    community_id: fixture.community,
    purpose: 'attachment',
    state: 'committed',
    byte_size: fixture.stored.byteSize,
    checksum: fixture.stored.sha256,
  });
  expect(
    (
      await pool.query('SELECT purpose,state,checksum FROM managed_blobs WHERE blob_key=$1', [
        fixture.exported.key,
      ])
    ).rows[0]
  ).toEqual({ purpose: 'export', state: 'committed', checksum: fixture.exported.sha256 });
  expect(
    (
      await pool.query(
        'SELECT state,validated_generation=generation AS exact FROM tenant_reconciliation'
      )
    ).rows[0]
  ).toEqual({ state: 'ready', exact: true });
});

it('converts legacy pending cleanup into tenant-owned inventory without deleting it', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const { community } = await seedCommunity();
  const pending = await store.put({
    source: Readable.from([Buffer.from('pending bytes')]),
    displayName: 'pending.txt',
    maxBytes: 100,
  });
  await pool.query('INSERT INTO pending_blob_deletions(blob_key) VALUES($1)', [pending.key]);

  const result = await reconcileTenantNamespace(pool, store);

  expect(result).toMatchObject({ ready: true, counts: { cleanup: 1, unexplained: 0 } });
  await expectStored(pending.key, pending.byteSize);
  expect(
    (
      await pool.query(
        `SELECT community_id,purpose,state,
                EXISTS(SELECT 1 FROM pending_blob_deletions p WHERE p.blob_key=m.blob_key) AS queued
         FROM managed_blobs m WHERE blob_key=$1`,
        [pending.key]
      )
    ).rows[0]
  ).toEqual({
    community_id: community,
    purpose: 'legacy_cleanup',
    state: 'pending_delete',
    queued: true,
  });
});

it('leaves a valid-looking but unproven singleton object untouched for manual resolution', async () => {
  if (!pool) throw new Error('test database is unavailable');
  await seedCommunity();
  const unknown = await store.put({
    source: Readable.from([Buffer.from('unproven bytes')]),
    displayName: 'unproven.txt',
    maxBytes: 100,
  });

  const result = await reconcileTenantNamespace(pool, store);

  expect(result).toMatchObject({
    ready: false,
    counts: { communities: 1, unexplained: 1 },
    issues: [{ code: 'unexplained_objects', count: 1 }],
  });
  expect(JSON.stringify(result)).not.toContain(unknown.key);
  await expectStored(unknown.key, unknown.byteSize);
  expect((await pool.query('SELECT count(*)::int AS count FROM managed_blobs')).rows[0]).toEqual({
    count: 0,
  });
});

it('marks a clean zero-community namespace ready without inventing ownership', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const result = await reconcileTenantNamespace(pool, store);

  expect(result).toEqual({
    ready: true,
    generation: 1,
    counts: { communities: 0, referenced: 0, cleanup: 0, unexplained: 0 },
    issues: [],
  });
  expect(
    (await pool.query('SELECT state,community_id FROM tenant_reconciliation')).rows[0]
  ).toEqual({ state: 'ready', community_id: null });

  const late = await store.put({
    source: Readable.from([Buffer.from('late unknown')]),
    displayName: 'late.txt',
    maxBytes: 100,
  });
  expect(await reconcileTenantNamespace(pool, store)).toMatchObject({
    ready: false,
    issues: [{ code: 'unexplained_objects' }],
  });
  expect((await pool.query('SELECT state FROM tenant_reconciliation')).rows[0].state).toBe('dirty');
  await expectStored(late.key, late.byteSize);
});

it('keeps zero-community and unexplained namespaces blocked without deletion', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const unknown = await store.put({
    source: Readable.from([Buffer.from('unknown bytes')]),
    displayName: 'unknown.txt',
    maxBytes: 100,
  });
  await writeFile(join(directory, 'operator-note'), 'unmanaged');

  const result = await reconcileTenantNamespace(pool, store);

  expect(result.ready).toBe(false);
  expect(result.issues.map((item) => item.code)).toContain('unexplained_objects');
  expect(JSON.stringify(result)).not.toContain(unknown.key);
  await expectStored(unknown.key, unknown.byteSize);
  expect((await pool.query('SELECT state FROM tenant_reconciliation')).rows[0].state).toBe('dirty');
});

it('does not accept incomplete provider listings or a live reservation', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const { community } = await seedCommunity();
  const incomplete: BlobStore = {
    put: (input) => store.put(input),
    get: (key, options) => store.get(key, options),
    delete: (key, options) => store.delete(key, options),
    listNamespace: async () => {
      throw new BlobStoreError('BLOB_LIST_INCOMPLETE', 'page failed');
    },
  };
  expect(await reconcileTenantNamespace(pool, incomplete)).toMatchObject({
    ready: false,
    issues: [{ code: 'incomplete_listing' }],
  });

  await transaction(pool, (client) => reserveManagedBlob(client, community, 'attachment'));
  expect(await reconcileTenantNamespace(pool, store)).toMatchObject({
    ready: false,
    issues: [{ code: 'active_writes' }],
  });
});

it('serializes a new reservation after validation and immediately dirties its generation', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const { community } = await seedCommunity();
  let markListingStarted!: () => void;
  let releaseListing!: () => void;
  const listingStarted = new Promise<void>((resolve) => {
    markListingStarted = resolve;
  });
  const listingRelease = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  const heldStore: BlobStore = {
    put: (input) => store.put(input),
    get: (key, options) => store.get(key, options),
    delete: (key, options) => store.delete(key, options),
    listNamespace: async (options) => {
      markListingStarted();
      await listingRelease;
      return store.listNamespace(options);
    },
  };

  const reconciliation = reconcileTenantNamespace(pool, heldStore);
  await listingStarted;
  await expect(
    transaction(pool, async (client) => {
      await client.query("SET LOCAL lock_timeout='100ms'");
      return reserveManagedBlob(client, community, 'attachment');
    })
  ).rejects.toMatchObject({ code: '55P03' });

  releaseListing();
  await expect(reconciliation).resolves.toMatchObject({ ready: true, generation: 1 });
  await transaction(pool, (client) => reserveManagedBlob(client, community, 'attachment'));
  expect(
    (
      await pool.query(
        'SELECT state,generation,validated_generation,reason_code FROM tenant_reconciliation'
      )
    ).rows[0]
  ).toEqual({
    state: 'dirty',
    generation: '2',
    validated_generation: null,
    reason_code: 'managed_blob_write',
  });
});

it('waits behind an active inventory writer before locking the reconciliation generation', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedAttachment();
  await expect(reconcileTenantNamespace(pool, store)).resolves.toMatchObject({ ready: true });
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE managed_blobs SET checksum=checksum WHERE blob_key=$1', [
      fixture.stored.key,
    ]);
    const reconciliation = reconcileTenantNamespace(pool, store);
    await waitForBlockedQuery('INSERT INTO managed_blobs');
    await writer.query('COMMIT');
    await expect(reconciliation).resolves.toMatchObject({
      ready: false,
      issues: [{ code: 'active_writes' }],
    });
    expect(
      (
        await pool.query<{ state: string; reason_code: string }>(
          'SELECT state,reason_code FROM tenant_reconciliation'
        )
      ).rows[0]
    ).toEqual({ state: 'dirty', reason_code: 'active_writes' });
  } finally {
    await writer.query('ROLLBACK').catch(() => undefined);
    writer.release();
  }
});

it('does not reacquire managed inventory while deferred cleanup invalidation holds generation', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedAttachment();
  await expect(reconcileTenantNamespace(pool, store)).resolves.toMatchObject({ ready: true });
  const inventoryWriter = await pool.connect();
  const cleanupWriter = await pool.connect();
  try {
    await inventoryWriter.query('BEGIN');
    await inventoryWriter.query('UPDATE managed_blobs SET checksum=checksum WHERE blob_key=$1', [
      fixture.stored.key,
    ]);
    await cleanupWriter.query('BEGIN');
    await cleanupWriter.query('DELETE FROM attachments WHERE id=$1', [fixture.attachment]);
    await cleanupWriter.query('INSERT INTO pending_blob_deletions(blob_key) VALUES($1)', [
      fixture.stored.key,
    ]);

    const cleanupCommit = cleanupWriter
      .query('COMMIT')
      .then(() => ({ status: 'fulfilled' as const }))
      .catch((reason: unknown) => ({ status: 'rejected' as const, reason }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inventoryCommit = inventoryWriter
      .query('COMMIT')
      .then(() => ({ status: 'fulfilled' as const }))
      .catch((reason: unknown) => ({ status: 'rejected' as const, reason }));

    expect(await Promise.all([cleanupCommit, inventoryCommit])).toEqual([
      { status: 'fulfilled' },
      { status: 'fulfilled' },
    ]);
    expect(
      (await pool.query<{ state: string }>('SELECT state FROM tenant_reconciliation')).rows[0]
    ).toEqual({ state: 'dirty' });
  } finally {
    await inventoryWriter.query('ROLLBACK').catch(() => undefined);
    await cleanupWriter.query('ROLLBACK').catch(() => undefined);
    inventoryWriter.release();
    cleanupWriter.release();
  }
});

it('invalidates readiness through unmanaged cleanup after the tenant contract is enforced', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedAttachment();
  await expect(reconcileTenantNamespace(pool, store)).resolves.toMatchObject({ ready: true });
  const generation = Number(
    (await pool.query('SELECT generation FROM tenant_reconciliation')).rows[0].generation
  );

  await pool.query('DELETE FROM attachments WHERE id=$1', [fixture.attachment]);
  await pool.query('INSERT INTO pending_blob_deletions(blob_key) VALUES($1)', [fixture.stored.key]);
  await store.delete(fixture.stored.key);
  await pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [fixture.stored.key]);

  expect(
    (
      await pool.query(
        `SELECT state,generation,validated_generation,namespace_digest,reason_code
         FROM tenant_reconciliation`
      )
    ).rows[0]
  ).toEqual({
    state: 'dirty',
    generation: String(generation + 2),
    validated_generation: null,
    namespace_digest: null,
    reason_code: 'unmanaged_blob_cleanup',
  });
  expect(
    (await pool.query('SELECT state FROM managed_blobs WHERE blob_key=$1', [fixture.stored.key]))
      .rows[0]
  ).toEqual({ state: 'committed' });
  await expect(store.get(fixture.stored.key)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
});

it('rejects a stale listing when the readiness generation advances', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const db = pool;
  await seedAttachment();
  const racingStore: BlobStore = {
    put: (input) => store.put(input),
    get: (key, options) => store.get(key, options),
    delete: (key, options) => store.delete(key, options),
    listNamespace: async (options) => {
      const snapshot = await store.listNamespace(options);
      await db.query(
        "UPDATE tenant_reconciliation SET generation=generation+1,state='dirty',validated_generation=NULL"
      );
      return snapshot;
    },
  };

  const result = await reconcileTenantNamespace(db, racingStore);
  const gate = (await db.query('SELECT state,generation FROM tenant_reconciliation')).rows[0];

  expect(result).toMatchObject({
    ready: false,
    generation: Number(gate.generation),
    issues: [{ code: 'active_writes' }],
  });
  expect(gate.state).toBe('dirty');
});

it('rejects a legacy write that removes explicit tenant ownership', async () => {
  if (!pool) throw new Error('test database is unavailable');
  const fixture = await seedAttachment();
  await expect(reconcileTenantNamespace(pool, store)).resolves.toMatchObject({ ready: true });

  await expect(
    pool.query('UPDATE attachments SET community_id=NULL WHERE id=$1', [fixture.attachment])
  ).rejects.toMatchObject({ code: '23502' });
  expect((await pool.query('SELECT state FROM tenant_reconciliation')).rows[0].state).toBe('ready');
});
