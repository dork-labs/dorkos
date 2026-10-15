import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql as migrationSql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { readPublishedConnectorRecoveryPlan } from '../../../../../../packages/db/src/connector-retirement-recovery-data.js';
import { bridgeLegacyDocMigrationHistory } from '../../../../../../packages/db/src/doc-migration-history.js';
import {
  publishedRoom,
  publishedRoom151,
  consolidatedDoc,
  reportBack,
  agentReports,
  type MigrationEntry,
} from '../../../../../../packages/db/src/doc-migration-identities.js';
import { verifyCanonicalSchema } from '../../../../../../packages/db/src/doc-migration-schema.js';
import {
  CONNECTOR_FOUNDATION_MIGRATION_VERSION,
  runLegacyConnectionMigration,
} from '../legacy-connection-migration.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(dirname, '../../../../../../packages/db/drizzle');
const MIGRATION_INDEX = 86;
const MIGRATION_TAG = '0086_perfect_whiplash';
const temporaryDirectories: string[] = [];

/**
 * Applies the installed SQLiteSyncDialect migration algorithm within the disposable fixture recovery
 * transaction already owned by this test. The public entry owns its canonical folder.
 * The official reader supplies statement boundaries, hashes and timestamps; only
 * the dialect's redundant BEGIN/COMMIT/ROLLBACK are owned by the outer transaction.
 */
function applyFixtureRecoveryMigrations(db: ReturnType<typeof createDb>, folder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  db.run(migrationSql`CREATE TABLE IF NOT EXISTS ${migrationSql.identifier('__drizzle_migrations')} (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`);
  const lastDbMigration = db.values<[number, string, number]>(
    migrationSql`SELECT id, hash, created_at FROM ${migrationSql.identifier('__drizzle_migrations')} ORDER BY created_at DESC LIMIT 1`
  )[0];
  for (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration[2]) < migration.folderMillis) {
      for (const statement of migration.sql) db.run(migrationSql.raw(statement));
      db.run(
        migrationSql`INSERT INTO ${migrationSql.identifier('__drizzle_migrations')} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`
      );
    }
  }
}

function fixtureTime(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 5, 0, minutes)).toISOString();
}

function createOldDatabase(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dorkos-connector-legacy-'));
  temporaryDirectories.push(root);
  const migrations = path.join(root, 'migrations');
  mkdirSync(path.join(migrations, 'meta'), { recursive: true });
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; tag: string }> };
  expect(journal.entries.map((entry) => entry.tag)).toContain(MIGRATION_TAG);
  const before = journal.entries.filter((entry) => entry.idx < MIGRATION_INDEX);
  for (const entry of before) {
    copyFileSync(
      path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
      path.join(migrations, `${entry.tag}.sql`)
    );
  }
  writeFileSync(
    path.join(migrations, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before })
  );
  const dbPath = path.join(root, 'dork.db');
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  raw.pragma('recursive_triggers = ON');
  migrate(drizzle(raw), { migrationsFolder: migrations });

  const insertAccount = raw.prepare(
    `INSERT INTO connected_accounts
     (account_id, provider, toolkit, label, custody, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertAccount.run(
    'composio:personal',
    'composio',
    'gmail',
    'Personal',
    'managed',
    'active',
    fixtureTime(1)
  );
  insertAccount.run(
    'composio:work',
    'composio',
    'gmail',
    'Work',
    'managed',
    'expired',
    fixtureTime(2)
  );
  insertAccount.run(
    'missing:notion',
    'missing-provider',
    'notion',
    'Archive',
    'external',
    'revoked',
    fixtureTime(3)
  );

  raw
    .prepare(
      `INSERT INTO agents
     (id, name, runtime, project_path, namespace, capabilities_json, scan_root, behavior_json,
      persona_enabled, is_system, registered_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', '[]', '', '{"responseMode":"always"}', 1, 0, ?, ?)`
    )
    .run('agent-a', 'Agent A', 'claude-code', '/projects/a', fixtureTime(0), fixtureTime(0));
  raw
    .prepare(
      `INSERT INTO agents
     (id, name, runtime, project_path, namespace, capabilities_json, scan_root, behavior_json,
      persona_enabled, is_system, registered_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', '[]', '', '{"responseMode":"always"}', 1, 0, ?, ?)`
    )
    .run('agent-b', 'Agent B', 'claude-code', '/projects/b', fixtureTime(0), fixtureTime(0));
  raw
    .prepare(
      'INSERT INTO session_metadata(session_id, runtime, agent_path, created_at) VALUES (?, ?, ?, ?)'
    )
    .run('session-known', 'claude-code', '/projects/a', fixtureTime(0));
  raw
    .prepare(
      'INSERT INTO session_metadata(session_id, runtime, agent_path, created_at) VALUES (?, ?, ?, ?)'
    )
    .run('session-stale-owner', 'claude-code', '/projects/no-longer-registered', fixtureTime(0));

  const insertAgent = raw.prepare(
    'INSERT INTO agent_connector_attachments(agent_id, account_id, attached_at) VALUES (?, ?, ?)'
  );
  insertAgent.run('agent-a', 'composio:personal', fixtureTime(4));
  insertAgent.run('agent-a', 'composio:work', fixtureTime(5));
  insertAgent.run('agent-b', 'composio:personal', fixtureTime(6));
  const insertSession = raw.prepare(
    'INSERT INTO session_connector_attachments(session_id, account_id, state, updated_at) VALUES (?, ?, ?, ?)'
  );
  insertSession.run('session-known', 'composio:personal', 'attached', fixtureTime(7));
  insertSession.run('session-known', 'composio:work', 'detached', fixtureTime(8));
  insertSession.run('session-no-metadata', 'missing:notion', 'attached', fixtureTime(9));
  insertSession.run('session-stale-owner', 'composio:personal', 'attached', fixtureTime(10));
  raw.close();
  return dbPath;
}

