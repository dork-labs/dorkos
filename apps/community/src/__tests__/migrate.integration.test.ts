import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { inspectBackout } from '../backout.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { FileSystemBlobStore } from '../storage/index.js';
import { hashSecret } from '../security.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_foundation_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

/** Build the schema a version-four host shipped with, recorded as already migrated. */
async function applyVersionFourSchema(db: Pool): Promise<void> {
  await db.query(
    'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  for (const [version, filename] of [
    [1, '0001_foundation.sql'],
    [2, '0002_admission.sql'],
    [3, '0003_files.sql'],
    [4, '0004_cleanup_backoff.sql'],
  ] as const) {
    await db.query(
      await readFile(
        fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
        'utf8'
      )
    );
    await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
  }
}

it('creates all owner, conversation, credential and auth tables in fresh Postgres', async () => {
  await migrate(testUrl.toString());
  const db = new Pool({ connectionString: testUrl.toString() });
  try {
    const result = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const names = result.rows.map((row) => row.tablename);
    for (const name of [
      'communities',
      'user',
      'session',
      'members',
      'bootstrap_grants',
      'channels',
      'channel_members',
      'entries',
      'read_cursors',
      'agents',
      'agent_credentials',
      'invites',
      'invite_uses',
      'pending_admissions',
      'connection_pairings',
      'connection_grants',
      'attachments',
      'pending_blob_deletions',
      'export_archives',
      'owner_quota_windows',
      'audit_events',
      'host_operators',
      'managed_blobs',
      'tenant_reconciliation',
      'community_backout_fence',
      'entry_mentions',
      'export_archive_channels',
      'community_creation_receipts',
      'host_audit_events',
      'community_deletion_jobs',
      'community_deletion_blob_progress',
      'community_deletion_tombstones',
    ]) {
      expect(names).toContain(name);
    }
    await migrate(testUrl.toString());
  } finally {
    await db.end();
  }
});

it('upgrades a populated foundation database without changing human authors', async () => {
  const upgradeName = `community_upgrade_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    const foundation = await readFile(
      fileURLToPath(new URL('../../migrations/0001_foundation.sql', import.meta.url)),
      'utf8'
    );
    await db.query(foundation);
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    await db.query('INSERT INTO community_migrations(version) VALUES(1)');
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Upgrade') RETURNING id")
    ).rows[0].id;
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('upgrade-user','Upgrade','upgrade@example.test')"
    );
    const member = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'upgrade-user','Upgrade','upgrade','owner') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const channel = (
      await db.query(
        "INSERT INTO channels(community_id,name,visibility,last_seq) VALUES($1,'General','public',1) RETURNING id",
        [community]
      )
    ).rows[0].id;
    const entry = (
      await db.query(
        "INSERT INTO entries(channel_id,seq,author_member_id,author_display_name,text,idempotency_key,payload_hash) VALUES($1,1,$2,'Upgrade','old','key','hash') RETURNING id",
        [channel, member]
      )
    ).rows[0].id;
    await migrate(upgradeUrl.toString());
    expect(await inspectBackout(db)).toEqual({ eligible: true, reason: 'single-community' });
    const row = (
      await db.query(
        'SELECT author_member_id,author_agent_id,community_id FROM entries WHERE id=$1',
        [entry]
      )
    ).rows[0];
    expect(row).toEqual({
      author_member_id: member,
      author_agent_id: null,
      community_id: community,
    });
    expect(
      (
        await db.query('SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1', [
          community,
        ])
      ).rows[0]
    ).toEqual({ lifecycle: 'active', lifecycle_version: 1 });
    expect(
      (
        await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='managed_blobs'
           ORDER BY ordinal_position`
        )
      ).rows.map((item) => item.column_name)
    ).toEqual([
      'blob_key',
      'community_id',
      'purpose',
      'community_lifecycle_version',
      'state',
      'byte_size',
      'checksum',
      'created_at',
      'stored_at',
      'committed_at',
    ]);
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows.map(
        (item) => item.version
      )
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await migrate(upgradeUrl.toString());
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});

