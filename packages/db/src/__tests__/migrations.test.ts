import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { createDb, runMigrations } from '../index';
import * as schema from '../schema/index';

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

/**
 * Journal index of the last migration BEFORE a workspace could be OWNED
 * (`owner_kind`/`owner_ref`, migration 0082, DOR-1589).
 *
 * A database built through this index is what every existing install is coming
 * from: workspaces that predate ownership entirely, which is why both columns
 * are nullable and NULL means "unit of work" — today's semantics, needing no
 * backfill.
 */
const PRE_WORKSPACE_OWNER_IDX = 81;

/** Last migration before P2 split immutable intents from terminal receipts. */
const PRE_CONNECTOR_EXECUTION_IDX = 86;

/** Shipped main schema after Better Auth account issuers, before P2 execution state. */
const SHIPPED_ACCOUNT_ISSUER_IDX = 87;

/**
 * Last migration BEFORE `account.issuer` was dropped (0112, DOR-2036). Better
 * Auth 1.7.3 stopped writing the column, so every install that ran 0087 holds
 * accounts with an issuer and a NOT NULL column that now fails every sign-up.
 */
const PRE_ACCOUNT_ISSUER_DROP_IDX = 111;

/**
 * Last migration BEFORE the limit history (0120, spec `claude-account-ui`
 * §7.1): an install that may already hold a live `session_limits` row.
 */