function rows(raw: Database.Database, table: string): unknown[] {
  return raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function hasTable(raw: Database.Database, table: string): boolean {
  return Boolean(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('legacy connector application migration', () => {
  it('contains an initial migration-ledger read failure inside the typed recovery boundary', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    db.$client.exec('DROP TABLE connector_application_migrations');

    const result = runLegacyConnectionMigration(db);

    expect(result).toEqual({
      status: 'migration_failed',
      error:
        'DorkOS couldn’t upgrade its saved connections. Changes to connections are off until you restart DorkOS.',
    });
    expect(JSON.stringify(result)).not.toMatch(/SQLITE|connector_application_migrations/i);
    db.$client.close();
  });

  it('rolls back interruption, reports failure, then retries with stable exact state', () => {
    const dbPath = createOldDatabase();
    const db = createDb(dbPath);
    runMigrations(db);
    const legacyBefore = {
      accounts: rows(db.$client, 'connected_accounts'),
      agents: rows(db.$client, 'agent_connector_attachments'),
      sessions: rows(db.$client, 'session_connector_attachments'),
    };
    let id = 0;
    const configuredProviders = [
      {
        instanceId: 'configured-composio-instance',
        type: 'composio',
        mode: 'byo' as const,
        displayName: 'Composio',
        custody: 'managed' as const,
        capabilityJson: '{}',
        status: 'available' as const,
      },
      {
        instanceId: 'configured-composio-secondary',
        type: 'composio',
        mode: 'byo' as const,
        displayName: 'Composio secondary',
        custody: 'managed' as const,
        capabilityJson: '{}',
        status: 'unavailable' as const,
      },
    ];

    const failed = runLegacyConnectionMigration(db, {
      configuredProviders,
      createId: () => `generated-${++id}`,
      now: () => fixtureTime(20),
      afterStep: (step) => {
        expect(db.$client.inTransaction).toBe(true);
        if (step === 'attachments') throw new Error('injected interruption');
      },
    });
    expect(failed).toEqual({
      status: 'migration_failed',
      error:
        'DorkOS couldn’t upgrade its saved connections. Changes to connections are off until you restart DorkOS.',
    });
    expect(JSON.stringify(failed)).not.toContain('composio:personal');
    expect(rows(db.$client, 'connected_accounts')).toEqual(legacyBefore.accounts);
    expect(rows(db.$client, 'agent_connector_attachments')).toEqual(legacyBefore.agents);
    expect(rows(db.$client, 'session_connector_attachments')).toEqual(legacyBefore.sessions);
    expect(rows(db.$client, 'connections')).toEqual([]);
    expect(rows(db.$client, 'connector_application_migrations')).toEqual([]);

    id = 0;
    const succeeded = runLegacyConnectionMigration(db, {
      configuredProviders,
      createId: () => `stable-${++id}`,
      now: () => fixtureTime(21),
    });
    expect(succeeded).toEqual({ status: 'ready', migrated: true });

    const providers = rows(db.$client, 'connector_provider_instances') as Array<
      Record<string, unknown>
    >;
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'configured-composio-instance',
          type: 'composio',
          mode: 'byo',
          custody: 'managed',
          status: 'available',
        }),
        expect.objectContaining({
          id: 'configured-composio-secondary',
          type: 'composio',
          status: 'unavailable',
        }),
        expect.objectContaining({ type: 'missing-provider', status: 'unavailable' }),
      ])
    );
    const migratedConnections = rows(db.$client, 'connections') as Array<Record<string, unknown>>;
    expect(migratedConnections).toHaveLength(3);
    expect(migratedConnections.filter((row) => row.toolkit === 'gmail')).toHaveLength(2);
    expect(
      migratedConnections
        .filter((row) => String(row.external_account_ref).startsWith('composio:'))
        .every((row) => row.provider_instance_id === 'configured-composio-instance')
    ).toBe(true);
    expect(
      migratedConnections.every(
        (row) => row.grant_reconciliation_status === 'migration_needs_reconcile'
      )
    ).toBe(true);
    expect(
      migratedConnections.find((row) => row.external_account_ref === 'missing:notion')
    ).toMatchObject({ status: 'revoked', lifecycle_state: 'disconnected' });
    expect(rows(db.$client, 'connection_operation_grants')).toEqual([]);

    const overrides = rows(db.$client, 'session_connection_overrides') as Array<
      Record<string, unknown>
    >;
    expect(overrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: 'session-known',
          agent_id: 'agent-a',
          state: 'attached',
          needs_reconciliation: 0,
        }),
        expect.objectContaining({
          session_id: 'session-known',
          agent_id: 'agent-a',
          state: 'detached',
          needs_reconciliation: 0,
        }),
        expect.objectContaining({
          session_id: 'session-no-metadata',
          agent_id: null,
          needs_reconciliation: 1,
        }),
        expect.objectContaining({
          session_id: 'session-stale-owner',
          agent_id: null,
          needs_reconciliation: 1,
        }),
      ])
    );
    expect(rows(db.$client, 'connector_application_migrations')).toMatchObject([
      { version: CONNECTOR_FOUNDATION_MIGRATION_VERSION, state: 'complete' },
    ]);
    const stableIds = migratedConnections.map((row) => row.id);
    expect(runLegacyConnectionMigration(db, { configuredProviders })).toEqual({
      status: 'ready',
      migrated: false,
    });
    expect(
      (rows(db.$client, 'connections') as Array<Record<string, unknown>>).map((row) => row.id)
    ).toEqual(stableIds);
    expect(
      [
        'connected_accounts',
        'agent_connector_attachments',
        'session_connector_attachments',
        'connector_legacy_agent_revocations',
      ].every((table) => hasTable(db.$client, table))
    ).toBe(true);
    db.$client.close();
  });

  it('preserves but does not authorize legacy consent for an agent removed before backfill', () => {
    const dbPath = createOldDatabase();
    const db = createDb(dbPath);
    runMigrations(db);
    db.$client.prepare("DELETE FROM agents WHERE id = 'agent-a'").run();
    expect(runLegacyConnectionMigration(db)).toEqual({ status: 'ready', migrated: true });

    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_connection_attachments WHERE agent_id = 'agent-a'"
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_connection_attachments WHERE agent_id = 'agent-b'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(hasTable(db.$client, 'agent_connector_attachments')).toBe(true);
    expect(
      db.$client
        .prepare(
          "SELECT agent_id, needs_reconciliation FROM session_connection_overrides WHERE session_id = 'session-known'"
        )
        .all()
    ).toEqual([
      { agent_id: null, needs_reconciliation: 1 },
      { agent_id: null, needs_reconciliation: 1 },
    ]);
    db.$client.close();
  });

  it('rolls legacy-reader retirement back with the backfill and completion ledger', () => {
    const dbPath = createOldDatabase();
    const db = createDb(dbPath);
    runMigrations(db);
    const before = {
      accounts: rows(db.$client, 'connected_accounts'),
      agents: rows(db.$client, 'agent_connector_attachments'),
      sessions: rows(db.$client, 'session_connector_attachments'),
    };

    expect(
      runLegacyConnectionMigration(db, {
        afterStep: (step) => {
          if (step === 'retired') throw new Error('interrupt after retirement');
        },
      })
    ).toMatchObject({ status: 'migration_failed' });
    expect(rows(db.$client, 'connected_accounts')).toEqual(before.accounts);
    expect(rows(db.$client, 'agent_connector_attachments')).toEqual(before.agents);
    expect(rows(db.$client, 'session_connector_attachments')).toEqual(before.sessions);
    expect(rows(db.$client, 'connections')).toEqual([]);
    expect(rows(db.$client, 'connector_application_migrations')).toEqual([]);
    db.$client.close();
  });

  it('retains canonical legacy tables on a later boot without rereading them', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    db.$client
      .prepare(
        'INSERT INTO connector_application_migrations(version, state, started_at, completed_at) VALUES (?, ?, ?, ?)'
      )
      .run(CONNECTOR_FOUNDATION_MIGRATION_VERSION, 'complete', fixtureTime(1), fixtureTime(2));
    db.$client.exec(`
      INSERT INTO connected_accounts
      (account_id, provider, toolkit, label, custody, status, created_at)
      VALUES ('must-not-replay', 'missing', 'gmail', 'Old', 'external', 'active', '${fixtureTime(1)}')
    `);

    expect(runLegacyConnectionMigration(db)).toEqual({ status: 'ready', migrated: false });
    expect(
      [
        'connected_accounts',
        'agent_connector_attachments',
        'session_connector_attachments',
        'connector_legacy_agent_revocations',
      ].every((table) => hasTable(db.$client, table))
    ).toBe(true);
    expect(rows(db.$client, 'connections')).toEqual([]);
    db.$client.close();
  });

  it('preserves canonical connector schema through backfill and a real database restart', () => {
    const dbPath = createOldDatabase();
    const db = createDb(dbPath);
    let reopened: typeof db | undefined;
    try {
      runMigrations(db);
      const history = db.$client
        .prepare('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id')
        .all();
      const legacyTables = [
        'connected_accounts',
        'agent_connector_attachments',
        'session_connector_attachments',
        'connector_legacy_agent_revocations',
      ];
      const schema = legacyTables.map((table) =>
        db.$client
          .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      );
      const legacyRows = legacyTables.map((table) => rows(db.$client, table));
      expect(runLegacyConnectionMigration(db)).toEqual({ status: 'ready', migrated: true });
      const connections = rows(db.$client, 'connections');
      expect(connections).toHaveLength(3);
      const attachments = rows(db.$client, 'agent_connection_attachments');
      const overrides = rows(db.$client, 'session_connection_overrides');
      db.$client.close();

      reopened = createDb(dbPath);
      // This executes the real unchanged canonical history/schema verifier after runtime writes.
      expect(() => runMigrations(reopened!)).not.toThrow();
      expect(
        reopened.$client
          .prepare('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id')
          .all()
      ).toEqual(history);
      expect(
        legacyTables.map((table) =>
          reopened!.$client
            .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name=?")
            .get(table)
        )
      ).toEqual(schema);
      expect(legacyTables.map((table) => rows(reopened!.$client, table))).toEqual(legacyRows);
      expect(rows(reopened.$client, 'connections')).toEqual(connections);
      expect(rows(reopened.$client, 'agent_connection_attachments')).toEqual(attachments);
      expect(rows(reopened.$client, 'session_connection_overrides')).toEqual(overrides);
      expect(runLegacyConnectionMigration(reopened)).toEqual({ status: 'ready', migrated: false });
      expect(rows(reopened.$client, 'connections')).toEqual(connections);
      expect(rows(reopened.$client, 'connection_operation_grants')).toEqual([]);
    } finally {
      if (reopened?.$client.open) reopened.$client.close();
      if (db.$client.open) db.$client.close();
    }
  });

  it('creates exact revision grants only for reconciled owners and complete metadata', () => {
    const dbPath = createOldDatabase();
    const db = createDb(dbPath);
    runMigrations(db);
    let id = 0;

    expect(
      runLegacyConnectionMigration(db, {
        configuredProviders: [
          {
            instanceId: 'configured-composio-instance',
            type: 'composio',
            mode: 'byo',
            displayName: 'Composio',
            custody: 'managed',
            capabilityJson: '{}',
            status: 'available',
          },
        ],
        operationSets: [
          {
            providerType: 'composio',
            toolkit: 'gmail',
            complete: true,
            operations: [
              {
                operationSlug: 'gmail.read',
                toolkitVersion: '2026-09-01',
                schemaHash: 'sha256:gmail-read-v1',
                capabilityClassification: 'read',
                inputSchemaJson: '{}',
              },
            ],
          },
        ],
        createId: () => `exact-${++id}`,
        now: () => fixtureTime(30),
      })
    ).toEqual({ status: 'ready', migrated: true });

    const revisions = rows(db.$client, 'connector_operation_revisions') as Array<
      Record<string, unknown>
    >;
    expect(revisions).toMatchObject([
      {
        provider_instance_id: 'configured-composio-instance',
        toolkit: 'gmail',
        operation_slug: 'gmail.read',
        toolkit_version: '2026-09-01',
        schema_hash: 'sha256:gmail-read-v1',
        capability_classification: 'read',
      },
    ]);
    const grants = rows(db.$client, 'connection_operation_grants') as Array<
      Record<string, unknown>
    >;
    expect(grants.filter((row) => row.subject_type === 'agent')).toHaveLength(3);
    expect(grants.filter((row) => row.subject_id === 'session-known')).toHaveLength(1);
    expect(grants.some((row) => row.subject_id === 'session-no-metadata')).toBe(false);
    expect(grants.some((row) => row.subject_id === 'session-stale-owner')).toBe(false);
    expect(
      (rows(db.$client, 'connections') as Array<Record<string, unknown>>)
        .filter((row) => row.toolkit === 'gmail')
        .every((row) => row.grant_reconciliation_status === 'ready')
    ).toBe(true);
    expect(
      (rows(db.$client, 'connections') as Array<Record<string, unknown>>).find(
        (row) => row.toolkit === 'notion'
      )
    ).toMatchObject({ grant_reconciliation_status: 'migration_needs_reconcile' });
    db.$client.close();
  });
  // The literal published writer retired these tables after a completed backfill.
  // Keep this historical mutation separate from the preventive current writer.
  function reproducePublishedRetirement(db: ReturnType<typeof createDb>) {
    for (const table of [
      'session_connector_attachments',
      'agent_connector_attachments',
      'connected_accounts',
      'connector_legacy_agent_revocations',
    ])
      db.$client.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  function publishedConnectorDatabase(lastIdx: number) {
    const dbPath = createOldDatabase();
    const migrations = path.join(path.dirname(dbPath), `published-${lastIdx}`);
    mkdirSync(path.join(migrations, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
    ) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
    expect(entries.at(-1)?.idx).toBe(lastIdx);
    for (const entry of entries)
      copyFileSync(
        path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
        path.join(migrations, `${entry.tag}.sql`)
      );
    writeFileSync(
      path.join(migrations, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries })
    );
    const raw = new Database(dbPath);
    try {
      migrate(drizzle(raw), { migrationsFolder: migrations });
    } finally {
      raw.close();
    }
    const db = createDb(dbPath);
    try {
      expect(runLegacyConnectionMigration(db)).toEqual({ status: 'ready', migrated: true });
      return { db, dbPath };
    } catch (cause) {
      try {
        db.$client.close();
      } catch {
        // Preserve the original fixture failure when closing the failed connection also throws.
      }
      throw cause;
    }
  }

  it.each([150, 151, 152])(
    'recovers the published completed connector retirement from canonical index %s without replaying identities',
    (lastIdx) => {
      const { db, dbPath } = publishedConnectorDatabase(lastIdx);
      let reopened: ReturnType<typeof createDb> | undefined;
      let originalOpen = true;
      let failure: { cause: unknown } | undefined;
      try {
        const history = db.$client
          .prepare('SELECT id,hash,created_at FROM __drizzle_migrations ORDER BY rowid')
          .all();
        const ledger = rows(db.$client, 'connector_application_migrations');
        const retained = [
          'connections',
          'agent_connection_attachments',
          'session_connection_overrides',
          'connection_operation_grants',
        ];
        const data = retained.map((table) => rows(db.$client, table));
        reproducePublishedRetirement(db);
        db.$client.close();
        originalOpen = false;
        reopened = createDb(dbPath);
        expect(() => runMigrations(reopened!)).not.toThrow();
        const upgraded = reopened.$client
          .prepare('SELECT id,hash,created_at FROM __drizzle_migrations ORDER BY rowid')
          .all();
        expect(upgraded.slice(0, history.length)).toEqual(history);
        expect(rows(reopened.$client, 'connector_application_migrations')).toEqual(ledger);
        retained.forEach((table, idx) => expect(rows(reopened!.$client, table)).toEqual(data[idx]));
        for (const table of [
          'connected_accounts',
          'agent_connector_attachments',
          'session_connector_attachments',
          'connector_legacy_agent_revocations',
        ]) {
          expect(hasTable(reopened.$client, table)).toBe(true);
          expect(rows(reopened.$client, table)).toEqual([]);
        }
        expect(
          runLegacyConnectionMigration(reopened, {
            createId: () => {
              throw new Error('Historical connector IDs must not replay');
            },
          })
        ).toEqual({ status: 'ready', migrated: false });
        expect(() => runMigrations(reopened!)).not.toThrow();
        retained.forEach((table, idx) => expect(rows(reopened!.$client, table)).toEqual(data[idx]));
      } catch (cause) {
        failure = { cause };
      } finally {
        try {
          if (originalOpen) db.$client.close();
        } catch (cause) {
          failure ??= { cause };
        }
        try {
          reopened?.$client.close();
        } catch (cause) {
          failure ??= { cause };
        }
      }
      if (failure) throw failure.cause;
    }
  );

  it.each([
    'partial',
    'unmarked',
    'claimed',
    'wrong-schema',
    'wrong-history',
    'migration-fault',
  ] as const)('refuses or rolls back published connector recovery for %s', (fault) => {
    const { db } = publishedConnectorDatabase(150);
    try {
      if (fault === 'partial') db.$client.exec('DROP TABLE connected_accounts');
      else reproducePublishedRetirement(db);
      if (fault === 'unmarked') db.$client.exec('DELETE FROM connector_application_migrations');
      if (fault === 'claimed')
        db.$client.exec("UPDATE connector_application_migrations SET state='claimed'");
      if (fault === 'wrong-schema')
        db.$client.exec('ALTER TABLE agents ADD COLUMN forged_recovery_column TEXT');
      if (fault === 'wrong-history')
        db.$client.exec('UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE rowid=1');
      if (fault === 'migration-fault')
        db.$client.exec(
          "CREATE TEMP TRIGGER refuse_recovery_history BEFORE INSERT ON __drizzle_migrations BEGIN SELECT RAISE(ABORT,'recovery migration rollback'); END"
        );
      const schema = db.$client
        .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
        .all();
      const history = rows(db.$client, '__drizzle_migrations');
      const ledger = rows(db.$client, 'connector_application_migrations');
      const connections = rows(db.$client, 'connections');
      expect(() => runMigrations(db)).toThrow();
      expect(
        db.$client
          .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
          .all()
      ).toEqual(schema);
      expect(rows(db.$client, '__drizzle_migrations')).toEqual(history);
      expect(rows(db.$client, 'connector_application_migrations')).toEqual(ledger);
      expect(rows(db.$client, 'connections')).toEqual(connections);
    } finally {
      db.$client.close();
    }
  });

  it.each(['pending', 'recorded'] as const)(
    'restores connector DDL from the exact %s future migration prefix',
    (state) => {
      const { db, dbPath } = publishedConnectorDatabase(152);
      try {
        const folder = path.join(path.dirname(dbPath), `future-${state}`);
        mkdirSync(path.join(folder, 'meta'), { recursive: true });
        const journal = JSON.parse(
          readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
        ) as {
          entries: Array<{
            idx: number;
            tag: string;
            when: number;
            version: string;
            breakpoints: boolean;
          }>;
        };
        for (const entry of journal.entries)
          copyFileSync(
            path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
            path.join(folder, `${entry.tag}.sql`)
          );
        const future = {
          idx: journal.entries.length,
          tag: 'fixture_future_connector_column',
          when: journal.entries.at(-1)!.when + 1,
          version: '6',
          breakpoints: true,
        };
        const entries = [...journal.entries, future];
        writeFileSync(
          path.join(folder, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries })
        );
        writeFileSync(
          path.join(folder, `${future.tag}.sql`),
          'ALTER TABLE connected_accounts ADD COLUMN future_connector_note TEXT;'
        );
        if (state === 'recorded') migrate(db, { migrationsFolder: folder });
        const ledger = rows(db.$client, 'connector_application_migrations');
        const connections = rows(db.$client, 'connections');
        reproducePublishedRetirement(db);
        db.$client.transaction(() => {
          const plan = readPublishedConnectorRecoveryPlan(db, folder);
          expect(plan).toBeDefined();
          expect(plan!.sql.some((sql) => sql.includes('future_connector_note'))).toBe(
            state === 'recorded'
          );
          for (const sql of plan!.sql) db.$client.exec(sql);
          // Exact original entry sequence at a disposable future canonical folder.
          bridgeLegacyDocMigrationHistory(db, folder);
          applyFixtureRecoveryMigrations(db, folder);
          verifyCanonicalSchema(db, folder, undefined, [], entries.length);
        })();
        expect(db.$client.prepare("PRAGMA table_info('connected_accounts')").all()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'future_connector_note',
              type: 'TEXT',
              notnull: 0,
              dflt_value: null,
            }),
          ])
        );
        expect(rows(db.$client, 'connector_application_migrations')).toEqual(ledger);
        expect(rows(db.$client, 'connections')).toEqual(connections);
        expect(() =>
          verifyCanonicalSchema(db, folder, undefined, [], entries.length)
        ).not.toThrow();
      } finally {
        db.$client.close();
      }
    }
  );

  // Complement canonical Main150/Main151/Room152 with both published Room receipts
  // and the physically bridged151 row order retained by the original bridge.
  const oldRoomVariants = ['published150', 'fresh151', 'bridged151'] as const;
  type OldRoomVariant = (typeof oldRoomVariants)[number];

  function seedRecoveryRoomState(db: ReturnType<typeof createDb>, hasDoc: boolean) {
    db.$client
      .prepare(
        'INSERT INTO session_metadata (session_id, runtime, agent_path, created_at) VALUES (?, ?, ?, ?)'
      )
      .run('preserved-session', 'claude-code', '/preserved-agent', '2026-10-07T00:00:00Z');
    if (hasDoc) {
      db.$client
        .prepare(
          'INSERT INTO canvas_doc_channels (document_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run('preserved-document', 'workspace', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z');
      db.$client
        .prepare(
          'INSERT INTO canvas_doc_channel_tokens (token_id, token_hash, document_id, allowed_types, directions, permissions, creator_id, created_at, expires_at, binding_version, document_scope, document_generation, document_birth, document_incarnation, declaration_hash, approved_grant_bindings, issuer_binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          'preserved-token',
          'preserved-hash',
          'preserved-document',
          '[]',
          '[]',
          '[]',
          'preserved-owner',
          '2026-10-07T00:00:00Z',
          '2026-10-09T00:00:00Z',
          1,
          'workspace',
          'generation',
          'birth',
          'incarnation',
          'declaration',
          '[]',
          '{}'
        );
    }
    db.$client
      .prepare(
        `INSERT INTO canvas_doc_grants
    (grant_id, document_id, route_id, normalized_route, route_hash, declaration_hash,
     approved_by, approval_evidence, limits, allowed_types, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'preserved-grant',
        'preserved-document',
        'preserved-route',
        '{}',
        'a'.repeat(64),
        'b'.repeat(64),
        'operator',
        '{}',
        '{}',
        '[]',
        '2026-10-09T00:00:00Z'
      );
    db.$client
      .prepare(
        `INSERT INTO canvas_doc_batches
    (batch_id, document_id, scope, route_id, grant_id, grant_revision, generation,
     input_event_ids, effective_payload, due_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'preserved-batch',
        'preserved-document',
        'workspace',
        'preserved-route',
        'preserved-grant',
        1,
        'generation',
        '[]',
        '{}',
        '2026-10-09T00:00:00Z',
        'turn_started',
        '2026-10-09T00:00:00Z',
        '2026-10-09T00:00:00Z'
      );
    db.$client
      .prepare(
        `INSERT INTO canvas_doc_room_pending_sources
    (document_id, batch_id, generation, source_json, source_hash, due_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'preserved-document',
        'preserved-batch',
        'generation',
        '{"preserved":true}',
        'c'.repeat(64),
        '2026-10-09T00:00:00Z',
        '2026-10-09T00:00:00Z'
      );
    db.$client
      .prepare(
        `INSERT INTO session_started_by
    (session_id, kind, origin_extension_id, created_at) VALUES (?, ?, ?, ?)`
      )
      .run('preserved-start', 'extension', 'preserved-extension', '2026-10-09T00:00:00Z');
  }

  function publishedRoomConnectorDatabase(variant: OldRoomVariant) {
    const dbPath = createOldDatabase();
    const folder = path.join(path.dirname(dbPath), `room-${variant}`);
    mkdirSync(path.join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
    ) as {
      entries: MigrationEntry[];
    };
    const room = variant === 'fresh151' ? publishedRoom151 : publishedRoom;
    const entries = [...journal.entries.slice(0, room.idx), room];
    for (const entry of entries) {
      const archived = entry === room;
      const bytes = readFileSync(
        path.join(DRIZZLE_DIR, archived ? 'legacy-doc' : '', `${entry.tag}.sql`)
      );
      if (archived) expect(createHash('sha256').update(bytes).digest('hex')).toBe(room.hash);
      writeFileSync(path.join(folder, `${entry.tag}.sql`), bytes);
    }
    writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    const raw = new Database(dbPath);
    try {
      migrate(drizzle(raw), { migrationsFolder: folder });
    } finally {
      raw.close();
    }
    const db = createDb(dbPath);
    try {
      seedRecoveryRoomState(db, true);
      if (variant === 'bridged151')
        db.$client.transaction(() => {
          const bytes = readFileSync(path.join(DRIZZLE_DIR, `${reportBack.tag}.sql`));
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(reportBack.hash);
          for (const statement of bytes.toString().split('--> statement-breakpoint')) {
            if (statement.trim()) db.$client.exec(statement);
          }
          db.$client
            .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
            .run(reportBack.hash, reportBack.when);
          db.$client
            .prepare('UPDATE __drizzle_migrations SET created_at=? WHERE hash=? AND created_at=?')
            .run(publishedRoom151.when, publishedRoom.hash, publishedRoom.when);
        })();
      expect(runLegacyConnectionMigration(db)).toEqual({ status: 'ready', migrated: true });
      return { db, dbPath };
    } catch (cause) {
      try {
        db.$client.close();
      } catch {
        // Preserve the original fixture failure when closing the failed connection also throws.
      }
      throw cause;
    }
  }

  const recoveryRoomTables = [
    'canvas_doc_channels',
    'canvas_doc_channel_tokens',
    'canvas_doc_grants',
    'canvas_doc_batches',
    'canvas_doc_room_pending_sources',
    'connector_application_migrations',
    'connections',
    'agent_connection_attachments',
    'session_connection_overrides',
    'connection_operation_grants',
  ] as const;

  it.each(oldRoomVariants)(
    'recovers retired connectors with %s Room receipts preserving native state and row identity',
    (variant) => {
      const { db, dbPath } = publishedRoomConnectorDatabase(variant);
      let reopened: ReturnType<typeof createDb> | undefined;
      let originalOpen = true;
      let failure: { cause: unknown } | undefined;
      try {
        const history = db.$client
          .prepare(
            'SELECT rowid AS rowIdentity,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid'
          )
          .all() as Array<{
          rowIdentity: number;
          id: number | null;
          hash: string;
          created_at: number;
        }>;
        const before = recoveryRoomTables.map((table) => rows(db.$client, table));
        const agents = rows(db.$client, 'agents') as Array<Record<string, unknown>>;
        const start = rows(db.$client, 'session_started_by') as Array<Record<string, unknown>>;
        const oldRoom = history.find((row) => row.hash === publishedRoom.hash)!;
        if (variant !== 'published150') {
          const report = history.find((row) => row.hash === reportBack.hash)!;
          expect(oldRoom.rowIdentity < report.rowIdentity).toBe(variant === 'bridged151');
        }
        reproducePublishedRetirement(db);
        db.$client.close();
        originalOpen = false;
        reopened = createDb(dbPath);
        expect(() => runMigrations(reopened!)).not.toThrow();
        const after = reopened.$client
          .prepare(
            'SELECT rowid AS rowIdentity,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid'
          )
          .all() as typeof history;
        expect(after.slice(0, history.length)).toEqual(history);
        expect(after.filter((row) => row.hash === publishedRoom.hash)).toEqual([oldRoom]);
        const completion = after.filter((row) => row.hash === consolidatedDoc.hash);
        expect(completion).toHaveLength(1);
        expect(completion[0]).toMatchObject({
          id: null,
          hash: consolidatedDoc.hash,
          created_at: consolidatedDoc.when,
        });
        expect(completion[0]!.rowIdentity).toBeGreaterThan(history.at(-1)!.rowIdentity);
        expect(after.filter((row) => row.hash === reportBack.hash)).toHaveLength(1);
        expect(after.filter((row) => row.hash === agentReports.hash)).toHaveLength(1);
        recoveryRoomTables.forEach((table, idx) =>
          expect(rows(reopened!.$client, table)).toEqual(before[idx])
        );
        expect(rows(reopened.$client, 'agents')).toEqual(
          agents.map((agent) => ({ ...agent, reports_to: null, created_by: null }))
        );
        expect(rows(reopened.$client, 'session_started_by')).toEqual(
          start.map((row) => ({ ...row, report_back: 1 }))
        );
        for (const table of [
          'connected_accounts',
          'agent_connector_attachments',
          'session_connector_attachments',
          'connector_legacy_agent_revocations',
        ])
          expect(rows(reopened.$client, table)).toEqual([]);
        expect(
          runLegacyConnectionMigration(reopened, {
            createId: () => {
              throw new Error('Published Room connector identities must not replay');
            },
          })
        ).toEqual({ status: 'ready', migrated: false });
        expect(() => runMigrations(reopened!)).not.toThrow();
        expect(
          reopened.$client
            .prepare(
              'SELECT rowid AS rowIdentity,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid'
            )
            .all()
        ).toEqual(after);
        recoveryRoomTables.forEach((table, idx) =>
          expect(rows(reopened!.$client, table)).toEqual(before[idx])
        );
      } catch (cause) {
        failure = { cause };
      } finally {
        try {
          if (originalOpen) db.$client.close();
        } catch (cause) {
          failure ??= { cause };
        }
        try {
          reopened?.$client.close();
        } catch (cause) {
          failure ??= { cause };
        }
      }
      if (failure) throw failure.cause;
    }
  );

  it.each(
    oldRoomVariants.flatMap((variant) =>
      ['wrong-stamp', 'duplicate-room', 'bridge-fault'].map((fault) => ({ variant, fault }))
    )
  )(
    'refuses or atomically rolls back retired connectors with $variant Room receipt and $fault',
    ({ variant, fault }) => {
      const { db } = publishedRoomConnectorDatabase(variant);
      try {
        reproducePublishedRetirement(db);
        if (fault === 'wrong-stamp')
          db.$client
            .prepare('UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE hash=?')
            .run(publishedRoom.hash);
        if (fault === 'duplicate-room')
          db.$client
            .prepare(
              'INSERT INTO __drizzle_migrations(hash,created_at) SELECT hash,created_at FROM __drizzle_migrations WHERE hash=?'
            )
            .run(publishedRoom.hash);
        if (fault === 'bridge-fault')
          db.$client.exec(
            `CREATE TEMP TRIGGER refuse_room_recovery BEFORE INSERT ON __drizzle_migrations WHEN NEW.hash='${consolidatedDoc.hash}' BEGIN SELECT RAISE(ABORT,'Room recovery bridge rollback'); END`
          );
        const schema = db.$client
          .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
          .all();
        const history = rows(db.$client, '__drizzle_migrations');
        const before = recoveryRoomTables.map((table) => rows(db.$client, table));
        expect(() => runMigrations(db)).toThrow();
        expect(
          db.$client
            .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
            .all()
        ).toEqual(schema);
        expect(rows(db.$client, '__drizzle_migrations')).toEqual(history);
        recoveryRoomTables.forEach((table, idx) =>
          expect(rows(db.$client, table)).toEqual(before[idx])
        );
      } finally {
        db.$client.close();
      }
    }
  );
});
