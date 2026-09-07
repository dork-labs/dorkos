import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import {
  CONNECTOR_FOUNDATION_MIGRATION_VERSION,
  runLegacyConnectionMigration,
} from '../legacy-connection-migration.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(dirname, '../../../../../../packages/db/drizzle');
const MIGRATION_INDEX = 86;
const MIGRATION_TAG = '0086_perfect_whiplash';
const temporaryDirectories: string[] = [];

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
        'Connector data could not be upgraded. Connector changes are unavailable; restart DorkOS to retry.',
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
        'Connector data could not be upgraded. Connector changes are unavailable; restart DorkOS to retry.',
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
      ].some((table) => hasTable(db.$client, table))
    ).toBe(false);
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
    expect(hasTable(db.$client, 'agent_connector_attachments')).toBe(false);
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

  it('rolls legacy-table retirement back with the backfill and completion ledger', () => {
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

  it('retires leftover legacy tables on a later boot without rereading them', () => {
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
      ].some((table) => hasTable(db.$client, table))
    ).toBe(false);
    expect(rows(db.$client, 'connections')).toEqual([]);
    db.$client.close();
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
});