const PRE_LIMIT_HISTORY_IDX = 119;

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
  it('migrations are idempotent — running twice does not throw', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('adds draft sources to a database that already has owner sign-in data', () => {
    const db = createDb(':memory:');
    const raw = db.$client;
    try {
      // Journal index 212 is the last migration before draft sources (213); owner
      // sign-in (209) is already in.
      migrate(db, { migrationsFolder: migrationsFolderThrough(212) });
      raw.exec(`
        INSERT INTO "user" (id, name, email, role)
          VALUES ('upgrade-owner', 'Fixture Owner', 'upgrade-owner@example.invalid', 'owner');
        INSERT INTO "session" (id, token, expires_at, updated_at, user_id, route,
                               last_active_at, wifi_agent_turns_at)
          VALUES ('upgrade-sign-in', 'fixture-session-value', 1800000000000, 1795200000000,
                  'upgrade-owner', 'wifi', 1795200000100, 1795200000200);
        INSERT INTO owner_factors (id, user_id, kind, label, confirmed_at)
          VALUES ('upgrade-factor', 'upgrade-owner', 'totp', 'Fixture factor', 1795200000000);
        INSERT INTO session_locations (id, owner_id, cwd, created_at)
          VALUES ('upgrade-location', 'upgrade-owner', '/fixture/project', '2026-11-21T00:00:00Z');
        INSERT INTO session_metadata (session_id, created_at, model, model_launch_state)
          VALUES ('upgrade-chat', '2026-11-21T00:00:00Z', 'fixture-model', 'pending-v1');
      `);

      const existingRows = () => ({
        owner: raw.prepare(`SELECT * FROM "user" WHERE id = 'upgrade-owner'`).get(),
        signIn: raw.prepare(`SELECT * FROM "session" WHERE id = 'upgrade-sign-in'`).get(),
        factor: raw.prepare("SELECT * FROM owner_factors WHERE id = 'upgrade-factor'").get(),
        location: raw
          .prepare("SELECT * FROM session_locations WHERE id = 'upgrade-location'")
          .get(),
        chat: raw.prepare("SELECT * FROM session_metadata WHERE session_id = 'upgrade-chat'").get(),
      });
      const before = existingRows();
      expect(before).toMatchObject({
        owner: { id: 'upgrade-owner', role: 'owner' },
        signIn: {
          route: 'wifi',
          last_active_at: 1795200000100,
          wifi_agent_turns_at: 1795200000200,
        },
        factor: { user_id: 'upgrade-owner', confirmed_at: 1795200000000 },
        location: { owner_id: 'upgrade-owner', cwd: '/fixture/project' },
        chat: { model: 'fixture-model', model_launch_state: 'pending-v1' },
      });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_draft_sources'"
          )
          .get()
      ).toBeUndefined();

      runMigrations(db);

      expect(existingRows()).toEqual(before);
      raw
        .prepare(
          `INSERT INTO session_draft_sources
           (session_id, owner_id, source_kind, location_id, source_path, source_created_at)
           VALUES ('upgrade-chat', 'upgrade-owner', 'person-location', 'upgrade-location',
                   '/fixture/project', '2026-11-21T00:00:00Z')`
        )
        .run();
      expect(
        raw.prepare("SELECT * FROM session_draft_sources WHERE session_id = 'upgrade-chat'").get()
      ).toEqual({
        session_id: 'upgrade-chat',
        owner_id: 'upgrade-owner',
        source_kind: 'person-location',
        location_id: 'upgrade-location',
        registered_agent_id: null,
        source_path: '/fixture/project',
        source_created_at: '2026-11-21T00:00:00Z',
      });
      expect(raw.pragma('foreign_key_check')).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('has exactly the tables and columns the schema declares', () => {
    // The schema is what the app queries; the migrations are what an install
    // actually has. `db:check` compares the schema with drizzle-kit's snapshots,
    // never with the SQL that runs, so a hand-edited migration that drops or
    // misnames a table or column is caught only here.
    const db = createDb(':memory:');
    runMigrations(db);

    const missing: string[] = [];
    const declared = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      const { name, columns } = getTableConfig(value);
      declared.add(name);
      const actual = new Set(
        (db.$client.pragma(`table_info("${name}")`) as Array<{ name: string }>).map((c) => c.name)
      );
      if (actual.size === 0) missing.push(name);
      else
        for (const column of columns)
          if (!actual.has(column.name)) missing.push(`${name}.${column.name}`);
    }
    // Tables the server reads with raw SQL and the schema barrel does not
    // export: message search's FTS5 index (`services/search`) and the three
    // legacy connector tables `legacy-connection-migration.ts` still reads on
    // upgrade (declared in `schema/connected-accounts.ts` and
    // `schema/connector-attachments.ts`, just left out of the barrel).
    const extra = [
      'messages_fts',
      'connected_accounts',
      'agent_connector_attachments',
      'session_connector_attachments',
    ];
    for (const name of extra) {
      const found = db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name);
      if (!found) missing.push(name);
    }
    // And the reverse: a table the migrations leave behind that nothing declares.
    const present = db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    for (const { name } of present) {
      if (/^(sqlite_|__drizzle|messages_fts_)/.test(name)) continue;
      if (!declared.has(name) && !extra.includes(name)) missing.push(`unexpected table: ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('adds the limit history over a database that already holds a live limit (migration 0120)', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_LIMIT_HISTORY_IDX) });
    const raw = db.$client;
    raw
      .prepare(
        "INSERT INTO session_metadata (session_id, runtime, created_at, model) VALUES ('s-1', 'claude-code', '2026-01-01T00:00:00Z', 'opus'), ('s-2', 'claude-code', '2026-01-01T00:00:00Z', NULL)"
      )
      .run();
    for (const id of ['s-1', 's-2', 's-3']) {
      raw
        .prepare(
          "INSERT INTO session_limits (session_id, since, window, scope, plan, state, updated_at) VALUES (?, '2026-01-01T00:00:00Z', 'five_hour', 'account', '{\"mode\":\"ask\"}', 'limited', '2026-01-01T00:00:00Z')"
        )
        .run(id);
    }

    expect(() => runMigrations(db)).not.toThrow();

    // Each live limit takes the session's current model ('' = the runtime's
    // default, and for a session with no settings row), so its next turn does
    // not read a model switch that never happened.
    expect(
      raw.prepare('SELECT session_id, model FROM session_limits ORDER BY session_id').all()
    ).toEqual([
      { session_id: 's-1', model: 'opus' },
      { session_id: 's-2', model: '' },
      { session_id: 's-3', model: '' },
    ]);
    const insert = raw.prepare(
      "INSERT OR IGNORE INTO session_limit_history (id, session_id, since, runtime, window, scope, resolution, resolved_at) VALUES (?, 's-1', '2026-01-01T00:00:00Z', 'claude-code', 'five_hour', 'account', 'moved', '2026-01-01T00:01:00Z')"
    );
    expect(insert.run('a').changes).toBe(1);
    // One row per episode.
    expect(insert.run('b').changes).toBe(0);
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

  it('adds workspace ownership to an install that predates it, without touching its rows', () => {
    // The upgrade path, not the fresh-install one: a workspace row written
    // before ownership existed must survive the migration unchanged and read as
    // unowned. `sweep()` keys its exemption on `owner`, so a row that came out
    // of this the wrong way would either lose its exemption or gain one nobody
    // asked for.
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_WORKSPACE_OWNER_IDX) });
    db.$client
      .prepare(
        `INSERT INTO workspaces
           (id, project_key, key, path, source, branch, provider, status,
            port_base, port_block_size, pinned, created_at, last_used_at)
         VALUES ('ws_legacy', 'core', 'DOR-1', '/r/core/DOR-1', '/r', 'dork/DOR-1',
                 'worktree', 'ready', 4250, 10, 0, '2026-08-01', '2026-08-01')`
      )
      .run();

    runMigrations(db);

    const columns = db.$client.prepare('PRAGMA table_info(workspaces)').all() as {
      name: string;
      notnull: number;
    }[];
    // Both nullable: NULL/NULL is a unit-of-work checkout, which is what every
    // pre-change row is. A NOT NULL column here would have needed a backfill.
    expect(columns.find((c) => c.name === 'owner_kind')?.notnull).toBe(0);
    expect(columns.find((c) => c.name === 'owner_ref')?.notnull).toBe(0);

    const row = db.$client
      .prepare('SELECT key, owner_kind, owner_ref FROM workspaces WHERE id = ?')
      .get('ws_legacy') as { key: string; owner_kind: string | null; owner_ref: string | null };
    expect(row.key).toBe('DOR-1');
    expect(row.owner_kind).toBeNull();
    expect(row.owner_ref).toBeNull();
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

  it('gives pulse_runs the newest-first indexes its two read shapes need (DOR-1482)', () => {
    // Run history is the table that grows without bound — a per-minute task
    // writes ~43k rows a month — and every read of it is newest-first. Both
    // shapes are asserted off the MIGRATED database rather than the schema
    // file, same rationale as the indexes above: the two can disagree.
    const db = createDb(':memory:');
    runMigrations(db);

    const byCreated = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_pulse_runs_created_at') as { sql: string } | undefined;
    expect(byCreated?.sql).toMatch(/created_at.*desc/i);

    const byScheduleCreated = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_pulse_runs_schedule_created_at') as { sql: string } | undefined;
    expect(byScheduleCreated?.sql).toContain('schedule_id');
    expect(byScheduleCreated?.sql).toMatch(/created_at.*desc/i);

    // The planner actually picks them for the two queries that matter:
    // the unfiltered run list (`GET /api/tasks/runs`)…
    const listPlan = db.$client
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM pulse_runs ORDER BY created_at DESC LIMIT 50')
      .all() as { detail: string }[];
    expect(listPlan.some((row) => row.detail.includes('idx_pulse_runs_created_at'))).toBe(true);

    // …and the retention sweep's "newest N for one schedule" (`pruneRuns`),
    // which now runs on an hourly timer rather than once at startup.
    const prunePlan = db.$client
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM pulse_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 100'
      )
      .all('01SCHEDULE') as { detail: string }[];
    expect(prunePlan.some((row) => row.detail.includes('idx_pulse_runs_schedule_created_at'))).toBe(
      true
    );
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
        "INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES ('01ROOM', 'channel', 'backend', '#backend', NULL, 0, '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z')"
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

  it('migration 0088 preserves P1 terminal evidence without inventing missing attribution', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_CONNECTOR_EXECUTION_IDX) });
    const raw = db.$client;
    raw
      .prepare(
        `INSERT INTO connector_provider_instances
          (id, type, mode, display_name, custody, capability_json, status, created_at, updated_at)
         VALUES ('provider-a', 'composio', 'byo', 'Composio', 'managed', '{}', 'available', ?, ?)`
      )
      .run('2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
    raw
      .prepare(
        `INSERT INTO connections
          (id, provider_instance_id, external_account_ref, toolkit, label, status, created_at, updated_at)
         VALUES ('connection-a', 'provider-a', 'private-a', 'gmail', 'Work', 'active', ?, ?)`
      )
      .run('2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
    raw
      .prepare(
        `INSERT INTO connector_operation_revisions
          (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
           capability_classification, input_schema_json, discovered_at)
         VALUES ('revision-a', 'provider-a', 'gmail', 'gmail.list', 'v1', 'hash-a',
                 'read', '{}', ?)`
      )
      .run('2026-09-05T00:00:00.000Z');
    const insertAttempt = raw.prepare(
      `INSERT INTO connector_usage_attempts
        (attempt_id, logical_operation_id, attempt_index, surface, actor_kind, actor_id,
         connection_id, provider_instance_id, provider_type, payer, operation_revision_id,
         outcome, provider_log_id, started_at, completed_at, error_code)
       VALUES (?, ?, ?, 'mcp', 'agent', 'agent-a', 'connection-a', 'provider-a',
               'composio', 'operator_byo', 'revision-a', ?, ?, ?, ?, ?)`
    );
    insertAttempt.run(
      'attempt-success',
      'logical-success',
      0,
      'success',
      'safe-log-a',
      '2026-09-05T00:00:00.000Z',
      '2026-09-05T00:00:01.000Z',
      null
    );
    insertAttempt.run(
      'attempt-legacy-unknown',
      'logical-unknown',
      0,
      'legacy_timeout',
      null,
      '2026-09-05T00:00:02.000Z',
      null,
      'OLD_TIMEOUT'
    );

    runMigrations(db);

    expect(
      raw
        .prepare(
          `SELECT attempt_id, outcome, provider_log_id, error_code, source_outcome, completed_at,
                  recorded_at, provenance
           FROM connector_usage_terminal_receipts ORDER BY attempt_id`
        )
        .all()
    ).toEqual([
      {
        attempt_id: 'attempt-legacy-unknown',
        outcome: 'outcome_unknown',
        provider_log_id: null,
        error_code: 'OLD_TIMEOUT',
        source_outcome: 'legacy_timeout',
        completed_at: null,
        recorded_at: '2026-09-05T00:00:02.000Z',
        provenance: 'migrated_p1',
      },
      {
        attempt_id: 'attempt-success',
        outcome: 'success',
        provider_log_id: 'safe-log-a',
        error_code: null,
        source_outcome: null,
        completed_at: '2026-09-05T00:00:01.000Z',
        recorded_at: '2026-09-05T00:00:01.000Z',
        provenance: 'migrated_p1',
      },
    ]);
    expect(
      raw
        .prepare('SELECT owner_kind, owner_id FROM connector_usage_attempts ORDER BY attempt_id')
        .all()
    ).toEqual([
      { owner_kind: null, owner_id: null },
      { owner_kind: null, owner_id: null },
    ]);
    expect(raw.prepare('SELECT retry_policy FROM connector_operation_revisions').get()).toEqual({
      retry_policy: 'never',
    });
  });

  it('applies the P2 chain after shipped migration 0087 without losing accounts', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(SHIPPED_ACCOUNT_ISSUER_IDX) });
    const raw = db.$client;

    raw
      .prepare(
        `INSERT INTO user
          (id, name, email, email_verified, created_at, updated_at)
         VALUES ('owner-a', 'Owner', 'owner@example.com', 1, 1788700000000, 1788700000000)`
      )
      .run();
    raw
      .prepare(
        `INSERT INTO account
          (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES ('account-a', 'local:credential', 'owner-a', 'credential', 'owner-a',
                 'password-hash', 1788700000000, 1788700000000)`
      )
      .run();
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_runtime_bindings'"
        )
        .get()
    ).toBeUndefined();

    expect(() => runMigrations(db)).not.toThrow();

    expect(
      raw.prepare('SELECT provider_id, account_id FROM account WHERE id = ?').get('account-a')
    ).toEqual({ provider_id: 'credential', account_id: 'owner-a' });
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_runtime_bindings'"
        )
        .get()
    ).toEqual({ name: 'connector_runtime_bindings' });
    expect(
      raw.prepare("SELECT name FROM pragma_table_info('connector_review_requests')").all()
    ).toContainEqual({ name: 'review_context_json' });
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('drops account.issuer and its index, keeping every account and its password', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_ACCOUNT_ISSUER_DROP_IDX) });
    const raw = db.$client;

    raw
      .prepare(
        `INSERT INTO user
          (id, name, email, email_verified, created_at, updated_at)
         VALUES ('owner-a', 'Owner', 'owner@example.com', 1, 1788700000000, 1788700000000)`
      )
      .run();
    raw
      .prepare(
        `INSERT INTO account
          (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES ('account-a', 'local:credential', 'owner-a', 'credential', 'owner-a',
                 'password-hash', 1788700000000, 1788700000000)`
      )
      .run();

    runMigrations(db);

    expect(raw.prepare("SELECT name FROM pragma_table_info('account')").all()).not.toContainEqual({
      name: 'issuer',
    });
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'account_issuer_accountId_unique'"
        )
        .get()
    ).toBeUndefined();
    expect(
      raw
        .prepare('SELECT provider_id, account_id, user_id, password FROM account WHERE id = ?')
        .get('account-a')
    ).toEqual({
      provider_id: 'credential',
      account_id: 'owner-a',
      user_id: 'owner-a',
      password: 'password-hash',
    });
    // The insert Better Auth 1.7.3+ makes: no issuer at all. This is the write
    // that failed every sign-up while the column was NOT NULL.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO account
            (id, account_id, provider_id, user_id, password, created_at, updated_at)
           VALUES ('account-b', 'owner-a-2', 'credential', 'owner-a', 'hash-b',
                   1788700000000, 1788700000000)`
        )
        .run()
    ).not.toThrow();
    // One row per provider-side identity: a second link of the same identity
    // (a racing sign-in) is refused rather than left to lock the person out.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO account
            (id, account_id, provider_id, user_id, created_at, updated_at)
           VALUES ('account-c', 'owner-a-2', 'credential', 'owner-a', 1788700000000, 1788700000000)`
        )
        .run()
    ).toThrow(/UNIQUE/);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('refuses to drop account.issuer over a duplicate identity, changing nothing', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_ACCOUNT_ISSUER_DROP_IDX) });
    const raw = db.$client;
    raw
      .prepare(
        `INSERT INTO user
          (id, name, email, email_verified, created_at, updated_at)
         VALUES ('owner-a', 'Owner', 'owner@example.com', 1, 1788700000000, 1788700000000)`
      )
      .run();
    // Two issuers let the same (provider_id, account_id) in twice under 0087.
    for (const [id, issuer] of [
      ['account-a', 'local:credential'],
      ['account-b', 'local:other'],
    ]) {
      raw
        .prepare(
          `INSERT INTO account
            (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
           VALUES (?, ?, 'owner-a', 'credential', 'owner-a', 1788700000000, 1788700000000)`
        )
        .run(id, issuer);
    }

    expect(() => runMigrations(db)).toThrow(/UNIQUE/);
    expect(raw.prepare("SELECT name FROM pragma_table_info('account')").all()).toContainEqual({
      name: 'issuer',
    });
    expect(raw.prepare('SELECT count(*) AS n FROM account').get()).toEqual({ n: 2 });
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
