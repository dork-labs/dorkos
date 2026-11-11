/**
 * Tighter guards on the extension grant subject (DOR-3547, Security's #3535
 * Shoulds S-1 to S-3).
 *
 * 1. S-1: GLOB and substr stop at an embedded NUL, so `flow\0:agent-1` used to
 *    pass the id grammar. Both grant triggers and the approvals CHECK now also
 *    require the byte length to equal the character length.
 * 2. S-2: an extension grant on a write or destructive revision is refused by
 *    the database, on INSERT and UPDATE. Revisions are immutable, so this is a
 *    lock, not a convention.
 * 3. S-3: no whitespace-only digest or source, and the real path is absolute.
 * 4. The approvals table is rebuilt to take the new CHECKs, and keeps its rows.
 *
 * Every test is a raw insert or update that skips the app's own code.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

const TAG = '20261110152045_dor3547_extension_grant_guards';
const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const NOW = '2026-11-08T00:00:00.000Z';
const SUBJECT = /an extension grant names its extension in extension_id and nowhere else/;
const READ_ONLY = /an extension grant holds read operations only/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh in-memory database on the latest schema, by the ordinary boot path. */
function latest(): Database.Database {
  const db = createDb(':memory:');
  runMigrations(db);
  return db.$client as unknown as Database.Database;
}

/** A migrations folder that stops just before (or, with `include`, at) this migration. */
function folderUpTo(include: boolean): string {
  const folder = mkdtempSync(join(tmpdir(), 'extension-grant-guards-'));
  tempDirs.push(folder);
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const target = journal.entries.find((entry) => entry.tag === TAG);
  expect(target).toBeDefined();
  const entries = journal.entries.filter((entry) =>
    include ? entry.idx <= target!.idx : entry.idx < target!.idx
  );
  for (const entry of entries) {
    copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** One provider, one connection and a read, a write and a destructive revision. */
function seed(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, execution_config_generation,
          owner_kind, owner_id, status, created_at, updated_at)
       VALUES ('provider-1', 'test', 'byo', 'Test', 'self-host', '{}', 1, 'local_install',
         'install-1', 'available', ?, ?)`
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, status, created_at, updated_at)
       VALUES ('linear', 'provider-1', 'ref-linear', 'linear', 'work', 'active', ?, ?)`
    )
    .run(NOW, NOW);
  const revision = sqlite.prepare(
    `INSERT INTO connector_operation_revisions
       (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
        capability_classification, input_schema_json, discovered_at)
     VALUES (?, 'provider-1', 'linear', ?, '1', ?, ?, '{}', ?)`
  );
  revision.run('rev-read', 'LINEAR_LIST_LINEAR_PROJECTS', 'h-read', 'read', NOW);
  revision.run('rev-write', 'LINEAR_UPDATE_ISSUE', 'h-write', 'write', NOW);
  revision.run('rev-delete', 'LINEAR_DELETE_ISSUE', 'h-delete', 'destructive', NOW);
}

/** A raw grant insert. */
function grant(
  sqlite: Database.Database,
  row: {
    id: string;
    subjectType: string;
    subjectId: string;
    agentId: string | null;
    extensionId: string | null;
    revision?: string;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO connection_operation_grants
         (id, subject_type, subject_id, agent_id, extension_id, connection_id,
          operation_revision_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'linear', ?, 'owner', ?)`
    )
    .run(
      row.id,
      row.subjectType,
      row.subjectId,
      row.agentId,
      row.extensionId,
      row.revision ?? 'rev-read',
      NOW
    );
}

/** An extension grant for `flow-owner` on one revision. */
function extensionGrant(sqlite: Database.Database, id: string, revision: string): void {
  grant(sqlite, {
    id,
    subjectType: 'extension',
    subjectId: 'flow-owner',
    agentId: null,
    extensionId: 'flow-owner',
    revision,
  });
}

const APPROVAL = {
  extension_id: 'flow-owner',
  install_scope: 'global',
  install_real_path: '/home/me/.dork/extensions/flow-owner',
  install_origin: 'trusted_source',
  origin_source: 'dork-labs/marketplace' as string | null,
  approved_files_digest: 'sha256:files',
  approved_version: '0.2.0',
  service: 'linear',
  connection_id: 'linear',
  approved_operations_digest: 'sha256:ops',
  approved_by: 'owner',
  approved_at: NOW,
  revoked_at: null as string | null,
};

/** A raw approval insert. */
function approval(
  sqlite: Database.Database,
  id: string,
  overrides: Partial<typeof APPROVAL> = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO extension_connection_approvals
         (id, extension_id, install_scope, install_real_path, install_origin, origin_source,
          approved_files_digest, approved_version, service, connection_id,
          approved_operations_digest, approved_by, approved_at, revoked_at)
       VALUES (@id, @extension_id, @install_scope, @install_real_path, @install_origin,
         @origin_source, @approved_files_digest, @approved_version, @service, @connection_id,
         @approved_operations_digest, @approved_by, @approved_at, @revoked_at)`
    )
    .run({ id, ...APPROVAL, ...overrides });
}