it('backfills legacy suspended communities before adding administration constraints', async () => {
  const upgradeName = `community_suspended_upgrade_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    for (const [version, filename] of [
      [1, '0001_foundation.sql'],
      [2, '0002_admission.sql'],
      [3, '0003_files.sql'],
      [4, '0004_cleanup_backoff.sql'],
      [5, '0005_tenant_expand.sql'],
      [6, '0006_tenant_backfill.sql'],
      [7, '0007_tenant_relations.sql'],
      [8, '0008_tenant_contract.sql'],
      [9, '0009_backout_fence.sql'],
    ] as const) {
      await db.query(
        await readFile(
          fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
          'utf8'
        )
      );
      await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
    }
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Legacy suspended') RETURNING id")
    ).rows[0].id;
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('legacy-suspended','Legacy','legacy-suspended@example.test')"
    );
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,'legacy-suspended','Legacy','legacy-suspended','owner')`,
        [community]
      );
      await client.query("UPDATE communities SET lifecycle='suspended' WHERE id=$1", [community]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await migrate(upgradeUrl.toString());

    expect(
      (
        await db.query(
          `SELECT lifecycle,activated_at IS NOT NULL AS activated,
                  suspended_from_state,suspended_at IS NOT NULL AS suspended
           FROM communities WHERE id=$1`,
          [community]
        )
      ).rows[0]
    ).toEqual({
      lifecycle: 'suspended',
      activated: true,
      suspended_from_state: 'active',
      suspended: true,
    });
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});

