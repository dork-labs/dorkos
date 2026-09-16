/**
 * @vitest-environment node
 */
import { PGlite } from '@electric-sql/pglite';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import controlPlaneConfig from '../../../drizzle.control-plane.config';
import publicConfig from '../../../drizzle.public.config';
import {
  FROZEN_HISTORY,
  MIGRATION_HISTORIES,
  markBaselineApplied,
  readBaselineRow,
  type MigrationHistory,
  type SqlExecutor,
} from '../../../scripts/migration-histories';

// Every case boots its own PGlite and replays a migration history into it,
// because the pre-migration states under test are the point — a shared fixture
// would have nothing left to prove. That costs seconds per case on an idle box
// and more on a busy one; same budget rationale as account-issuer-migration.test.ts.
vi.setConfig({ testTimeout: 60_000 });

const PUBLIC = MIGRATION_HISTORIES.find((h) => h.id === 'public')!;
const CONTROL_PLANE = MIGRATION_HISTORIES.find((h) => h.id === 'control-plane')!;

type Db = PgliteDatabase<Record<string, never>>;

/** Render a drizzle `SQL` fragment as the text a driver would send. */
const pgDialect = new PgDialect();
function sqlToText(query: SQL): string {
  return pgDialect.sqlToQuery(query).sql;
}

/** A fresh empty PGlite database with a drizzle handle over it. */
function freshDatabase(): { client: PGlite; db: Db } {
  const client = new PGlite();
  return { client, db: drizzle(client) as Db };
}

/** Apply one history's migrations, honoring its own journal table. */
async function applyHistory(db: Db, history: MigrationHistory): Promise<void> {
  await migrate(db, {
    migrationsFolder: history.folder,
    migrationsTable: history.migrationsTable,
    migrationsSchema: history.migrationsSchema,
  });
}

/** Apply the frozen pre-split history — how the live database was actually built. */
async function applyFrozenHistory(db: Db): Promise<void> {
  await migrate(db, {
    migrationsFolder: FROZEN_HISTORY.folder,
    migrationsTable: FROZEN_HISTORY.migrationsTable,
    migrationsSchema: FROZEN_HISTORY.migrationsSchema,
  });
}

/** Every base table in the `public` schema, sorted. */
async function tableNames(client: PGlite): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  return result.rows.map((r) => r.tablename);
}