describe('an embedded NUL in an extension id (S-1)', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = latest();
    seed(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('is refused on a grant, on insert and on update', () => {
    for (const extensionId of ['flow\0:agent-1', 'flow\0', '\0flow']) {
      expect(() =>
        grant(sqlite, {
          id: `nul-${extensionId.length}-${extensionId.indexOf('\0')}`,
          subjectType: 'extension',
          subjectId: extensionId,
          agentId: null,
          extensionId,
        })
      ).toThrow(SUBJECT);
    }
    extensionGrant(sqlite, 'ok', 'rev-read');
    expect(() =>
      sqlite
        .prepare(
          `UPDATE connection_operation_grants SET extension_id = ?, subject_id = ? WHERE id = 'ok'`
        )
        .run('flow\0:agent-1', 'flow\0:agent-1')
    ).toThrow(SUBJECT);
  });

  it('is refused on an approval, while a clean id passes', () => {
    expect(() => approval(sqlite, 'nul', { extension_id: 'flow\0:agent-1' })).toThrow(
      /CHECK constraint failed: extension_connection_approvals_extension_id$/
    );
    approval(sqlite, 'clean');
    expect(sqlite.prepare(`SELECT extension_id FROM extension_connection_approvals`).all()).toEqual(
      [{ extension_id: 'flow-owner' }]
    );
  });
});

describe('extension grants are read-only in the database (S-2)', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = latest();
    seed(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('refuses an extension grant on a write or destructive revision', () => {
    expect(() => extensionGrant(sqlite, 'w', 'rev-write')).toThrow(READ_ONLY);
    expect(() => extensionGrant(sqlite, 'd', 'rev-delete')).toThrow(READ_ONLY);
    extensionGrant(sqlite, 'r', 'rev-read');
  });

  it('refuses an update that points an extension grant at a write revision', () => {
    extensionGrant(sqlite, 'r', 'rev-read');
    expect(() =>
      sqlite
        .prepare(
          `UPDATE connection_operation_grants SET operation_revision_id = 'rev-write' WHERE id = 'r'`
        )
        .run()
    ).toThrow(READ_ONLY);
  });

  it('refuses an extension grant on a revision that does not exist', () => {
    sqlite.pragma('foreign_keys = OFF');
    expect(() => extensionGrant(sqlite, 'ghost', 'no-such-revision')).toThrow(READ_ONLY);
  });

  it('leaves agent and every-agent grants on every classification', () => {
    for (const revision of ['rev-read', 'rev-write', 'rev-delete']) {
      grant(sqlite, {
        id: `agent-${revision}`,
        subjectType: 'agent',
        subjectId: 'agent-1',
        agentId: 'agent-1',
        extensionId: null,
        revision,
      });
      grant(sqlite, {
        id: `every-${revision}`,
        subjectType: 'every_agent',
        subjectId: 'every_agent',
        agentId: null,
        extensionId: null,
        revision,
      });
    }
    expect(sqlite.prepare(`SELECT count(*) AS n FROM connection_operation_grants`).get()).toEqual({
      n: 6,
    });
  });
});

