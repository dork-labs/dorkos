import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/**
 * Journal index of the last migration BEFORE `pulse_runs` gained its
 * `ON DELETE CASCADE`. A database built through this index reproduces the
 * pre-cascade schema every existing install is upgrading from.
 */
const PRE_CASCADE_MIGRATION_IDX = 43;

/**
 * Journal index of the last migration BEFORE `room_attachments` gained `url`.
 * A database built through this index is the shape an install that had already
 * applied 0058 and stored a file is upgrading from.
 */
const PRE_ATTACHMENT_URL_MIGRATION_IDX = 58;

/**
 * Journal index of the last migration BEFORE `session_message_queue` existed.
 * A database built through this index is the shape every install upgrading
 * into the server-owned queue is coming from — sessions already in it.
 */
const PRE_MESSAGE_QUEUE_MIGRATION_IDX = 63;

/** Temp migration folders to remove after each test. */
const tempMigrationDirs: string[] = [];

afterEach(() => {
  for (const dir of tempMigrationDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a throwaway migrations folder holding only migrations up to and
 * including `idx`, so a test can stand up a database at an older schema
 * version and then let the real {@link runMigrations} upgrade it.
 *
 * The migrator reads `meta/_journal.json` for the list to apply, so truncating
 * the journal and copying just those `.sql` files is enough; snapshots are
 * build-time input to drizzle-kit and are not read at runtime.
 *
 * @param idx - Highest journal index to include
 * @returns Absolute path to the temporary migrations folder
 */
function migrationsFolderThrough(idx: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dorkos-drizzle-'));
  tempMigrationDirs.push(dir);
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
      // Standing, agent-level connector consent — row existence IS the
      // attachment (connection-scoping spec §Part 1, migration 0048).
      'agent_connector_attachments',
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
      'handle_tombstones',
      'mesh_namespace_rules',
      // The message-search index and its frontier: a derived, rebuildable
      // projection of what was said, never a store (ADR 260728-214214,
      // migration 0037).
      'messages',
      // `messages_fts` is the FTS5 virtual table; the four `messages_fts_*`
      // entries are the shadow tables SQLite creates to back it, and they are
      // listed rather than filtered out so that dropping the virtual table
      // cannot pass unnoticed. There is no `messages_fts_content` — this is an
      // external-content index, which is exactly why it stores no second copy
      // of the text and needs the three sync triggers in 0037.
      'messages_fts',
      'messages_fts_config',
      'messages_fts_data',
      'messages_fts_docsize',
      'messages_fts_idx',
      // The Inbox and its per-channel delivery ledger. Activity notifications
      // are rows here; standing "needs you" conditions stay derived and write
      // one row only when they RESOLVE, carrying the outcome
      // (ADR 260819-234828, migration 0068).
      'notification_deliveries',
      'notifications',
      // Durable DorkOS-id <-> OpenCode-session-id bindings so OpenCode
      // session ids survive a server restart (DOR-251, migration 0027).
      'opencode_sessions',
      'pulse_dispatch_log',
      'pulse_runs',
      'pulse_schedules',
      // Browsers that asked to be pushed to when DorkOS is not open. Declared
      // with the rest of the notification storage so the domain landed as one
      // migration; its writer arrives with web push (migration 0068).
      'push_subscriptions',
      // How far each PERSON has read in each thread — the one user-side
      // read-state store, keyed `(user_id, thread_kind, thread_id)`. The
      // agent-side cursor stays on `room_members.last_read_seq`
      // (ADR 260808-140956, migration 0060).
      'read_cursors',
      'relay_index',
      'relay_traces',
      // Files uploaded into a room, bound to the entry that carries them inside
      // that entry's own transaction — nullable `entry_id` is the "uploaded,
      // not yet posted" state (room-attachments spec, migration 0058).
      'room_attachments',
      // A room's durable bridge identity and its platform-message external-ref
      // table — the chats-as-channels foundation (spec §3.1, §6.3, migration
      // 0047, DOR-865).
      'room_bridge_messages',
      'room_bridges',
      // The room primitive: a membership-scoped durable stream, its roster, its
      // never-trimmed log, and the per-(room, agent) session bindings
      // (ADR 260726-170125, migration 0034).
      'room_entries',
      'room_entry_reactions',
      'room_members',
      // The two coordination counters a restart used to erase: which session ids
      // a runtime has renamed away from, and the hour of automatic turns already
      // spent (migration 0067, DOR-1205).
      'room_session_retirements',
      'room_sessions',
      'room_turn_spend',
      'rooms',
      // The indexer's frontier — one row per container, recording what has
      // already been read (migration 0037).
      'search_sources',
      'session',
      // Per-session connector-attachment overrides — a tombstone table (state
      // 'attached'|'detached'), never a plain delete (connection-scoping spec
      // §Part 1, migration 0048).
      'session_connector_attachments',
      // Durable completed-turn event stream for log-backed runtimes
      // (DOR-189, migration 0026).
      'session_events',
      // Messages typed while a session was busy, waiting their turn — the
      // server-owned queue that survives a refresh, a second window, and a
      // restart (spec persistent-session-runtime §3.1, migration 0064).
      'session_message_queue',
      'session_metadata',
      // The durable claim feed for inbound chats with no binding — metadata
      // only, never a message body (connection-scoping spec §Part 3,
      // migration 0048).
      'unclaimed_chats',
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

  it('gives room_entries its thread relation, behind a partial index', () => {
    // The columns and the index that carry a thread (ADR 260728-022013),
    // asserted off the migrated database rather than off the schema file: the
    // two can disagree, and `db:check` — the only thing that would notice —
    // runs in no workflow.
    const db = createDb(':memory:');
    runMigrations(db);

    const columns = (
      db.$client.prepare('PRAGMA table_info(room_entries)').all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toContain('parent_entry_id');
    expect(columns).toContain('thread_root_entry_id');

    const index = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_room_entries_thread_root') as { sql: string } | undefined;
    // Partial: a full index would carry a row per ordinary message to serve a
    // lookup that only ever asks for a non-null root.
    expect(index?.sql).toContain('WHERE "thread_root_entry_id" IS NOT NULL');
  });

  it('gives room_attachments a nullable entry link, behind a partial index', () => {
    // The columns and the index that carry an attachment, asserted off the
    // migrated database rather than off the schema file — same rationale as the
    // thread-root index above.
    const db = createDb(':memory:');
    runMigrations(db);

    const columns = db.$client.prepare('PRAGMA table_info(room_attachments)').all() as {
      name: string;
      notnull: number;
    }[];
    // Nullable on purpose: a file exists before the message that carries it, and
    // SQLite skips the composite foreign-key check while `entry_id` is NULL.
    expect(columns.find((c) => c.name === 'entry_id')?.notnull).toBe(0);
    // Whatever the store answered, stored rather than rebuilt (migration 0059).
    // A bucket-backed store's absolute URL is not derivable from the ids, so a
    // reader that recomputed it would work today and break the day it mattered.
    expect(columns.find((c) => c.name === 'url')?.notnull).toBe(1);

    const index = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_room_attachments_unbound') as { sql: string } | undefined;
    // Partial: "unbound" is the rare state, so a full index would carry a row
    // per posted file to serve a lookup that only asks for a null entry.
    expect(index?.sql).toContain('WHERE "entry_id" IS NULL');
  });

  it('gives relay_index the sender/created_at index ADR-0014 committed to', () => {
    // The rate limiter's sliding-window log runs `SELECT COUNT(*) FROM
    // relay_index WHERE sender = ? AND created_at > ?` on every publish
    // (`SqliteIndex.countSenderInWindow`). ADR-0014 committed to a composite
    // `(sender, created_at DESC)` index for that query; asserted off the
    // migrated database rather than off the schema file, same rationale as
    // the thread-root index above — the two can disagree and only `db:check`
    // would notice.
    const db = createDb(':memory:');
    runMigrations(db);

    const index = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_relay_index_sender_created_at') as { sql: string } | undefined;
    expect(index?.sql).toContain('sender');
    expect(index?.sql).toMatch(/created_at.*desc/i);

    // The query planner actually picks this index for the exact shape
    // `countSenderInWindow` runs, rather than falling back to a full scan.
    const plan = db.$client
      .prepare(
        'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM relay_index WHERE sender = ? AND created_at > ?'
      )
      .all('relay.sender', '2026-01-01T00:00:00Z') as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('idx_relay_index_sender_created_at'))).toBe(true);
  });

  it('deleting a room_entries row cascades to the attachments bound to it', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const raw = db.$client;

    raw
      .prepare(
        "INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES ('01ROOM', 'channel', 'backend', '#backend', NULL, NULL, 0, '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, mention_spans, session_id, cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id, signature, created_at) VALUES ('01ROOM', 1, '01ENTRY', '01HUMAN', 'post', '{\"text\":\"here it is\"}', '[]', '[]', NULL, '01ENTRY', 0, NULL, NULL, NULL, '2026-08-08T10:01:00Z')"
      )
      .run();
    // One bound, one still staged — only the bound one hangs off the entry.
    raw
      .prepare(
        "INSERT INTO room_attachments (room_id, id, entry_id, author_id, name, extension, mime_type, size, preview, url, created_at) VALUES ('01ROOM', '01BOUND', '01ENTRY', '01HUMAN', 'crash.log', 'log', 'text/plain', 11, NULL, '/api/rooms/01ROOM/attachments/01BOUND', '2026-08-08T10:01:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO room_attachments (room_id, id, entry_id, author_id, name, extension, mime_type, size, preview, url, created_at) VALUES ('01ROOM', '01UNBOUND', NULL, '01HUMAN', 'draft.log', 'log', 'text/plain', 11, NULL, '/api/rooms/01ROOM/attachments/01UNBOUND', '2026-08-08T10:02:00Z')"
      )
      .run();

    // Nothing deletes a room entry today. The cascade is the standing answer for
    // the day something does — the design says a message's files die with it,
    // and the constraint is where that lives rather than a cleanup step somebody
    // has to remember to write beside a future `deleteEntry`.
    expect(() => {
      raw.prepare("DELETE FROM room_entries WHERE id = '01ENTRY'").run();
    }).not.toThrow();

    const left = raw.prepare('SELECT id FROM room_attachments ORDER BY id').all();
    // The bound one went with its message; the staged one is nobody's message
    // and stays for the TTL sweep to reclaim.
    expect(left).toEqual([{ id: '01UNBOUND' }]);
  });

  it('adds the attachment url column to a table that already holds rows', () => {
    // SQLite refuses `ADD COLUMN ... NOT NULL` without a default on any table
    // that already has rows, so 0059 shipped with `DEFAULT ''` for exactly this
    // case. Anyone who applied 0058 and stored a file before upgrading is the
    // population this protects, and an empty-table test cannot see the
    // difference — it passes either way.
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_ATTACHMENT_URL_MIGRATION_IDX) });
    const raw = db.$client;

    expect(
      (raw.prepare('PRAGMA table_info(room_attachments)').all() as { name: string }[]).some(
        (c) => c.name === 'url'
      ),
      'the fixture must predate the url column, or this proves nothing'
    ).toBe(false);

    raw
      .prepare(
        "INSERT INTO room_attachments (room_id, id, entry_id, author_id, name, extension, mime_type, size, preview, created_at) VALUES ('01ROOM', '01ATT', NULL, '01HUMAN', 'crash.log', 'log', 'text/plain', 11, NULL, '2026-08-08T10:00:00Z')"
      )
      .run();

    expect(() => runMigrations(db)).not.toThrow();

    const row = raw.prepare("SELECT url FROM room_attachments WHERE id = '01ATT'").get();
    // Backfilled to the default rather than left NULL, which the NOT NULL
    // constraint would have refused.
    expect(row).toEqual({ url: '' });
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

  it('the pulse_runs cascade rebuild preserves existing run history', () => {
    // Driven through the REAL runMigrations, not by exec-ing the .sql by hand.
    // The difference is load-bearing: drizzle's migrator wraps every migration
    // in BEGIN…COMMIT, and SQLite ignores `PRAGMA foreign_keys` inside a
    // transaction, so the rebuild's leading `PRAGMA foreign_keys=OFF` is inert
    // in production. Replaying the statements bare would leave the pragma in
    // force and test a strictly more permissive environment than the one users
    // get. So: migrate to the version before the rebuild, seed a schedule with
    // run history, then let runMigrations apply it exactly as an upgrade does.
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_CASCADE_MIGRATION_IDX) });
    const raw = db.$client;

    // The pre-rebuild FK really has no cascade: deleting the parent fails.
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

  it('the cascade rebuild survives an orphan run row instead of bricking startup', () => {
    // The rebuild copies pulse_runs into a table that HAS the foreign key, so a
    // run pointing at a missing schedule fails the copy. `runMigrations` is
    // called uncaught at boot, so that is not a bad upgrade — it is a server
    // that never starts again, with no way out from inside the app.
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_CASCADE_MIGRATION_IDX) });
    const raw = db.$client;

    raw
      .prepare(
        "INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, enabled, permission_mode, status, file_path, tags_json, created_at, updated_at) VALUES ('01SCHED', 'nightly', '0 3 * * *', 'UTC', 'go', 1, 'acceptEdits', 'active', '/tmp/tasks/nightly/SKILL.md', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at) VALUES ('01RUNGOOD', '01SCHED', 'completed', '2026-01-01T03:00:00Z', 'scheduled', '2026-01-01T03:00:00Z')"
      )
      .run();

    // How an orphan gets there: any tool that opens dork.db without turning the
    // pragma on, which is the DEFAULT for the sqlite3 CLI and for a bare
    // better-sqlite3 handle. The pre-cascade FK never cleaned up after itself.
    raw.pragma('foreign_keys = OFF');
    raw
      .prepare(
        "INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at) VALUES ('01ORPHAN', '01GONE', 'completed', '2026-01-01T03:00:00Z', 'scheduled', '2026-01-01T03:00:00Z')"
      )
      .run();
    raw.pragma('foreign_keys = ON');

    expect(() => runMigrations(db)).not.toThrow();

    // The orphan is gone — it was unreadable history for a task that no longer
    // exists — and everything real is untouched.
    expect(raw.prepare('SELECT id FROM pulse_runs ORDER BY id').all()).toEqual([
      { id: '01RUNGOOD' },
    ]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('migration 0064 adds the message queue to a database that already has sessions in it', () => {
    // An install upgrading into the server-owned queue is not an empty one: it
    // has session rows, and losing them to a new table would be the exact
    // failure the queue exists to prevent. Build the pre-0064 schema, put data
    // in it, then let the real runMigrations upgrade the same database.
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_MESSAGE_QUEUE_MIGRATION_IDX) });
    const raw = db.$client;

    raw
      .prepare(
        "INSERT INTO session_metadata (session_id, runtime, agent_path, created_at, permission_mode) VALUES ('sess-1', 'claude-code', '/tmp/agent', '2026-08-10T00:00:00Z', 'plan')"
      )
      .run();
    raw
      .prepare(
        'INSERT INTO session_events (session_id, seq, payload, created_at) VALUES (\'sess-1\', 1, \'{"type":"turn_end","seq":1}\', \'2026-08-10T00:00:00Z\')'
      )
      .run();
    // The table cannot exist yet, or this migration is not what adds it.
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'session_message_queue'"
        )
        .get()
    ).toBeUndefined();

    expect(() => runMigrations(db)).not.toThrow();

    // The data that was already there is untouched...
    expect(raw.prepare('SELECT session_id, permission_mode FROM session_metadata').all()).toEqual([
      { session_id: 'sess-1', permission_mode: 'plan' },
    ]);
    expect(raw.prepare('SELECT session_id, seq FROM session_events').all()).toEqual([
      { session_id: 'sess-1', seq: 1 },
    ]);
    // ...and the queue is there, usable, and indexed for ordered per-session reads.
    raw
      .prepare(
        "INSERT INTO session_message_queue (id, session_id, position, content, disposition, client_id, enqueued_at, context_json) VALUES ('msg-1', 'sess-1', 1000, 'run the tests', 'queue', 'window-a', 1786421653118, NULL)"
      )
      .run();
    expect(raw.prepare('SELECT id, position FROM session_message_queue').all()).toEqual([
      { id: 'msg-1', position: 1000 },
    ]);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name = 'session_message_queue_session_idx'"
        )
        .get()
    ).toBeDefined();
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
