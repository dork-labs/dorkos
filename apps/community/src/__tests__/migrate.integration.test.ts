import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { COMMUNITY_MIGRATIONS, migrate } from '../migrate.js';
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
    const invite = (
      await db.query<{ id: string }>(
        `INSERT INTO invites(community_id,issuer_member_id,token_hash,seat_limit,expires_at)
         VALUES($1,$2,'migration-invite',1,now()+interval '1 hour') RETURNING id`,
        [community, member]
      )
    ).rows[0].id;
    const admission = (
      await db.query<{ id: string }>(
        `INSERT INTO pending_admissions(
           community_id,invite_id,token_hash,account_id,bound_at,expires_at
         ) VALUES($1,$2,'migration-admission','upgrade-user',now(),now()+interval '10 minutes')
         RETURNING id`,
        [community, invite]
      )
    ).rows[0].id;
    await expect(
      db.query(
        `INSERT INTO admission_receipts(
           admission_id,community_id,invite_id,account_id,member_id,expires_at
         ) VALUES($1,$2,$3,'another-account',$4,now()+interval '10 minutes')`,
        [admission, community, invite, member]
      )
    ).rejects.toMatchObject({ code: '23503' });
    const unboundAdmission = (
      await db.query<{ id: string }>(
        `INSERT INTO pending_admissions(community_id,invite_id,token_hash,expires_at)
         VALUES($1,$2,'unbound-migration-admission',now()+interval '10 minutes') RETURNING id`,
        [community, invite]
      )
    ).rows[0].id;
    await expect(
      db.query('UPDATE pending_admissions SET consumed_at=now() WHERE id=$1', [unboundAdmission])
    ).rejects.toMatchObject({ code: '23514' });
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
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
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
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
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
 * Version-four columns that later migrations remove on purpose. Each one's data moves to a
 * new home that the upgrade test checks separately, so leaving it out of the row snapshot
 * hides nothing.
 */
const intentionallyDroppedColumns = new Map<string, string>([
  [
    'entries.mentions',
    '0007 copies each array into entry_mentions and 0008 drops the column; the test checks entry_mentions and the served mentions',
  ],
  [
    'export_archives.channel_ids',
    '0007 copies each array into export_archive_channels and 0008 drops the column; the test checks export_archive_channels',
  ],
  [
    'communities.singleton',
    '0008 drops it so one host can hold several communities; the backout checks cover what replaced it',
  ],
]);

type TableShape = { columns: string[]; timestamps: Set<string>; key: string[] };

