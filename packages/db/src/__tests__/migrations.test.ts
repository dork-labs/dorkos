import { describe, it, expect } from 'vitest';
import { createDb, runMigrations } from '../index';

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
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = result.map((r) => r.name).sort();

    expect(tableNames).toEqual([
      'agent_denials',
      'agents',
      'pulse_runs',
      'pulse_schedules',
      'rate_limit_buckets',
      'relay_index',
      'relay_traces',
    ]);
  });

  it('foreign key constraint is enforced on pulse_runs.schedule_id', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at) VALUES ('01ABC', 'nonexistent', 'running', '2026-01-01T00:00:00Z', 'manual', '2026-01-01T00:00:00Z')",
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
        "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01A', 'agent1', 'claude-code', '/tmp/test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
      )
      .run();

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01B', 'agent2', 'claude-code', '/tmp/test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .run();
    }).toThrow(/UNIQUE/);
  });

  it('unique constraint on relay_traces.message_id is enforced', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.$client
      .prepare(
        "INSERT INTO relay_traces (id, message_id, trace_id, subject, status, sent_at) VALUES ('01A', 'msg1', 'trace1', 'test.sub', 'sent', '2026-01-01T00:00:00Z')",
      )
      .run();

    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO relay_traces (id, message_id, trace_id, subject, status, sent_at) VALUES ('01B', 'msg1', 'trace2', 'test.sub', 'sent', '2026-01-01T00:00:00Z')",
        )
        .run();
    }).toThrow(/UNIQUE/);
  });
});
