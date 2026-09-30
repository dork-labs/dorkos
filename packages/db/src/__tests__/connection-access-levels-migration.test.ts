import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder that stops just before the named migration. */
function foldersBefore(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'connection-access-levels-'));
  tempDirs.push(folder);
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const target = journal.entries.find((entry) => entry.tag === tag);
  expect(target).toBeDefined();
  const entries = journal.entries.filter((entry) => entry.idx < target!.idx);
  for (const entry of entries) {
    copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

const NOW = '2026-09-29T00:00:00.000Z';

describe('levels become intent (0132)', () => {
  it('turns grants matching a level in the last review into that level, and leaves the rest exact', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: foldersBefore('0132_connection_access_levels') });
      sqlite
        .prepare(
          `INSERT INTO connector_provider_instances
             (id, type, mode, display_name, custody, capability_json, execution_config_generation,
              owner_kind, owner_id, status, created_at, updated_at)
           VALUES ('provider-1', 'test', 'byo', 'Test', 'self-host', '{}', 1, 'local_install',
             'install-1', 'available', ?, ?)`
        )
        .run(NOW, NOW);
      const connection = sqlite.prepare(
        `INSERT INTO connections
           (id, provider_instance_id, external_account_ref, toolkit, label, status, created_at, updated_at)
         VALUES (?, 'provider-1', ?, ?, 'work', 'active', ?, ?)`
      );
      connection.run('mail', 'ref-mail', 'gmail', NOW, NOW);
      connection.run('docs', 'ref-docs', 'docs', NOW, NOW);
      connection.run('unreviewed', 'ref-unreviewed', 'gmail', NOW, NOW);
      const revision = sqlite.prepare(
        `INSERT INTO connector_operation_revisions
           (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
            capability_classification, input_schema_json, discovered_at)
         VALUES (?, 'provider-1', ?, ?, '1', ?, ?, '{}', ?)`
      );
      for (const [id, toolkit, classification] of [
        ['read-1', 'gmail', 'read'],
        ['read-2', 'gmail', 'read'],
        ['read-gone', 'gmail', 'read'],
        ['write-1', 'gmail', 'write'],
        ['delete-1', 'gmail', 'destructive'],
        ['docs-read', 'docs', 'read'],
      ] as const) {
        revision.run(id, toolkit, id, `hash-${id}`, classification, NOW);
      }
      const preview = sqlite.prepare(
        `INSERT INTO connector_reconciliation_previews
           (id, owner_kind, owner_id, connection_id, provider_instance_id, boot_epoch,
            execution_config_generation, complete_revision_set_hash, created_at, expires_at)
         VALUES (?, 'local_install', 'install-1', ?, 'provider-1', 'boot', 1, 'hash', ?, ?)`
      );
      const candidate = sqlite.prepare(
        `INSERT INTO connector_reconciliation_candidates (preview_id, operation_revision_id, supported)
         VALUES (?, ?, ?)`
      );
      // An older review offered only one read; the newest one is what counts.
      preview.run('mail-old', 'mail', '2026-09-01T00:00:00.000Z', '2026-09-01T00:10:00.000Z');
      candidate.run('mail-old', 'read-1', 1);
      preview.run('mail-new', 'mail', '2026-09-20T00:00:00.000Z', '2026-09-20T00:10:00.000Z');
      for (const [id, supported] of [
        ['read-1', 1],
        ['read-2', 1],
        ['read-gone', 0],
        ['write-1', 1],
        ['delete-1', 1],
      ] as const) {
        candidate.run('mail-new', id, supported);
      }
      preview.run('docs-new', 'docs', '2026-09-20T00:00:00.000Z', '2026-09-20T00:10:00.000Z');
      candidate.run('docs-new', 'docs-read', 1);

      const grant = sqlite.prepare(
        `INSERT INTO connection_operation_grants
           (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id,
            created_by, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 'install-1', ?, ?)`
      );
      let n = 0;
      const give = (
        subject: string,
        connectionId: string,
        ids: string[],
        revokedAt: string | null = null
      ) => {
        const every = subject === 'every_agent';
        for (const id of ids) {
          grant.run(
            `grant-${(n += 1)}`,
            every ? 'every_agent' : 'agent',
            subject,
            every ? null : subject,
            connectionId,
            id,
            NOW,
            revokedAt
          );
        }
      };
      give('reader', 'mail', ['read-1', 'read-2']);
      give('writer', 'mail', ['read-1', 'read-2', 'write-1']);
      give('partial', 'mail', ['read-1']);
      give('deleter', 'mail', ['read-1', 'read-2', 'write-1', 'delete-1']);
      give('stale', 'mail', ['read-gone', 'read-1', 'read-2']);
      give('revoked', 'mail', ['read-1', 'read-2'], NOW);
      give('every_agent', 'mail', ['read-1', 'read-2']);
      // An app with no write actions: both levels are one set, so it reads as Read.
      give('reader', 'docs', ['docs-read']);
      // No review was ever made, so nothing says what a level covered.
      give('reader', 'unreviewed', ['read-1', 'read-2']);

      migrate(db, { migrationsFolder: migrationDir });

      expect(
        sqlite
          .prepare(
            `SELECT subject_type, subject_id, agent_id, connection_id, level, created_by
             FROM connection_access_levels ORDER BY connection_id, subject_type, subject_id`
          )
          .all()
      ).toEqual([
        {
          subject_type: 'agent',
          subject_id: 'reader',
          agent_id: 'reader',
          connection_id: 'docs',
          level: 'read',
          created_by: 'install-1',
        },
        {
          subject_type: 'agent',
          subject_id: 'reader',
          agent_id: 'reader',
          connection_id: 'mail',
          level: 'read',
          created_by: 'install-1',
        },
        {
          subject_type: 'agent',
          subject_id: 'writer',
          agent_id: 'writer',
          connection_id: 'mail',
          level: 'read-write',
          created_by: 'install-1',
        },
        {
          subject_type: 'every_agent',
          subject_id: 'every_agent',
          agent_id: null,
          connection_id: 'mail',
          level: 'read',
          created_by: 'install-1',
        },
      ]);
      // The grants themselves are untouched.
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS n FROM connection_operation_grants WHERE revoked_at IS NULL')
          .get()
      ).toEqual({ n: 18 });
    } finally {
      sqlite.close();
    }
  });
});