/** Rows of a journal table, or `null` when the table does not exist. */
async function journalRows(
  client: PGlite,
  schema: string,
  table: string
): Promise<{ hash: string; created_at: string | number | bigint }[] | null> {
  const exists = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = $1 AND c.relname = $2`,
    [schema, table]
  );
  if (!exists.rows[0] || exists.rows[0].n === 0) return null;
  const rows = await client.query<{ hash: string; created_at: string | number | bigint }>(
    `SELECT hash, created_at FROM "${schema}"."${table}" ORDER BY created_at`
  );
  return rows.rows;
}

describe('the two migration histories', () => {
  let frozenTables: string[];
  let publicTables: string[];
  let controlPlaneTables: string[];

  beforeAll(async () => {
    const frozen = freshDatabase();
    await applyFrozenHistory(frozen.db);
    frozenTables = await tableNames(frozen.client);
    await frozen.client.close();

    const pub = freshDatabase();
    await applyHistory(pub.db, PUBLIC);
    publicTables = await tableNames(pub.client);
    await pub.client.close();

    const cp = freshDatabase();
    await applyHistory(cp.db, CONTROL_PLANE);
    controlPlaneTables = await tableNames(cp.client);
    await cp.client.close();
  }, 120_000);

  it('puts exactly the four agreed tables in the public half', () => {
    expect(publicTables).toEqual([
      'feedback_submission',
      'instance_heartbeats',
      'marketplace_install_events',
      'newsletter_subscriber',
    ]);
  });

  it('keeps instance_heartbeats public and free of foreign keys', async () => {
    const { client, db } = freshDatabase();
    await applyHistory(db, PUBLIC);
    const fks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND conrelid = 'instance_heartbeats'::regclass`
    );
    expect(fks.rows).toEqual([]);
    await client.close();
  });

  it('reproduces the frozen history exactly — every column, constraint and index', async () => {
    // Table names alone would not catch a lost default, a dropped index or a
    // weakened foreign key, and those are the failures that only surface in
    // production. Compare the whole end state instead.
    const catalogue = {
      columns: `SELECT table_name, column_name, data_type, is_nullable, column_default,
                       character_maximum_length, numeric_precision
                FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`,
      constraints: `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
                    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2, 3`,
      indexes: `SELECT tablename, indexname, indexdef FROM pg_indexes
                WHERE schemaname = 'public' ORDER BY 1, 2`,
    } as const;

    /** Dump the three catalogue views after applying the given histories. */
    async function endState(apply: (db: Db) => Promise<void>): Promise<Record<string, unknown[]>> {
      const { client, db } = freshDatabase();
      await apply(db);
      const dump: Record<string, unknown[]> = {};
      for (const [name, query] of Object.entries(catalogue)) {
        dump[name] = (await client.query(query)).rows;
      }
      await client.close();
      return dump;
    }

    const frozen = await endState(applyFrozenHistory);
    const split = await endState(async (db) => {
      await applyHistory(db, PUBLIC);
      await applyHistory(db, CONTROL_PLANE);
    });

    expect(split.columns).toEqual(frozen.columns);
    expect(split.constraints).toEqual(frozen.constraints);
    expect(split.indexes).toEqual(frozen.indexes);
    // Guard against the comparison silently going vacuous.
    expect(frozen.columns.length).toBeGreaterThan(300);
    expect(frozen.constraints.length).toBeGreaterThan(300);
    expect(frozen.indexes.length).toBeGreaterThan(60);
  }, 120_000);

  it('splits the frozen history into two disjoint halves that together lose nothing', () => {
    const overlap = publicTables.filter((t) => controlPlaneTables.includes(t));
    expect(overlap).toEqual([]);
    expect([...publicTables, ...controlPlaneTables].sort()).toEqual(frozenTables);
  });

  it('applies both histories to one fresh database, into two separate journals', async () => {
    const { client, db } = freshDatabase();
    await applyHistory(db, PUBLIC);
    await applyHistory(db, CONTROL_PLANE);

    expect(await tableNames(client)).toEqual(frozenTables);

    // The whole point of the explicit `migrations.table`: each half has its own
    // journal, and the drizzle DEFAULT journal is never touched.
    const publicJournal = await journalRows(client, 'drizzle', PUBLIC.migrationsTable);
    const controlPlaneJournal = await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable);
    expect(publicJournal).toHaveLength(1);
    expect(controlPlaneJournal).toHaveLength(1);
    expect(publicJournal![0].hash).toBe(readBaselineRow(PUBLIC).hash);
    expect(controlPlaneJournal![0].hash).toBe(readBaselineRow(CONTROL_PLANE).hash);
    expect(publicJournal![0].hash).not.toBe(controlPlaneJournal![0].hash);
    expect(await journalRows(client, 'drizzle', '__drizzle_migrations')).toBeNull();

    await client.close();
  });

  it('is a no-op on a fresh database — nothing to mark before the baselines run', async () => {
    const { client, db } = freshDatabase();
    expect(await markBaselineApplied(db, PUBLIC)).toBe('fresh-database');
    expect(await markBaselineApplied(db, CONTROL_PLANE)).toBe('fresh-database');
    // And the baselines still apply normally afterwards.
    await applyHistory(db, PUBLIC);
    await applyHistory(db, CONTROL_PLANE);
    expect(await tableNames(client)).toEqual(frozenTables);
    await client.close();
  });

  it('re-running both histories changes nothing', async () => {
    const { client, db } = freshDatabase();
    await applyHistory(db, PUBLIC);
    await applyHistory(db, CONTROL_PLANE);
    await applyHistory(db, PUBLIC);
    await applyHistory(db, CONTROL_PLANE);
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    expect(await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable)).toHaveLength(1);
    await client.close();
  });

  it('agrees with what the two drizzle configs declare', () => {
    expect(publicConfig.migrations).toEqual({
      table: PUBLIC.migrationsTable,
      schema: PUBLIC.migrationsSchema,
    });
    expect(controlPlaneConfig.migrations).toEqual({
      table: CONTROL_PLANE.migrationsTable,
      schema: CONTROL_PLANE.migrationsSchema,
    });
    expect(publicConfig.out).toBe('./drizzle-public');
    expect(controlPlaneConfig.out).toBe('./drizzle-control-plane');
    expect(publicConfig.schema).toBe('./src/db/public-schema.ts');
    expect(controlPlaneConfig.schema).toBe('./src/db/control-plane-schema.ts');
    // Neither may fall back to the drizzle default, which the frozen history owns.
    expect(publicConfig.migrations?.table).not.toBe(FROZEN_HISTORY.migrationsTable);
    expect(controlPlaneConfig.migrations?.table).not.toBe(FROZEN_HISTORY.migrationsTable);
    expect(publicConfig.migrations?.table).not.toBe(controlPlaneConfig.migrations?.table);
  });
});

