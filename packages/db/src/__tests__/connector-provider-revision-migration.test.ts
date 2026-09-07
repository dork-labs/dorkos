/** Upgrade proof for opaque provider revision identity without replacing prior grants. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';

const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const migrationTag = '0090_crazy_ezekiel_stane';

it('preserves populated revision/grant rows, permits fresh provider identities, and reruns safely', () => {
  const folder = mkdtempSync(join(tmpdir(), 'connector-revision-upgrade-'));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    mkdirSync(join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const target = journal.entries.find((entry) => entry.tag === migrationTag);
    expect(target).toBeDefined();
    const entries = journal.entries.filter((entry) => entry.idx < target!.idx);
    expect(entries.length).toBeGreaterThan(80);
    for (const entry of entries)
      copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: folder });
    sqlite
      .prepare(
        `INSERT INTO connector_provider_instances (id, type, mode, display_name, custody, capability_json, status, created_at, updated_at) VALUES ('provider', 'composio', 'byo', 'Provider', 'managed', '{}', 'available', 'now', 'now')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO connections (id, provider_instance_id, external_account_ref, toolkit, label, status, created_at, updated_at) VALUES ('connection', 'provider', 'private-account', 'gmail', 'Work', 'active', 'now', 'now')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO connector_operation_revisions (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash, capability_classification, input_schema_json, discovered_at) VALUES ('revision', 'provider', 'gmail', 'read', 'v1', 'hash', 'read', '{}', 'now')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO connection_operation_grants (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id, created_by, created_at) VALUES ('grant', 'agent', 'agent', 'agent', 'connection', 'revision', 'owner', 'now')`
      )
      .run();
    const before = sqlite.prepare('SELECT * FROM connector_operation_revisions').get() as Record<
      string,
      unknown
    >;
    const grant = sqlite.prepare('SELECT * FROM connection_operation_grants').get();
    migrate(db, { migrationsFolder: migrationDir });
    expect(sqlite.prepare('SELECT * FROM connector_operation_revisions').get()).toEqual({
      ...before,
      provider_revision_ref: '',
    });
    expect(sqlite.prepare('SELECT * FROM connection_operation_grants').get()).toEqual(grant);
    sqlite
      .prepare(
        `INSERT INTO connector_operation_revisions (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash, capability_classification, input_schema_json, discovered_at, provider_revision_ref) VALUES ('new-revision', 'provider', 'gmail', 'read', 'v1', 'hash', 'read', '{}', 'now', 'hosted-generation-2')`
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `UPDATE connector_operation_revisions SET provider_revision_ref = 'other' WHERE id = 'revision'`
        )
        .run()
    ).toThrow();
    migrate(db, { migrationsFolder: migrationDir });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM connector_operation_revisions').get()
    ).toEqual({ count: 2 });
    expect(sqlite.prepare('SELECT * FROM connection_operation_grants').all()).toEqual([grant]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    sqlite.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