/** Read every public table of a database with its columns and primary key, from the catalog. */
async function readTableShapes(db: Pool): Promise<Map<string, TableShape>> {
  const result = await db.query<{
    table_name: string;
    columns: string[];
    timestamps: string[];
    key: string[];
  }>(
    `SELECT t.table_name,
       ARRAY(SELECT c.column_name::text FROM information_schema.columns c
             WHERE c.table_schema='public' AND c.table_name=t.table_name
             ORDER BY c.ordinal_position) AS columns,
       ARRAY(SELECT c.column_name::text FROM information_schema.columns c
             WHERE c.table_schema='public' AND c.table_name=t.table_name
               AND c.data_type LIKE 'timestamp%') AS timestamps,
       ARRAY(SELECT k.column_name::text FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k
               ON k.constraint_schema=tc.constraint_schema AND k.constraint_name=tc.constraint_name
             WHERE tc.table_schema='public' AND tc.table_name=t.table_name
               AND tc.constraint_type='PRIMARY KEY'
             ORDER BY k.ordinal_position) AS key
     FROM information_schema.tables t
     WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
     ORDER BY t.table_name`
  );
  return new Map(
    result.rows.map((row) => [
      row.table_name,
      {
        columns: row.columns.filter(
          (column) => !intentionallyDroppedColumns.has(`${row.table_name}.${column}`)
        ),
        timestamps: new Set(row.timestamps),
        key: row.key,
      },
    ])
  );
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every row of every given table, restricted to the given columns and ordered by primary
 * key, so a lost, reordered, rewritten or dropped value shows up as a diff. A column a
 * migration drops makes the query itself fail. Timestamps are compared as Postgres prints
 * them, because a JavaScript Date keeps only milliseconds and would hide lost microseconds.
 */
async function snapshotRows(db: Pool, shapes: Map<string, TableShape>) {
  const snapshot: Record<string, unknown[]> = {};
  for (const [table, shape] of shapes) {
    snapshot[table] = (
      await db.query(
        `SELECT ${shape.columns
          .map((column) =>
            shape.timestamps.has(column)
              ? `${quote(column)}::text AS ${quote(column)}`
              : quote(column)
          )
          .join(',')} FROM ${quote(table)}
         ORDER BY ${shape.key.map(quote).join(',')}`
      )
    ).rows;
  }
  return snapshot;
}

/**
 * The hash a version-four server stored in `entries.payload_hash`. It must equal what that
 * server wrote, and it is also what the current post route computes, which is why replaying
 * a pre-upgrade key with the same text can deduplicate.
 */
function entryPayloadHash(text: string, mentions: string[] = []): string {
  return createHash('sha256')
    .update(JSON.stringify({ text, mentions, parentEntryId: null, attachmentIds: [] }))
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
    // Every value is explicit and none is a column default, so a migration that resets a
    // column to its default, or nulls it, changes the snapshot.
    // Timestamps carry microseconds, so losing sub-second precision changes the snapshot.
    const stamp = (year: number, minute: number) => {
      const mm = String(minute).padStart(2, '0');
      return `${year}-01-02T03:${mm}:05.1234${mm}Z`;
    };
    const past = (minute: number) => stamp(2025, minute);
    const future = (minute: number) => stamp(2099, minute);
    const one = async (sql: string, params: unknown[] = []): Promise<string> =>
      (await db.query(sql, params)).rows[0].id;

    const community = await one(
      `INSERT INTO communities(name,description,created_at)
       VALUES('V4 acceptance','Upgraded with history',$1) RETURNING id`,
      [past(1)]
    );
    await db.query(
      `INSERT INTO "user"(id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES
         ('v4-owner','V4 Owner','v4-owner@example.test',true,'https://example.test/owner.png',$1,$2),
         ('v4-reader','V4 Reader','v4-reader@example.test',true,'https://example.test/reader.png',$1,$2),
         ('v4-former','V4 Former','v4-former@example.test',true,'https://example.test/former.png',$1,$2)`,
      [past(2), past(3)]
    );
    await db.query(
      `INSERT INTO account(id,"accountId","providerId","userId","accessToken","refreshToken","idToken",
         "accessTokenExpiresAt","refreshTokenExpiresAt",scope,password,"createdAt","updatedAt")
       VALUES('v4-account','v4-owner','credential','v4-owner','access','refresh','id-token',$1,$1,'openid','hashed-password',$2,$3)`,
      [future(1), past(4), past(5)]
    );
    await db.query(
      `INSERT INTO session(id,"expiresAt",token,"createdAt","updatedAt","ipAddress","userAgent","userId")
       VALUES('v4-session',$1,'v4-session-token',$2,$3,'192.0.2.4','Upgrade test','v4-owner')`,
      [future(2), past(6), past(7)]
    );
    await db.query(
      `INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
       VALUES('v4-verification','v4-owner@example.test','v4-code',$1,$2,$3)`,
      [future(3), past(8), past(9)]
    );
    await db.query(
      `INSERT INTO bootstrap_grants(token_hash,expires_at,consumed_at,created_at)
       VALUES('v4-bootstrap-hash',$1,$2,$3)`,
      [future(4), past(10), past(11)]
    );
    const member = (userId: string, role: string, active: boolean, removedAt: string | null) =>
      one(
        `INSERT INTO members(community_id,user_id,display_name,handle,role,active,created_at,removed_at)
         VALUES($1,$2,$3,$2,$4,$5,$6,$7) RETURNING id`,
        [community, userId, userId.replace('v4-', 'V4 '), role, active, past(12), removedAt]
      );
    const owner = await member('v4-owner', 'owner', true, null);
    const reader = await member('v4-reader', 'member', true, null);
    const former = await member('v4-former', 'admin', false, past(13));
    await db.query(
      'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3),($1,$4,$5)',
      [community, 'v4-owner', owner, 'v4-reader', reader]
    );
    const channel = await one(
      `INSERT INTO channels(community_id,name,description,visibility,archived,last_seq,epoch,created_at)
       VALUES($1,'private-upgrade','Private history',$2,false,4,3,$3) RETURNING id`,
      [community, 'private', past(14)]
    );
    const archivedChannel = await one(
      `INSERT INTO channels(community_id,name,description,visibility,archived,last_seq,epoch,created_at)
       VALUES($1,'archived-upgrade','Archived history','public',true,7,2,$2) RETURNING id`,
      [community, past(15)]
    );
    await db.query(
      'INSERT INTO channel_members(channel_id,member_id,joined_at) VALUES($1,$2,$4),($1,$3,$4)',
      [channel, owner, reader, past(16)]
    );
    const agent = await one(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id,active,created_at)
       VALUES($1,$2,'V4 Agent','v4-agent','local-v4-agent',true,$3) RETURNING id`,
      [community, owner, past(17)]
    );
    const retiredAgent = await one(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id,active,created_at,revoked_at)
       VALUES($1,$2,'V4 Retired','v4-retired','local-v4-retired',false,$3,$4) RETURNING id`,
      [community, owner, past(18), past(19)]
    );
    await db.query(
      'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3),($1,$4,$5)',
      [community, 'v4-agent', agent, 'v4-retired', retiredAgent]
    );
    await db.query(
      'INSERT INTO agent_channel_members(channel_id,agent_id,joined_at) VALUES($1,$2,$3)',
      [channel, agent, past(20)]
    );

    // Rows go in out of sequence order, so history served by insertion time, id, or
    // anything but seq comes back in the wrong order.
    const insertEntry = (
      seq: number,
      author: { member?: string; agent?: string },
      text: string,
      idempotencyKey: string,
      { parent = null, mentions = [] }: { parent?: string | null; mentions?: string[] } = {}
    ) =>
      one(
        `INSERT INTO entries(channel_id,seq,author_member_id,author_agent_id,author_display_name,text,
           parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash,mentions,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING id`,
        [
          channel,
          seq,
          author.member ?? null,
          author.agent ?? null,
          author.agent ? 'V4 Agent' : 'V4 Owner',
          text,
          parent,
          idempotencyKey,
          entryPayloadHash(text, mentions),
          mentions,
          past(30 + seq),
        ]
      );
    const last = await insertEntry(4, { member: reader }, 'last preserved', 'v4-last', {
      mentions: [owner, reader],
    });
    const first = await insertEntry(1, { member: owner }, 'first preserved', 'v4-first');
    const reply = await insertEntry(3, { member: owner }, 'reply preserved', 'v4-reply', {
      parent: first,
    });
    const agentPost = await insertEntry(2, { agent }, 'agent preserved', 'v4-agent-origin');

    // Every byte value, so a text round-trip or an encoding step cannot pass by accident.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => 255 - index));
    const blobKey = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(blobs, blobKey), bytes);
    const attachment = await one(
      `INSERT INTO attachments(channel_id,uploader_member_id,entry_id,blob_key,display_name,content_type,
         byte_size,checksum,uploaded_at,idempotency_key,request_hash,cleanup_attempts,cleanup_next_attempt_at)
       VALUES($1,$2,$3,$4,'upgrade.bin','application/octet-stream',$5,$4,$6,'v4-file','v4-file-hash',2,$7)
       RETURNING id`,
      [channel, owner, reply, blobKey, bytes.byteLength, past(40), future(5)]
    );
    await db.query(
      `INSERT INTO attachments(channel_id,uploader_agent_id,blob_key,display_name,content_type,
         byte_size,checksum,uploaded_at,idempotency_key,request_hash,cleanup_attempts,cleanup_next_attempt_at)
       VALUES($1,$2,$3,'unposted.txt','text/plain',9,'unposted-checksum',$4,'v4-unposted','v4-unposted-hash',1,$5)`,
      [channel, agent, 'f'.repeat(64), past(41), future(6)]
    );
    await db.query(
      `INSERT INTO agent_credentials(agent_id,token_hash,created_at,revoked_at)
       VALUES($1,$2,$4,NULL),($1,$3,$4,$5)`,
      [
        agent,
        hashSecret('v4-agent-token'),
        hashSecret('v4-revoked-agent-token'),
        past(42),
        past(43),
      ]
    );
    await db.query(
      `INSERT INTO connection_grants(member_id,token_hash,scopes,created_at,last_used_at,revoked_at,install_name)
       VALUES($1,$2,ARRAY['read','post'],$6,$7,NULL,'Owner laptop'),
             ($3,$4,ARRAY['read','post'],$6,$7,NULL,'Reader laptop'),
             ($1,$5,ARRAY['read'],$6,$7,$8,'Old laptop')`,
      [
        owner,
        hashSecret('v4-owner-token'),
        reader,
        hashSecret('v4-reader-token'),
        hashSecret('v4-revoked-owner-token'),
        past(44),
        past(45),
        past(46),
      ]
    );
    await db.query(
      `INSERT INTO connection_pairings(verifier_hash,member_id,code_hash,expires_at,consumed_at,created_at,
         install_name,scopes,approved_at,polled_at,cancelled_at)
       VALUES('v4-verifier',$1,'v4-code-hash',$2,$3,$4,'Paired laptop',ARRAY['read','post'],$5,$6,$7)`,
      [owner, future(7), past(47), past(48), past(49), past(50), past(51)]
    );
    const invite = await one(
      `INSERT INTO invites(community_id,issuer_member_id,channel_id,token_hash,seat_limit,use_count,
         expires_at,revoked_at,created_at)
       VALUES($1,$2,$3,'v4-invite-hash',5,1,$4,$5,$6) RETURNING id`,
      [community, owner, channel, future(8), past(52), past(53)]
    );
    await db.query('INSERT INTO invite_uses(invite_id,user_id,created_at) VALUES($1,$2,$3)', [
      invite,
      'v4-reader',
      past(54),
    ]);
    await db.query(
      `INSERT INTO pending_admissions(invite_id,token_hash,expires_at,created_at)
       VALUES($1,'v4-admission-hash',$2,$3)`,
      [invite, future(9), past(55)]
    );
    await db.query(
      'INSERT INTO read_cursors(channel_id,member_id,seq,updated_at) VALUES($1,$2,3,$3)',
      [channel, reader, past(56)]
    );
    await db.query(
      `INSERT INTO owner_quota_windows(owner_member_id,window_start,post_count,upload_bytes)
       VALUES($1,$2,7,4096)`,
      [owner, past(57)]
    );
    await db.query(
      `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,created_at)
       VALUES($1,$2,'member.remove',$3,$4)`,
      [community, owner, former, past(58)]
    );
    const archive = await one(
      `INSERT INTO export_archives(requester_member_id,scope,channel_ids,blob_key,byte_size,created_at,
         expires_at,deleted_at,cleanup_attempts,cleanup_next_attempt_at)
       VALUES($1,'owner',ARRAY[$2::uuid,$3::uuid],$4,8,$5,$6,$7,3,$8) RETURNING id`,
      [owner, archivedChannel, channel, 'e'.repeat(64), past(59), future(10), past(59), future(11)]
    );
    await db.query(
      `INSERT INTO pending_blob_deletions(blob_key,created_at,attempts,last_error_at,next_attempt_at)
       VALUES($1,$2,4,$3,$4)`,
      ['d'.repeat(64), past(20), past(21), future(12)]
    );

    // The fixture must exercise every version-four table and column, or the snapshot below
    // could not notice that column being lost.
    const versionFourShapes = await readTableShapes(db);
    // Pin the table set, so a catalog read that finds nothing cannot pass by checking nothing.
    expect([...versionFourShapes.keys()].sort()).toEqual(
      [
        'account',
        'agent_channel_members',
        'agent_credentials',
        'agents',
        'attachments',
        'audit_events',
        'bootstrap_grants',
        'channel_members',
        'channels',
        'communities',
        'community_handles',
        'community_migrations',
        'connection_grants',
        'connection_pairings',
        'entries',
        'export_archives',
        'invite_uses',
        'invites',
        'members',
        'owner_quota_windows',
        'pending_admissions',
        'pending_blob_deletions',
        'read_cursors',
        'session',
        'user',
        'verification',
      ].sort()
    );
    // The migration ledger is the one table that grows on purpose; the earlier tests check it.
    versionFourShapes.delete('community_migrations');
    for (const [table, shape] of versionFourShapes) {
      const counts = (
        await db.query<Record<string, number>>(
          `SELECT count(*)::int AS "*rows", ${shape.columns
            .map((column) => `count(${quote(column)})::int AS ${quote(column)}`)
            .join(',')} FROM ${quote(table)}`
        )
      ).rows[0];
      const unexercised = Object.entries(counts)
        .filter(([, count]) => count === 0)
        .map(([column]) => `${table}.${column}`);
      expect(unexercised).toEqual([]);
    }
    const before = await snapshotRows(db, versionFourShapes);

    await migrate(upgradeUrl.toString());

    expect(await snapshotRows(db, versionFourShapes)).toEqual(before);
    // The two columns that moved into tables of their own kept every value, in order.
    expect(
      (
        await db.query(
          'SELECT entry_id,position::int,mentioned_member_id FROM entry_mentions ORDER BY entry_id,position'
        )
      ).rows
    ).toEqual([
      { entry_id: last, position: 1, mentioned_member_id: owner },
      { entry_id: last, position: 2, mentioned_member_id: reader },
    ]);
    expect(
      (
        await db.query(
          'SELECT export_archive_id,channel_id FROM export_archive_channels ORDER BY position'
        )
      ).rows
    ).toEqual([
      { export_archive_id: archive, channel_id: archivedChannel },
      { export_archive_id: archive, channel_id: channel },
    ]);
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
    const post = (path: string, token: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    type Page = {
      entries: {
        id: string;
        seq: number;
        text: string;
        mentions: string[];
        originIdempotencyKey?: string;
      }[];
    };
    const history = async (token: string, query = '') => {
      const response = await get(`/api/v1/channels/${channel}/entries${query}`, token);
      expect(response.status).toBe(200);
      return ((await response.json()) as Page).entries;
    };

    // Every pre-upgrade credential still opens the same history, in seq order.
    const expectedTop = [
      { id: first, seq: 1, text: 'first preserved', mentions: [] },
      { id: agentPost, seq: 2, text: 'agent preserved', mentions: [] },
      { id: last, seq: 4, text: 'last preserved', mentions: [owner, reader] },
    ];
    for (const token of ['v4-owner-token', 'v4-reader-token', 'v4-agent-token']) {
      expect(
        (await history(token)).map(({ id, seq, text, mentions }) => ({ id, seq, text, mentions }))
      ).toEqual(expectedTop);
    }
    expect((await history('v4-owner-token', `?thread=${first}`)).map((entry) => entry.id)).toEqual([
      first,
      reply,
    ]);
    for (const revoked of ['v4-revoked-agent-token', 'v4-revoked-owner-token']) {
      expect((await get('/api/v1/channels', revoked)).status).toBe(401);
    }

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
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
    await rm(blobs, { recursive: true, force: true });
  }
});