describe('approval values that say something (S-3)', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = latest();
    seed(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('refuses a whitespace-only digest', () => {
    expect(() => approval(sqlite, 'f', { approved_files_digest: '   ' })).toThrow(
      /CHECK constraint failed: extension_connection_approvals_digests$/
    );
    expect(() => approval(sqlite, 'o', { approved_operations_digest: '\t' })).toThrow(
      /CHECK constraint failed: extension_connection_approvals_digests$/
    );
  });

  it('refuses an empty or blank source on a trusted-source copy', () => {
    for (const source of ['', '   ']) {
      expect(() => approval(sqlite, `s-${source.length}`, { origin_source: source })).toThrow(
        /CHECK constraint failed: extension_connection_approvals_origin_source_text$/
      );
    }
  });

  it('refuses a real path that is empty, relative or carries a NUL', () => {
    for (const path of ['', 'relative/flow-owner', ' /home/me/flow-owner', '/home/me\0/flow']) {
      expect(() => approval(sqlite, `p-${path.length}`, { install_real_path: path })).toThrow(
        /CHECK constraint failed: extension_connection_approvals_real_path$/
      );
    }
    approval(sqlite, 'ok');
  });
});

describe('an existing install picks it up (Security M1 on #3536)', () => {
  /** The migration just before this one: #3589's, which also took idx 193 first. */
  const PREVIOUS = '20261110044508_work_queue_permissions';
  const TRIGGERS = [
    'connection_operation_grants_extension_read_only_insert',
    'connection_operation_grants_extension_read_only_update',
    'connection_operation_grants_extension_subject_insert',
    'connection_operation_grants_extension_subject_update',
  ];

  /** A migrations folder holding every entry up to and including `tag`. */
  function folderThrough(tag: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'extension-grant-guards-existing-'));
    tempDirs.push(folder);
    mkdirSync(join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const last = journal.entries.find((entry) => entry.tag === tag);
    expect(last).toBeDefined();
    const entries = journal.entries.filter((entry) => entry.idx <= last!.idx);
    for (const entry of entries) {
      copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    return folder;
  }

  /** The guard triggers this migration owns, by name. */
  function guardTriggers(sqlite: Database.Database): string[] {
    return (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'connection_operation_grants' AND name LIKE 'connection_operation_grants_extension_%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
  }

  it('sorts after the migration before it, by idx and by when', () => {
    const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const ours = journal.entries.find((entry) => entry.tag === TAG)!;
    const previous = journal.entries.find((entry) => entry.tag === PREVIOUS)!;
    expect(ours.idx).toBeGreaterThan(previous.idx);
    expect(ours.when).toBeGreaterThan(previous.when);
  });

  it('adds the read-only guard to a database already migrated through the one before it', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: folderThrough(PREVIOUS) });
      // Main already carries the two subject triggers from #3535, not the read-only pair.
      expect(guardTriggers(sqlite)).not.toContain(
        'connection_operation_grants_extension_read_only_insert'
      );
      migrate(db, { migrationsFolder: migrationDir });
      expect(guardTriggers(sqlite)).toEqual(TRIGGERS);
      seed(sqlite);
      expect(() => extensionGrant(sqlite, 'w', 'rev-write')).toThrow(READ_ONLY);
      extensionGrant(sqlite, 'r', 'rev-read');
    } finally {
      sqlite.close();
    }
  });
});

describe('the approvals rebuild', () => {
  it('keeps rows from before it, its indexes and its foreign key', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: folderUpTo(false) });
      seed(sqlite);
      approval(sqlite, 'live');
      approval(sqlite, 'old', { revoked_at: NOW });
      const before = sqlite
        .prepare(`SELECT * FROM extension_connection_approvals ORDER BY id`)
        .all();
      migrate(db, { migrationsFolder: folderUpTo(true) });
      expect(
        sqlite.prepare(`SELECT * FROM extension_connection_approvals ORDER BY id`).all()
      ).toEqual(before);
      const indexes = (
        sqlite
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'extension_connection_approvals' AND name NOT LIKE 'sqlite_%' ORDER BY name`
          )
          .all() as { name: string }[]
      ).map((i) => i.name);
      expect(indexes).toEqual([
        'extension_connection_approvals_connection_idx',
        'extension_connection_approvals_live_unique',
      ]);
      expect(
        sqlite.prepare(`PRAGMA foreign_key_list('extension_connection_approvals')`).all()
      ).toEqual([
        expect.objectContaining({
          table: 'connections',
          from: 'connection_id',
          on_delete: 'CASCADE',
        }),
      ]);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      // The live slot is still one per install and service.
      expect(() => approval(sqlite, 'second-live')).toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});
