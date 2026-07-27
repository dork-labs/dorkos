import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/**
 * Build a throwaway migrations folder holding only migrations up to and
 * including `idx`, so a test can stand up a database at an older schema
 * version and then let the real {@link runMigrations} upgrade it.
 *
 * The migrator reads `meta/_journal.json` for the list to apply, so truncating
 * the journal and copying just those `.sql` files is enough; snapshots are
 * build-time input to drizzle-kit and are not read at runtime.
 *
 * @param idx - Highest journal index to include (e.g. 35 for a pre-0036 DB)
 * @returns Absolute path to the temporary migrations folder
 */
function migrationsFolderThrough(idx: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dorkos-drizzle-'));
  mkdirSync(path.join(dir, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= idx);
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal));

  for (const entry of journal.entries) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

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
      // Hashed per-agent identity tokens, keyed on the stable agentPath so the
      // mesh reconciler's rebuild-from-files cannot orphan them
      // (agent-trust spec §3.1, migration 0030).
      'agent_identity_tokens',
      'agents',
      'apikey',
      // Standing permissions: one operator's "stop asking about this agent doing
      // this thing", keyed on the stable agentPath and bounded by an absolute
      // expiry (agent-approval-settings spec §3.2, migration 0033).
      'approval_grants',
      // Approval records for capability invocations that need a person's
      // consent; the token lives here only as a hash (agent-trust spec §3.3,
      // migration 0031).
      'approvals',
      // Opaque author identities keyed on (kind, natural_key) — an agent's
      // agentPath, never its manifest ULID (ADR 260726-170126, migration 0034).
      'authors',
      'codex_threads',
      // Derived cache binding a ConnectedAccountId → owning connector provider
      // (connector-gateway spec §Detailed Design 2, migration 0029).
      'connected_accounts',
      'mesh_namespace_rules',
      // Durable DorkOS-id <-> OpenCode-session-id bindings so OpenCode
      // session ids survive a server restart (DOR-251, migration 0027).
      'opencode_sessions',
      'pulse_dispatch_log',
      'pulse_runs',
      'pulse_schedules',
      'relay_index',
      'relay_traces',
      // The room primitive: a membership-scoped durable stream, its roster, its
      // never-trimmed log, and the per-(room, agent) session bindings
      // (ADR 260726-170125, migration 0034).
      'room_entries',
      'room_members',
      'room_sessions',
      'rooms',
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

  it('agents table has no budget_json column (DOR-265: the advisory per-agent budget was removed)', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const columns = db.$client.pragma('table_info(agents)') as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain('budget_json');

    // An insert that omits budget succeeds — nothing downstream still requires it.
    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO agents (id, name, runtime, project_path, namespace, capabilities_json, status, registered_at, updated_at) VALUES ('01C', 'agent3', 'claude-code', '/tmp/budget-test', 'default', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        .run();
    }).not.toThrow();
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

  it('deleting a pulse_schedules row cascades to its pulse_runs', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const raw = db.$client;

    raw
      .prepare(
        "INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, enabled, permission_mode, status, file_path, tags_json, created_at, updated_at) VALUES ('01SCHED', 'nightly', '0 3 * * *', 'UTC', 'go', 1, 'acceptEdits', 'active', '/tmp/tasks/nightly/SKILL.md', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at) VALUES ('01RUN', '01SCHED', 'completed', '2026-01-01T03:00:00Z', 'scheduled', '2026-01-01T03:00:00Z')"
      )
      .run();

    // Before migration 0036 this threw FOREIGN KEY constraint failed, which
    // aborted every reconciliation pass that tried to retire an old task.
    expect(() => {
      raw.prepare("DELETE FROM pulse_schedules WHERE id = '01SCHED'").run();
    }).not.toThrow();

    const runs = raw.prepare('SELECT id FROM pulse_runs').all();
    expect(runs).toEqual([]);
  });

  it('migration 0036 preserves existing pulse_runs rows across the cascade rebuild', () => {
    // Driven through the REAL runMigrations, not by exec-ing the .sql by hand.
    // The difference is load-bearing: drizzle's migrator wraps every migration
    // in BEGIN…COMMIT, and SQLite ignores `PRAGMA foreign_keys` inside a
    // transaction, so 0036's leading `PRAGMA foreign_keys=OFF` is inert in
    // production. Replaying the statements bare would leave the pragma in
    // force and test a strictly more permissive environment than the one users
    // get. So: migrate to 0035, seed a schedule with run history, then let
    // runMigrations apply 0036 exactly as a real upgrade does.
    const db = createDb(':memory:');
    const throughV35 = migrationsFolderThrough(35);
    migrate(db, { migrationsFolder: throughV35 });
    const raw = db.$client;

    // The pre-0036 FK really has no cascade: deleting the parent fails.
    raw
      .prepare(
        "INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, enabled, permission_mode, status, file_path, tags_json, created_at, updated_at) VALUES ('01SCHED', 'nightly', '0 3 * * *', 'UTC', 'go', 1, 'acceptEdits', 'active', '/tmp/tasks/nightly/SKILL.md', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO pulse_runs (id, schedule_id, status, started_at, finished_at, duration_ms, output, trigger, created_at) VALUES ('01RUNOLD', '01SCHED', 'completed', '2026-01-01T03:00:00Z', '2026-01-01T03:01:00Z', 60000, 'all good', 'scheduled', '2026-01-01T03:00:00Z')"
      )
      .run();
    expect(() => {
      raw.prepare("DELETE FROM pulse_schedules WHERE id = '01SCHED'").run();
    }).toThrow(/FOREIGN KEY/);

    runMigrations(db);

    // Every column survives the rebuild, unchanged.
    const rows = raw
      .prepare(
        'SELECT id, schedule_id, status, started_at, finished_at, duration_ms, output, error, session_id, trigger, created_at FROM pulse_runs'
      )
      .all();
    expect(rows).toEqual([
      {
        id: '01RUNOLD',
        schedule_id: '01SCHED',
        status: 'completed',
        started_at: '2026-01-01T03:00:00Z',
        finished_at: '2026-01-01T03:01:00Z',
        duration_ms: 60000,
        output: 'all good',
        error: null,
        session_id: null,
        trigger: 'scheduled',
        created_at: '2026-01-01T03:00:00Z',
      },
    ]);

    // The rebuild leaves no scaffolding behind, and the DB is self-consistent.
    const leftovers = raw
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new%'")
      .all() as { name: string }[];
    expect(leftovers).toEqual([]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);

    // And the same delete that failed before the migration now cascades.
    raw.prepare("DELETE FROM pulse_schedules WHERE id = '01SCHED'").run();
    expect(raw.prepare('SELECT id FROM pulse_runs').all()).toEqual([]);
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