it('expands a populated version-four database without changing files or cleanup work', async () => {
  const upgradeName = `community_v4_upgrade_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    await applyVersionFourSchema(db);
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Version Four') RETURNING id")
    ).rows[0].id;
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('v4-user','Version Four','v4@example.test')"
    );
    const member = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'v4-user','Version Four','v4','owner') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const channel = (
      await db.query(
        "INSERT INTO channels(community_id,name,visibility) VALUES($1,'Files','private') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const attachment = (
      await db.query(
        `INSERT INTO attachments(channel_id,uploader_member_id,blob_key,display_name,content_type,byte_size,checksum,idempotency_key,request_hash)
         VALUES($1,$2,$3,'proof.txt','text/plain; charset=utf-8',5,'attachment-checksum','attachment-key','attachment-request') RETURNING id`,
        [channel, member, 'a'.repeat(64)]
      )
    ).rows[0].id;
    const archive = (
      await db.query(
        `INSERT INTO export_archives(requester_member_id,scope,channel_ids,blob_key,byte_size,expires_at)
         VALUES($1,'owner',ARRAY[$2::uuid],$3,8,now()+interval '1 hour') RETURNING id`,
        [member, channel, 'b'.repeat(64)]
      )
    ).rows[0].id;
    await db.query('INSERT INTO pending_blob_deletions(blob_key) VALUES($1)', ['c'.repeat(64)]);

    await migrate(upgradeUrl.toString());

    expect(
      (
        await db.query(
          `SELECT
             (SELECT count(*)::int FROM attachments WHERE id=$1) AS attachments,
             (SELECT count(*)::int FROM export_archives WHERE id=$2) AS exports,
             (SELECT count(*)::int FROM pending_blob_deletions WHERE blob_key=$3) AS pending,
             (SELECT count(*)::int FROM managed_blobs) AS inventory`,
          [attachment, archive, 'c'.repeat(64)]
        )
      ).rows[0]
    ).toEqual({ attachments: 1, exports: 1, pending: 1, inventory: 0 });
    expect(
      (
        await db.query(
          `SELECT a.community_id AS attachment_community,e.community_id AS export_community
           FROM attachments a CROSS JOIN export_archives e WHERE a.id=$1 AND e.id=$2`,
          [attachment, archive]
        )
      ).rows[0]
    ).toEqual({ attachment_community: community, export_community: community });
    expect(
      (
        await db.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname='public' AND tablename='members'
             AND indexname IN ('members_user_id_key','members_community_user_unique')
           ORDER BY indexname`
        )
      ).rows.map((item) => item.indexname)
    ).toEqual(['members_community_user_unique']);
    await db.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state)
       VALUES($1,$2,'attachment',1,'pending_delete')`,
      ['d'.repeat(64), community]
    );
    await db.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,byte_size,checksum,stored_at,committed_at)
       VALUES($1,$2,'export',1,'committed',8,'archive-checksum',now(),now())`,
      ['e'.repeat(64), community]
    );
    await db.query("UPDATE managed_blobs SET state='pending_delete' WHERE blob_key=$1", [
      'e'.repeat(64),
    ]);
    expect(
      (
        await db.query(
          'SELECT state,committed_at IS NOT NULL AS kept FROM managed_blobs WHERE blob_key=$1',
          ['e'.repeat(64)]
        )
      ).rows[0]
    ).toEqual({ state: 'pending_delete', kept: true });
    await expect(
      db.query(
        `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,checksum,stored_at)
         VALUES($1,$2,'attachment',1,'stored','incomplete',now())`,
        ['f'.repeat(64), community]
      )
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows.map(
        (item) => item.version
      )
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      (
        await db.query(
          `SELECT state,community_id,generation,reason_code
           FROM tenant_reconciliation WHERE singleton`
        )
      ).rows[0]
    ).toEqual({
      state: 'dirty',
      community_id: community,
      generation: '4',
      reason_code: 'managed_blob_write',
    });
    expect(
      (await db.query('SELECT user_id FROM host_operators WHERE user_id=$1', ['v4-user'])).rows
    ).toEqual([{ user_id: 'v4-user' }]);
    expect(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_trigger
           WHERE tgname IN (
             'invite_uses_legacy_tenant_write','pending_admissions_legacy_tenant_write',
             'connection_pairings_legacy_tenant_write','connection_grants_legacy_tenant_write',
             'channel_members_legacy_tenant_write','agent_credentials_legacy_tenant_write',
             'agent_channel_members_legacy_tenant_write','entries_legacy_tenant_write',
             'attachments_legacy_tenant_write','export_archives_legacy_tenant_write',
             'read_cursors_legacy_tenant_write','owner_quota_windows_legacy_tenant_write',
             'pending_blob_deletions_unmanaged_write','managed_blobs_reconciliation_write'
           ) AND tgdeferrable AND tginitdeferred`
        )
      ).rows[0]
    ).toEqual({ count: 2 });
    await db.query(
      `UPDATE tenant_reconciliation
       SET state='ready',validated_generation=generation,namespace_digest=$1,
           completed_at=now(),reason_code='validated'
       WHERE singleton`,
      ['0'.repeat(64)]
    );
    await db.query("UPDATE attachments SET display_name='proof-renamed.txt' WHERE id=$1", [
      attachment,
    ]);
    expect(
      (
        await db.query(
          'SELECT state,generation,validated_generation,reason_code FROM tenant_reconciliation WHERE singleton'
        )
      ).rows[0]
    ).toEqual({
      state: 'ready',
      generation: '4',
      validated_generation: '4',
      reason_code: 'validated',
    });
    await migrate(upgradeUrl.toString());
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});

/**
 * Rows a version-four host holds that people would notice losing: every column that existed
 * before the upgrade, in a fixed order, so a lost, reordered, rewritten or dropped row shows
 * up as a diff rather than as a count that happens to still match.
 */
const versionFourSnapshot = {
  members: 'SELECT id,user_id,display_name,handle,role FROM members ORDER BY id',
  channels: 'SELECT id,name,visibility,last_seq FROM channels ORDER BY id',
  entries: `SELECT id,channel_id,seq,author_member_id,author_agent_id,author_display_name,text,
              parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash,created_at
            FROM entries ORDER BY channel_id,seq`,
  attachments: `SELECT id,channel_id,uploader_member_id,entry_id,blob_key,display_name,content_type,
                  byte_size,checksum
                FROM attachments ORDER BY id`,
  agents:
    'SELECT id,owner_member_id,display_name,handle,local_agent_id,active FROM agents ORDER BY id',
  agentCredentials: 'SELECT id,agent_id,token_hash,revoked_at FROM agent_credentials ORDER BY id',
  connectionGrants:
    'SELECT id,member_id,token_hash,scopes,revoked_at FROM connection_grants ORDER BY id',
} as const;

async function snapshotVersionFourRows(db: Pool) {
  const snapshot: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(versionFourSnapshot)) {
    snapshot[name] = (await db.query(sql)).rows;
  }
  return snapshot;
}

/** The payload hash the current post route computes, so a pre-upgrade key can be replayed. */
function entryPayloadHash(text: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ text, mentions: [], parentEntryId: null, attachmentIds: [] }))
    .digest('hex');
}

it('serves a populated version-four community through the current HTTP contract after upgrade', async () => {
  const upgradeName = `community_v4_acceptance_${randomUUID().replaceAll('-', '')}`;
  const upgradeUrl = new URL(adminUrl);
  upgradeUrl.pathname = `/${upgradeName}`;
  const blobs = await mkdtemp(join(tmpdir(), 'community-v4-upgrade-blobs-'));
  await admin.query(`CREATE DATABASE ${upgradeName}`);
  const db = new Pool({ connectionString: upgradeUrl.toString() });
  try {
    await applyVersionFourSchema(db);
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('V4 acceptance') RETURNING id")
    ).rows[0].id;
    await db.query(
      `INSERT INTO "user"(id,name,email) VALUES
         ('v4-owner','V4 Owner','v4-owner@example.test'),
         ('v4-reader','V4 Reader','v4-reader@example.test')`
    );
    const owner = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'v4-owner','V4 Owner','v4-owner','owner') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const reader = (
      await db.query(
        "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,'v4-reader','V4 Reader','v4-reader','member') RETURNING id",
        [community]
      )
    ).rows[0].id;
    const channel = (
      await db.query(
        "INSERT INTO channels(community_id,name,visibility,last_seq) VALUES($1,'private-upgrade','private',4) RETURNING id",
        [community]
      )
    ).rows[0].id;
    await db.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2),($1,$3)', [
      channel,
      owner,
      reader,
    ]);
    const agent = (
      await db.query(
        "INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id) VALUES($1,$2,'V4 Agent','v4-agent','local-v4-agent') RETURNING id",
        [community, owner]
      )
    ).rows[0].id;
    await db.query('INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)', [
      community,
      'v4-agent',
      agent,
    ]);
    await db.query('INSERT INTO agent_channel_members(channel_id,agent_id) VALUES($1,$2)', [
      channel,
      agent,
    ]);

    // Rows go in out of sequence order, so history served by insertion time, id, or
    // anything but seq comes back in the wrong order.
    const insertEntry = async (
      seq: number,
      author: { member?: string; agent?: string },
      text: string,
      idempotencyKey: string,
      parent: string | null = null
    ): Promise<string> =>
      (
        await db.query(
          `INSERT INTO entries(channel_id,seq,author_member_id,author_agent_id,author_display_name,text,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
           VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id`,
          [
            channel,
            seq,
            author.member ?? null,
            author.agent ?? null,
            author.agent ? 'V4 Agent' : 'V4 Owner',
            text,
            parent,
            idempotencyKey,
            entryPayloadHash(text),
          ]
        )
      ).rows[0].id;
    const last = await insertEntry(4, { member: reader }, 'last preserved', 'v4-last');
    const first = await insertEntry(1, { member: owner }, 'first preserved', 'v4-first');
    const reply = await insertEntry(3, { member: owner }, 'reply preserved', 'v4-reply', first);
    const agentPost = await insertEntry(2, { agent }, 'agent preserved', 'v4-agent-origin');

    // Every byte value, so a text round-trip or an encoding step cannot pass by accident.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => 255 - index));
    const blobKey = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(blobs, blobKey), bytes);
    const attachment = (
      await db.query(
        `INSERT INTO attachments(channel_id,uploader_member_id,entry_id,blob_key,display_name,content_type,byte_size,checksum,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4,'upgrade.bin','application/octet-stream',$5,$4,'v4-file','v4-file-hash') RETURNING id`,
        [channel, owner, reply, blobKey, bytes.byteLength]
      )
    ).rows[0].id;
    await db.query('INSERT INTO agent_credentials(agent_id,token_hash) VALUES($1,$2),($1,$3)', [
      agent,
      hashSecret('v4-agent-token'),
      hashSecret('v4-revoked-agent-token'),
    ]);
    await db.query('UPDATE agent_credentials SET revoked_at=now() WHERE token_hash=$1', [
      hashSecret('v4-revoked-agent-token'),
    ]);
    await db.query(
      "INSERT INTO connection_grants(member_id,token_hash,scopes) VALUES($1,$2,ARRAY['read','post']),($3,$4,ARRAY['read','post'])",
      [owner, hashSecret('v4-owner-token'), reader, hashSecret('v4-reader-token')]
    );
    const before = await snapshotVersionFourRows(db);

    await migrate(upgradeUrl.toString());

    expect(await snapshotVersionFourRows(db)).toEqual(before);
    const app = createCommunityApp({
      config: parseConfig({
        COMMUNITY_DATABASE_URL: upgradeUrl.toString(),
        COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
        COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
        COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
        COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
        COMMUNITY_STORAGE_PATH: blobs,
      }),
      pool: db,
      blobStore: new FileSystemBlobStore(blobs),
    });
    const get = (path: string, token: string) =>
      app.request(path, { headers: { authorization: `Bearer ${token}` } });
    const post = (path: string, token: string, body: unknown, origin?: string) =>
      app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      });
    type Page = {
      entries: { id: string; seq: number; text: string; originIdempotencyKey?: string }[];
    };
    const history = async (token: string, query = '') => {
      const response = await get(`/api/v1/channels/${channel}/entries${query}`, token);
      expect(response.status).toBe(200);
      return ((await response.json()) as Page).entries;
    };

    // Every pre-upgrade credential still opens the same history, in seq order.
    const expectedTop = [
      { id: first, seq: 1, text: 'first preserved' },
      { id: agentPost, seq: 2, text: 'agent preserved' },
      { id: last, seq: 4, text: 'last preserved' },
    ];
    for (const token of ['v4-owner-token', 'v4-reader-token', 'v4-agent-token']) {
      expect((await history(token)).map(({ id, seq, text }) => ({ id, seq, text }))).toEqual(
        expectedTop
      );
    }
    expect((await history('v4-owner-token', `?thread=${first}`)).map((entry) => entry.id)).toEqual([
      first,
      reply,
    ]);
    expect((await get('/api/v1/channels', 'v4-revoked-agent-token')).status).toBe(401);

    // The agent's pre-upgrade post key stays bound to its origin: the agent and its owner
    // see it, another member does not, and replaying it still deduplicates.
    const originKey = async (token: string) =>
      (await history(token)).find((entry) => entry.id === agentPost)?.originIdempotencyKey;
    expect(await originKey('v4-agent-token')).toBe('v4-agent-origin');
    expect(await originKey('v4-owner-token')).toBe('v4-agent-origin');
    expect(await originKey('v4-reader-token')).toBeUndefined();
    const replay = await post(`/api/v1/channels/${channel}/entries`, 'v4-agent-token', {
      text: 'agent preserved',
      idempotencyKey: 'v4-agent-origin',
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { entry: { id: string } }).entry.id).toBe(agentPost);
    expect(
      (
        await post(`/api/v1/channels/${channel}/entries`, 'v4-agent-token', {
          text: 'different content',
          idempotencyKey: 'v4-agent-origin',
        })
      ).status
    ).toBe(409);
    expect(
      (
        await post(
          `/api/v1/channels/${channel}/entries`,
          'v4-agent-token',
          { text: 'from an untrusted site', idempotencyKey: 'v4-cross-site' },
          'https://untrusted.test'
        )
      ).status
    ).toBe(403);

    const downloaded = await get(`/api/v1/attachments/${attachment}`, 'v4-reader-token');
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);

    // The upgraded host is still a single-community host that can be backed out, until a
    // second community is created.
    expect(await inspectBackout(db)).toEqual({ eligible: true, reason: 'single-community' });
    await db.query("INSERT INTO communities(name) VALUES('Second upgraded community')");
    expect(await inspectBackout(db)).toEqual({
      eligible: false,
      reason: 'multiple-communities-used',
    });
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName} WITH (FORCE)`);
    await rm(blobs, { recursive: true, force: true });
  }
});
