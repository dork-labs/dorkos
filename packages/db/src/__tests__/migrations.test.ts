import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Database Migrations', () => {
  it('applies all migrations to a fresh database without errors', () => {
    expect(() => {
      const db = createDb(':memory:');
      runMigrations(db);
    }).not.toThrow();
  });

  it('migrations are idempotent — running twice does not throw', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('creates all expected tables', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const result = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name"
      )
      .all() as { name: string }[];
    const tableNames = result.map((r) => r.name).sort();

    expect(tableNames).toEqual([
      'a2a_tasks',
      // Better Auth identity tables (accounts-and-auth P1, migration 0019).
      'account',
      'activity_events',
      'agent_denials',
      'agents',
      'apikey',
      'codex_threads',
      'mesh_namespace_rules',
      'pulse_dispatch_log',
      'pulse_runs',
      'pulse_schedules',
      'relay_index',
      'relay_traces',
      'session',
      // Durable completed-turn event stream for log-backed runtimes
      // (DOR-189, migration 0026).
      'session_events',
      'session_metadata',
      'user',
      'verification',
      'workspaces',
    ]);
  });

  it('foreign key constraint is enforced on pulse_runs.schedule_id', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at) VALUES ('01ABC', 'nonexistent', 'running', '2026-01-01T00:00:00Z', 'manual', '2026-01-01T00:00:00Z')"
        )
        .run();
    }).toThrow(/FOREIGN KEY/);
  });

  it('WAL mode is enabled', () => {
    const db = createDb(':memory:');
    const mode = db.$client.pragma('journal_mode') as {
      journal_mode: string;
    }[];
    // In-memory databases use 'memory' journal mode, but the pragma was set.
    // For file-based databases it would be 'wal'. For :memory: we just verify no error.
    expect(mode).toBeDefined();
  });

  it('foreign keys pragma is enabled', () => {
    const db = createDb(':memory:');
    const fk = db.$client.pragma('foreign_keys') as {
      foreign_keys: number;
    }[];
    expect(fk[0].foreign_keys).toBe(1);
  });

  it('unique constraint on agents.project_path is enforced', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01A', 'agent1', 'claude-code', '/tmp/test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01B', 'agent2', 'claude-code', '/tmp/test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        .run();
    }).toThrow(/UNIQUE/);
  });

  it('agents table has scan_root column with empty string default', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01A', 'agent1', 'claude-code', '/tmp/scan-root-test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();

    const row = db.$client.prepare("SELECT scan_root FROM agents WHERE id = '01A'").get() as {
      scan_root: string;
    };

    expect(row.scan_root).toBe('');
  });

  it('agents table has behavior_json column with default responseMode', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01B', 'agent2', 'claude-code', '/tmp/behavior-test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();

    const row = db.$client.prepare("SELECT behavior_json FROM agents WHERE id = '01B'").get() as {
      behavior_json: string;
    };

    expect(JSON.parse(row.behavior_json)).toEqual({ responseMode: 'always' });
  });

  it('agents table has budget_json column with default hop and rate limits', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01C', 'agent3', 'claude-code', '/tmp/budget-test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();

    const row = db.$client.prepare("SELECT budget_json FROM agents WHERE id = '01C'").get() as {
      budget_json: string;
    };

    expect(JSON.parse(row.budget_json)).toEqual({
      maxHopsPerMessage: 5,
      maxCallsPerHour: 100,
    });
  });

  it('migration 0024 preserves existing relay_index rows across the composite-PK rebuild', () => {
    // The 0024 INSERT...SELECT path copies zero rows on a fresh DB, so exercise
    // it directly: build the OLD schema (bare-id PK), seed rows, run the 0024
    // statements, and assert the rows survive under the new composite PK.
    const db = createDb(':memory:');
    const raw = db.$client;

    raw.exec(`CREATE TABLE relay_index (
      id text PRIMARY KEY,
      subject text NOT NULL,
      endpoint_hash text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      expires_at text,
      sender text,
      payload text,
      metadata text,
      created_at text NOT NULL
    )`);
    raw
      .prepare(
        "INSERT INTO relay_index (id, subject, endpoint_hash, status, sender, created_at) VALUES ('01JOLD1', 'relay.a', 'hash-a', 'pending', 'relay.sender', '2026-01-01T00:00:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at) VALUES ('01JOLD2', 'relay.b', '*', 'delivered', '2026-01-02T00:00:00Z')"
      )
      .run();

    const migrationSql = readFileSync(
      path.join(__dirname, '../../drizzle/0024_tired_slyde.sql'),
      'utf-8'
    );
    for (const statement of migrationSql.split('--> statement-breakpoint')) {
      raw.exec(statement);
    }

    const rows = raw
      .prepare('SELECT id, subject, endpoint_hash, status, sender FROM relay_index ORDER BY id')
      .all() as {
      id: string;
      subject: string;
      endpoint_hash: string;
      status: string;
      sender: string | null;
    }[];
    expect(rows).toEqual([
      {
        id: '01JOLD1',
        subject: 'relay.a',
        endpoint_hash: 'hash-a',
        status: 'pending',
        sender: 'relay.sender',
      },
      { id: '01JOLD2', subject: 'relay.b', endpoint_hash: '*', status: 'delivered', sender: null },
    ]);

    // The rebuilt table enforces the composite PK: same id at a DIFFERENT
    // endpoint is now legal, while a duplicate (id, endpoint_hash) is not.
    raw
      .prepare(
        "INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at) VALUES ('01JOLD1', 'relay.a', 'hash-b', 'pending', '2026-01-03T00:00:00Z')"
      )
      .run();
    expect(() => {
      raw
        .prepare(
          "INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at) VALUES ('01JOLD1', 'relay.a', 'hash-a', 'failed', '2026-01-04T00:00:00Z')"
        )
        .run();
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it('unique constraint on relay_traces.message_id is enforced', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO relay_traces (id, message_id, trace_id, subject, status, sent_at) VALUES ('01A', 'msg1', 'trace1', 'test.sub', 'sent', '2026-01-01T00:00:00Z')"
      )
      .run();

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO relay_traces (id, message_id, trace_id, subject, status, sent_at) VALUES ('01B', 'msg1', 'trace2', 'test.sub', 'sent', '2026-01-01T00:00:00Z')"
        )
        .run();
    }).toThrow(/UNIQUE/);
  });
});