it('keeps version-eleven host audit rows, receipts, and revoked claims valid, and old writes working, after host keys arrive', async () => {
  // Purpose: fails if migration 0012 rejects or reinterprets rows written by a person before
  // keys existed, or if code from before 0012 (the phase 1 backout) can no longer write them.
  const upgradeName = `community_host_keys_upgrade_${randomUUID().replaceAll('-', '')}`;
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
      [10, '0010_administration.sql'],
      [11, '0011_membership_protocol.sql'],
    ] as const) {
      await db.query(
        await readFile(
          fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
          'utf8'
        )
      );
      await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
    }
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES('operator-11','Operator','operator-11@example.test')"
    );
    await db.query("INSERT INTO host_operators(user_id) VALUES('operator-11')");
    const community = (
      await db.query("INSERT INTO communities(name) VALUES('Pending eleven') RETURNING id")
    ).rows[0].id;
    // What version-eleven code writes when it creates, reissues, and revokes an owner claim.
    const writeLegacyRows = async (key: string) => {
      const grant = (
        await db.query(
          `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at,revoked_at,revoked_by)
           VALUES($1,'owner_claim',$2,now()+interval '1 day',now(),'operator-11') RETURNING id`,
          [hashSecret(key), community]
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO community_creation_receipts(
           idempotency_key,operator_user_id,payload_hash,community_id,owner_claim_grant_id
         ) VALUES($1,'operator-11',$2,$3,$4)`,
        [key, 'a'.repeat(64), key === 'before' ? community : await secondCommunity(), grant]
      );
      await db.query(
        `INSERT INTO host_audit_events(actor_user_id,community_id,action,changed_fields)
         VALUES('operator-11',$1,'owner_claim.revoke',ARRAY['owner_claim'])`,
        [community]
      );
    };
    const secondCommunity = async () =>
      (await db.query("INSERT INTO communities(name) VALUES('Pending twelve') RETURNING id"))
        .rows[0].id;
    await writeLegacyRows('before');

    await migrate(upgradeUrl.toString());

    expect(
      (
        await db.query(
          'SELECT actor_kind,actor_user_id,actor_api_key_id,subject_api_key_id FROM host_audit_events'
        )
      ).rows
    ).toEqual([
      {
        actor_kind: 'person',
        actor_user_id: 'operator-11',
        actor_api_key_id: null,
        subject_api_key_id: null,
      },
    ]);
    expect(
      (
        await db.query(
          'SELECT operator_user_id,operator_api_key_id FROM community_creation_receipts'
        )
      ).rows
    ).toEqual([{ operator_user_id: 'operator-11', operator_api_key_id: null }]);
    expect(
      (await db.query('SELECT revoked_by,revoked_by_api_key_id FROM bootstrap_grants')).rows
    ).toEqual([{ revoked_by: 'operator-11', revoked_by_api_key_id: null }]);

    // Code that predates 0012 still writes the same shapes, and they still mean a person.
    await writeLegacyRows('after');
    expect((await db.query('SELECT DISTINCT actor_kind FROM host_audit_events')).rows).toEqual([
      { actor_kind: 'person' },
    ]);

    // The new checks bite: an actor must be named exactly once.
    await expect(
      db.query(
        "INSERT INTO host_audit_events(actor_kind,action) VALUES('api_key','community.create')"
      )
    ).rejects.toThrow(/host_audit_events_actor/);
    await expect(
      db.query(
        "INSERT INTO host_audit_events(actor_kind,actor_user_id,action) VALUES('offline','operator-11','api_key.issue')"
      )
    ).rejects.toThrow(/host_audit_events_actor/);
    await expect(
      db.query(
        `UPDATE bootstrap_grants SET revoked_by=NULL,revoked_by_api_key_id=NULL
         WHERE revoked_at IS NOT NULL`
      )
    ).rejects.toThrow(/bootstrap_grants_revocation/);
    const key = (scopes: string, via = 'command', issuer: string | null = null) =>
      db.query(
        `INSERT INTO host_api_keys(label,prefix,secret_hash,scopes,issued_via,issued_by_user_id)
         VALUES('Key','dkh_abcdef',$1,$2::text[],$3,$4)`,
        [hashSecret(randomUUID()), scopes, via, issuer]
      );
    await expect(key('{communities:read,members:read}')).rejects.toThrow(/host_api_keys_scopes/);
    await expect(key('{}')).rejects.toThrow(/host_api_keys_scopes/);
    await expect(key('{communities:read}', 'browser')).rejects.toThrow(/host_api_keys_issuer/);
    await key('{communities:read}', 'browser', 'operator-11');
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
  }
});

// Purpose: the migrator refuses a database whose recorded history skips a listed version,
// and changes nothing when it does.
it('refuses to run an unapplied migration below the newest applied one', async () => {
  const gapName = `community_gap_${randomUUID().replaceAll('-', '')}`;
  const gapUrl = new URL(adminUrl!);
  gapUrl.pathname = `/${gapName}`;
  await admin.query(`CREATE DATABASE ${gapName}`);
  const db = new Pool({ connectionString: gapUrl.toString() });
  try {
    await db.query(
      'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    await db.query('INSERT INTO community_migrations(version) VALUES (1),(3)');
    await expect(migrate(gapUrl.toString())).rejects.toThrow(
      'Community migrations 2 were never applied, but 3 was'
    );
    expect(
      (await db.query('SELECT version FROM community_migrations ORDER BY version')).rows
    ).toEqual([{ version: 1 }, { version: 3 }]);
  } finally {
    await db.end();
    // Never WITH (FORCE) straight after db.end(): the pool resolves before its connections
    // close, and forcing kills them mid-close into an uncaught pool error. A plain drop waits.
    await admin.query(`DROP DATABASE IF EXISTS ${gapName}`);
  }
});

/** Apply every migration before member erasure, recorded as already migrated. */
async function applyBeforeErasure(db: Pool): Promise<void> {
  await db.query(
    'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  for (const [version, filename] of COMMUNITY_MIGRATIONS) {
    if (filename === '0013_member_erasure.sql') break;
    await db.query(
      await readFile(
        fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
        'utf8'
      )
    );
    await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
  }
}

// Purpose: the member-erasure migration on a populated database backfills what it must
// (content versions, where a pending deletion returns to, a redaction epoch), keeps the
// author idempotency rule identical through its new partial index, enforces the member
// presence check, and still accepts the writes code from before it makes (old code against
// the new schema).
it('upgrades a populated database to member erasure without changing what old code does', async () => {
  const name = `community_erasure_upgrade_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Pool({ connectionString: url.toString() });
  try {
    await applyBeforeErasure(db);
    const one = async (sql: string, params: unknown[] = []): Promise<string> =>
      (await db.query(sql, params)).rows[0].id;
    await db.query(
      `INSERT INTO "user"(id,name,email,"emailVerified") VALUES
         ('u-owner','Owner','owner@upgrade.test',true),('u-member','Member','member@upgrade.test',true)`
    );
    const seed = async (label: string) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const community = (
          await client.query<{ id: string }>(
            "INSERT INTO communities(name,lifecycle) VALUES($1,'pending_owner') RETURNING id",
            [label]
          )
        ).rows[0].id;
        const owner = (
          await client.query<{ id: string }>(
            `INSERT INTO members(community_id,user_id,display_name,handle,role)
             VALUES($1,'u-owner','Owner','owner','owner') RETURNING id`,
            [community]
          )
        ).rows[0].id;
        await client.query(
          "UPDATE communities SET lifecycle='active',activated_at=now() WHERE id=$1",
          [community]
        );
        await client.query('COMMIT');
        return { community, owner };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const active = await seed('Active');
    const deleting = await seed('Deleting');
    await db.query(
      `UPDATE communities SET lifecycle='deletion_pending',delete_requested_at=now(),
         delete_after=now()+interval '7 days',delete_requested_by=$2 WHERE id=$1`,
      [deleting.community, deleting.owner]
    );
    const member = await one(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,'u-member','Member','member','member') RETURNING id`,
      [active.community]
    );
    const channel = await one(
      "INSERT INTO channels(community_id,name,visibility,last_seq) VALUES($1,'general','public',1) RETURNING id",
      [active.community]
    );
    await db.query(
      `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
         idempotency_key,payload_hash) VALUES($1,$2,1,$3,'Member','hello','k1','h')`,
      [active.community, channel, member]
    );

    await migrate(url.toString());

    // Backfills.
    const versions = await db.query(
      'SELECT community_id FROM community_content_versions ORDER BY community_id'
    );
    expect(versions.rows.map((row) => row.community_id).sort()).toEqual(
      [active.community, deleting.community].sort()
    );
    const origins = await db.query(
      `SELECT id,deletion_from_state,deletion_from_prior_state,redaction_epoch IS NOT NULL AS epoch
       FROM communities ORDER BY id`
    );
    expect(origins.rows).toEqual(
      [
        {
          id: active.community,
          deletion_from_state: null,
          deletion_from_prior_state: null,
          epoch: true,
        },
        {
          id: deleting.community,
          deletion_from_state: 'archived',
          deletion_from_prior_state: null,
          epoch: true,
        },
      ].sort((a, b) => a.id.localeCompare(b.id))
    );

    // The author idempotency rule is exactly as before: same author, channel, and key conflict;
    // another author with the same key does not.
    const insert = (author: string, key: string) =>
      db.query(
        `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
           idempotency_key,payload_hash)
         SELECT $1,$2,coalesce(max(seq),0)+1,$3,'x','x',$4,'h' FROM entries WHERE channel_id=$2`,
        [active.community, channel, author, key]
      );
    await expect(insert(member, 'k1')).rejects.toThrow(/entries_author_key_unique/);
    await insert(active.owner, 'k1');
    await insert(member, 'k2');

    // The presence check: a member row needs an account unless it is an erased husk, and a
    // husk can be neither linked nor active.
    const husk = (userId: string | null, active_: boolean, erased: boolean) =>
      db.query(
        `INSERT INTO members(community_id,user_id,display_name,handle,role,active,erased_at)
         VALUES($1,$2,'Husk',$3,'member',$4,$5)`,
        [
          active.community,
          userId,
          `h-${randomUUID().slice(0, 8)}`,
          active_,
          erased ? new Date() : null,
        ]
      );
    await expect(husk(null, false, false)).rejects.toThrow(/members_user_presence/);
    await expect(husk(null, true, true)).rejects.toThrow(/members_erased_husk/);
    await expect(husk('u-member', false, true)).rejects.toThrow(/members_erased_husk/);
    await husk(null, false, true);

    // Old code against the new schema. A community created the old way gets its version row.
    const fresh = await one(
      "INSERT INTO communities(name,lifecycle) VALUES('Fresh','pending_owner') RETURNING id"
    );
    expect(
      (
        await db.query('SELECT version FROM community_content_versions WHERE community_id=$1', [
          fresh,
        ])
      ).rows
    ).toEqual([{ version: '1' }]);
    // The old owner deletion cancel sets only the columns it knew; leaving deletion_pending
    // clears the new origin columns so every lifecycle check still passes.
    await db.query(
      `UPDATE communities SET lifecycle='archived',archived_at=now(),
         delete_requested_at=NULL,delete_after=NULL,delete_requested_by=NULL,
         lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [deleting.community]
    );
    // The old deletion request sets only the columns it knew.
    await db.query(
      `UPDATE communities SET lifecycle='deletion_pending',archived_at=NULL,
         delete_requested_at=now(),delete_after=now()+interval '7 days',delete_requested_by=$2,
         lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [active.community, active.owner]
    );
    // The old export insert names no content version.
    await db.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,
         byte_size,checksum,stored_at,committed_at)
       VALUES($1,$2,'export',1,'committed',1,'c',now(),now())`,
      ['e'.repeat(64), active.community]
    );
    await db.query(
      `INSERT INTO export_archives(community_id,requester_member_id,scope,blob_key,byte_size,expires_at)
       VALUES($1,$2,'owner',$3,1,now()+interval '1 hour')`,
      [active.community, active.owner, 'e'.repeat(64)]
    );
    // The old owner export's inner join still reads every linked member.
    const exported = await db.query(
      `SELECT m.id FROM members m JOIN "user" u ON u.id=m.user_id WHERE m.community_id=$1`,
      [active.community]
    );
    expect(exported.rowCount).toBe(2);
  } finally {
    await db.end();
    // Never WITH (FORCE) straight after db.end(): the pool resolves before its connections
    // close, and forcing kills them mid-close into an uncaught pool error. A plain drop waits.
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }
});