// The production case. "A database where the tables already exist" is not
// hypothetical here — it is a database built by the frozen 17-migration history,
// which is exactly what the live one is. Everything below seeds from that.
describe('adopting the split on a database built by the frozen history', () => {
  /** A PGlite database in the pre-split production shape, with rows in it. */
  async function seededFromFrozenHistory(): Promise<{ client: PGlite; db: Db }> {
    const { client, db } = freshDatabase();
    await applyFrozenHistory(db);
    // Rows on both sides of the split. If any baseline DDL were to run, these
    // would be gone (or the run would fail) — that is what makes them the check.
    await client.exec(`
      INSERT INTO "user" ("id", "name", "email") VALUES ('u1', 'Ada', 'ada@example.test');
      INSERT INTO "newsletter_subscriber" ("id", "email") VALUES ('n1', 'ada@example.test');
      INSERT INTO "instance_heartbeats"
        ("instance_id", "dorkos_version", "os", "runtimes_configured", "tunnel_enabled",
         "cloud_linked", "count_agents", "count_tasks", "count_relay_adapters")
      VALUES ('11111111-1111-1111-1111-111111111111', '0.56.0', 'darwin-arm64',
              ARRAY['claude-code'], false, false, 1, 0, 0);
    `);
    return { client, db };
  }

  it('WITHOUT the baseline mark, applying a history destroys the database', async () => {
    const { client, db } = await seededFromFrozenHistory();
    // This is the failure the mark exists to prevent, demonstrated rather than
    // asserted: the baseline is pure CREATE TABLE against tables that are there.
    // Drizzle wraps the driver error, so the relation-already-exists detail is on
    // the cause; the wrapper names the statement that broke, which is the point.
    await expect(applyHistory(db, CONTROL_PLANE)).rejects.toThrow(
      /Failed query: CREATE TABLE "account"/
    );
    await expect(applyHistory(db, PUBLIC)).rejects.toThrow(
      /Failed query: CREATE TABLE "feedback_submission"/
    );
    await client.close();
  });

  it('marks each baseline applied and then migrates without running any DDL', async () => {
    const { client, db } = await seededFromFrozenHistory();

    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    expect(await markBaselineApplied(db, CONTROL_PLANE)).toBe('marked-applied');

    // The row written is the row `readBaselineRow` describes. That
    // `readBaselineRow` describes what the MIGRATOR writes is the separate, and
    // load-bearing, assertion in 'applies both histories to one fresh database' —
    // there the row being compared was written by drizzle itself.
    for (const history of [PUBLIC, CONTROL_PLANE]) {
      const expected = readBaselineRow(history);
      const rows = await journalRows(client, 'drizzle', history.migrationsTable);
      expect(rows).toHaveLength(1);
      expect(rows![0].hash).toBe(expected.hash);
      expect(Number(rows![0].created_at)).toBe(expected.createdAt);
    }

    // Which is why this now succeeds where the previous case threw.
    await applyHistory(db, PUBLIC);
    await applyHistory(db, CONTROL_PLANE);

    // Still one row per journal: the baselines were skipped, not replayed.
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    expect(await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable)).toHaveLength(1);

    // The frozen journal is untouched — all 17 of its rows still there.
    const frozenJournal = await journalRows(client, 'drizzle', FROZEN_HISTORY.migrationsTable);
    expect(frozenJournal).toHaveLength(17);

    // And the data on both sides of the split survived.
    const users = await client.query<{ id: string }>(`SELECT id FROM "user"`);
    expect(users.rows).toEqual([{ id: 'u1' }]);
    const subscribers = await client.query<{ email: string }>(
      `SELECT email FROM "newsletter_subscriber"`
    );
    expect(subscribers.rows).toEqual([{ email: 'ada@example.test' }]);
    const heartbeats = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "instance_heartbeats"`
    );
    expect(heartbeats.rows[0].n).toBe(1);

    await client.close();
  });

  it('is idempotent — a second pass marks nothing', async () => {
    const { client, db } = await seededFromFrozenHistory();
    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    expect(await markBaselineApplied(db, PUBLIC)).toBe('already-tracked');
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    await client.close();
  });

  it('marking one history leaves the other history and the frozen journal alone', async () => {
    const { client, db } = await seededFromFrozenHistory();
    // Assert the mark HAPPENED before asserting what it did not touch: without
    // this line every expectation below is also true of doing nothing at all.
    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    // `journalRows` returns null for a table that does not exist — and the
    // control-plane journal does not, because only the public history was marked.
    expect(await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable)).toBeNull();
    expect(await journalRows(client, 'drizzle', FROZEN_HISTORY.migrationsTable)).toHaveLength(17);
    await client.close();
  });

  it('refuses to baseline a half-built database rather than skipping the gap', async () => {
    const { client, db } = await seededFromFrozenHistory();
    // One table of the control-plane baseline's 22 is missing. Marking the
    // baseline applied here would tell the migrator to skip creating it, the
    // build would exit 0, and the gap would surface as a query failure in
    // production. Refusing is the only safe answer.
    await client.exec(`DROP TABLE "audit_log"`);
    await expect(markBaselineApplied(db, CONTROL_PLANE)).rejects.toThrow(
      /refusing to baseline a half-built database[\s\S]*audit_log/
    );
    // Nothing was written, so a later run on a repaired database still works.
    expect(await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable)).toHaveLength(0);
    // The other half is unaffected and still marks cleanly.
    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    await client.close();
  });

  // The lock is transaction-scoped so that it cannot outlive the call. A
  // session-scoped one is released by an unlock on the connection that took it,
  // and under a pooled driver that unlock can land on a DIFFERENT connection —
  // stranding the lock until the first is closed, and deadlocking every later
  // build against this journal.
  //
  // PGlite is one in-process connection, so it cannot reproduce that split and
  // the two `pg_locks` cases below prove only the weaker "something releases the
  // lock". The case after them is the one that pins the mechanism, by reading the
  // SQL actually issued.
  /** Advisory locks currently held anywhere in the database. */
  async function heldAdvisoryLocks(client: PGlite): Promise<unknown[]> {
    const rows = await client.query(
      `SELECT classid, objid FROM pg_locks WHERE locktype = 'advisory' AND granted`
    );
    return rows.rows;
  }

  it('holds no advisory lock once it has returned', async () => {
    const { client, db } = await seededFromFrozenHistory();
    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    expect(await heldAdvisoryLocks(client)).toEqual([]);
    await client.close();
  });

  it('holds no advisory lock after it refuses a half-built database', async () => {
    const { client, db } = await seededFromFrozenHistory();
    await client.exec(`DROP TABLE "audit_log"`);
    await expect(markBaselineApplied(db, CONTROL_PLANE)).rejects.toThrow(/half-built/);
    expect(await heldAdvisoryLocks(client)).toEqual([]);
    expect(await journalRows(client, 'drizzle', CONTROL_PLANE.migrationsTable)).toHaveLength(0);
    await client.close();
  });

  it('takes a transaction-scoped lock inside a transaction and never unlocks by hand', async () => {
    // The discriminating case. Both alternatives the production code must not be
    // — a session lock released in a `finally`, and a session lock never
    // released — are invisible to PGlite, which is one connection and so can
    // never put the lock and the unlock on different ones. Read the SQL instead.
    const issued: string[] = [];
    const recorder: SqlExecutor = {
      execute(query: SQL) {
        issued.push(sqlToText(query));
        return Promise.resolve({ rows: [] });
      },
      transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        issued.push('BEGIN');
        return callback(recorder).then(
          (value) => {
            issued.push('COMMIT');
            return value;
          },
          (error: unknown) => {
            issued.push('ROLLBACK');
            throw error;
          }
        );
      },
    };

    // No rows come back, so this takes the 'fresh-database' path — which is
    // enough: the lock is taken before any of the branching.
    expect(await markBaselineApplied(recorder, PUBLIC)).toBe('fresh-database');

    const lockAt = issued.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(lockAt).toBeGreaterThan(-1);
    // Inside the transaction — a transaction-scoped lock outside one is released
    // immediately and guards nothing.
    expect(issued.indexOf('BEGIN')).toBeGreaterThan(-1);
    expect(issued.indexOf('BEGIN')).toBeLessThan(lockAt);
    expect(issued.lastIndexOf('COMMIT')).toBeGreaterThan(lockAt);
    // The session-scoped pair must not appear at all: `pg_advisory_unlock` is the
    // call that can land on the wrong connection, and this code must never make it.
    expect(issued.some((s) => /pg_advisory_lock\b/.test(s))).toBe(false);
    expect(issued.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
    // And the DDL stays OUTSIDE the transaction: `CREATE TABLE IF NOT EXISTS`
    // takes ACCESS EXCLUSIVE on the journal, which inside would be taken before
    // the advisory lock and invert the lock order against this same path.
    const ddlAt = issued.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS'));
    expect(ddlAt).toBeGreaterThan(-1);
    expect(ddlAt).toBeLessThan(issued.indexOf('BEGIN'));
  });

  it('serializes concurrent passes so only one baseline row is written', async () => {
    const { client, db } = await seededFromFrozenHistory();
    const outcomes = await Promise.all([
      markBaselineApplied(db, PUBLIC),
      markBaselineApplied(db, PUBLIC),
      markBaselineApplied(db, PUBLIC),
    ]);
    expect(outcomes.filter((o) => o === 'marked-applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already-tracked')).toHaveLength(2);
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    await client.close();
  });

  it('fills an empty journal left by an interrupted earlier pass', async () => {
    const { client, db } = await seededFromFrozenHistory();
    // Table present, no rows — what a crash between CREATE TABLE and INSERT leaves.
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await db.execute(
      sql`CREATE TABLE "drizzle"."__drizzle_migrations_public" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
    );
    expect(await markBaselineApplied(db, PUBLIC)).toBe('marked-applied');
    await applyHistory(db, PUBLIC);
    expect(await journalRows(client, 'drizzle', PUBLIC.migrationsTable)).toHaveLength(1);
    await client.close();
  });
});
