/**
 * The `extension` grant subject (DOR-3547, Security M4 and N2).
 *
 * 1. `connection_operation_grants` gains a typed `extension_id`. The database
 *    itself refuses a row that names an extension anywhere else, or an agent in
 *    an extension's row, on INSERT and on UPDATE: SQLite can't add a `CHECK` to
 *    an existing table, so triggers do it, and every test here is a RAW insert
 *    or update that skips the app's own code.
 * 2. `extension_connection_approvals` is keyed on the install (scope, real
 *    path, origin and files digest), not the bare id.
 * 3. Rows from before the migration read back unchanged.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

/** A fresh in-memory database on the latest schema, by the ordinary boot path. */
function latest(): Database.Database {
  const db = createDb(':memory:');
  runMigrations(db);
  return db.$client as unknown as Database.Database;
}

const TAG = '20261108035027_dor3547_extension_grant_subject';
const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const NOW = '2026-11-08T00:00:00.000Z';
const REFUSED = /an extension grant names its extension in extension_id and nowhere else/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder that stops just before (or, with `include`, at) this migration. */
function folderUpTo(include: boolean): string {
  const folder = mkdtempSync(join(tmpdir(), 'extension-grant-subject-'));
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

/** One provider, one connection and one read revision, by raw SQL. */
function seedConnection(sqlite: Database.Database): void {
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
  sqlite
    .prepare(
      `INSERT INTO connector_operation_revisions
         (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
          capability_classification, input_schema_json, discovered_at)
       VALUES ('rev-read', 'provider-1', 'linear', 'LINEAR_LIST_LINEAR_PROJECTS', '1', 'hash',
         'read', '{}', ?)`
    )
    .run(NOW);
}

/** A raw grant insert; `extensionId` is left out of the column list when undefined. */
function insertGrant(
  sqlite: Database.Database,
  row: {
    id: string;
    subjectType: string;
    subjectId: string;
    agentId: string | null;
    extensionId?: string | null;
  }
): void {
  if (row.extensionId === undefined) {
    sqlite
      .prepare(
        `INSERT INTO connection_operation_grants
           (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id,
            created_by, created_at)
         VALUES (?, ?, ?, ?, 'linear', 'rev-read', 'owner', ?)`
      )
      .run(row.id, row.subjectType, row.subjectId, row.agentId, NOW);
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO connection_operation_grants
         (id, subject_type, subject_id, agent_id, extension_id, connection_id,
          operation_revision_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'linear', 'rev-read', 'owner', ?)`
    )
    .run(row.id, row.subjectType, row.subjectId, row.agentId, row.extensionId, NOW);
}

describe('rows from before the migration', () => {
  it('read back unchanged, with no extension id', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: folderUpTo(false) });
      seedConnection(sqlite);
      insertGrant(sqlite, {
        id: 'g-agent',
        subjectType: 'agent',
        subjectId: 'agent-1',
        agentId: 'agent-1',
      });
      insertGrant(sqlite, {
        id: 'g-every',
        subjectType: 'every_agent',
        subjectId: 'every_agent',
        agentId: null,
      });
      migrate(db, { migrationsFolder: folderUpTo(true) });
      const rows = sqlite
        .prepare(
          `SELECT id, subject_type, subject_id, agent_id, extension_id FROM connection_operation_grants ORDER BY id`
        )
        .all();
      expect(rows).toEqual([
        {
          id: 'g-agent',
          subject_type: 'agent',
          subject_id: 'agent-1',
          agent_id: 'agent-1',
          extension_id: null,
        },
        {
          id: 'g-every',
          subject_type: 'every_agent',
          subject_id: 'every_agent',
          agent_id: null,
          extension_id: null,
        },
      ]);
      // An old row can still be revoked: the update guard passes it.
      sqlite
        .prepare(`UPDATE connection_operation_grants SET revoked_at = ? WHERE id = 'g-agent'`)
        .run(NOW);
    } finally {
      sqlite.close();
    }
  });
});

describe('the typed extension subject (M4)', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = latest();

    seedConnection(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('accepts a well-formed extension row, and agent and every-agent rows as before', () => {
    insertGrant(sqlite, {
      id: 'ok-ext',
      subjectType: 'extension',
      subjectId: 'flow-owner',
      agentId: null,
      extensionId: 'flow-owner',
    });
    insertGrant(sqlite, {
      id: 'ok-agent',
      subjectType: 'agent',
      subjectId: 'agent-1',
      agentId: 'agent-1',
    });
    insertGrant(sqlite, {
      id: 'ok-every',
      subjectType: 'every_agent',
      subjectId: 'every_agent',
      agentId: null,
    });
    expect(sqlite.prepare(`SELECT count(*) AS n FROM connection_operation_grants`).get()).toEqual({
      n: 3,
    });
  });

  it('refuses a raw insert of an extension row that names an agent', () => {
    expect(() =>
      insertGrant(sqlite, {
        id: 'bad',
        subjectType: 'extension',
        subjectId: 'flow-owner',
        agentId: 'agent-1',
        extensionId: 'flow-owner',
      })
    ).toThrow(REFUSED);
  });

  it('refuses an extension row without its typed id, or with a subject id that differs', () => {
    expect(() =>
      insertGrant(sqlite, {
        id: 'bad-1',
        subjectType: 'extension',
        subjectId: 'flow-owner',
        agentId: null,
      })
    ).toThrow(REFUSED);
    expect(() =>
      insertGrant(sqlite, {
        id: 'bad-2',
        subjectType: 'extension',
        subjectId: 'other-ext',
        agentId: null,
        extensionId: 'flow-owner',
      })
    ).toThrow(REFUSED);
  });

  it('refuses an extension id outside the manifest grammar, a prefixed one included', () => {
    for (const extensionId of ['extension:flow', 'Flow', '', '-flow', 'flow owner', 'flöw']) {
      expect(() =>
        insertGrant(sqlite, {
          id: `bad-${extensionId}`,
          subjectType: 'extension',
          subjectId: extensionId,
          agentId: null,
          extensionId,
        })
      ).toThrow(REFUSED);
    }
  });

  it('refuses an agent, session or every-agent row that carries an extension id', () => {
    for (const [subjectType, subjectId, agentId] of [
      ['agent', 'agent-1', 'agent-1'],
      ['session', 'session-1', 'agent-1'],
      ['every_agent', 'every_agent', null],
    ] as const) {
      expect(() =>
        insertGrant(sqlite, {
          id: `bad-${subjectType}`,
          subjectType,
          subjectId,
          agentId,
          extensionId: 'flow-owner',
        })
      ).toThrow(REFUSED);
    }
  });

  it('reads the subject from subject_type alone, never from the shape of an id', () => {
    // An agent id that reads like a prefixed extension is still only an
    // agent's row: no extension id, so it can never answer for an extension.
    insertGrant(sqlite, {
      id: 'agent-prefixed',
      subjectType: 'agent',
      subjectId: 'extension:flow-owner',
      agentId: 'extension:flow-owner',
    });
    expect(
      sqlite
        .prepare(
          `SELECT subject_type, extension_id FROM connection_operation_grants WHERE id = 'agent-prefixed'`
        )
        .get()
    ).toEqual({ subject_type: 'agent', extension_id: null });
    expect(
      sqlite
        .prepare(
          `SELECT count(*) AS n FROM connection_operation_grants WHERE subject_type = 'extension' AND extension_id = 'flow-owner'`
        )
        .get()
    ).toEqual({ n: 0 });
  });

  it('refuses a raw update that would break the rule, either way, and allows a revoke', () => {
    insertGrant(sqlite, {
      id: 'ext',
      subjectType: 'extension',
      subjectId: 'flow-owner',
      agentId: null,
      extensionId: 'flow-owner',
    });
    insertGrant(sqlite, {
      id: 'agent',
      subjectType: 'agent',
      subjectId: 'agent-1',
      agentId: 'agent-1',
    });
    const update = (sqlText: string) => () => sqlite.prepare(sqlText).run();

    // An agent named into the extension's grant.
    expect(
      update(`UPDATE connection_operation_grants SET agent_id = 'agent-1' WHERE id = 'ext'`)
    ).toThrow(REFUSED);
    // The extension's grant turned into an agent's, keeping its extension id.
    expect(
      update(`UPDATE connection_operation_grants SET subject_type = 'agent' WHERE id = 'ext'`)
    ).toThrow(REFUSED);
    // An agent's grant turned into an extension's.
    expect(
      update(`UPDATE connection_operation_grants SET subject_type = 'extension' WHERE id = 'agent'`)
    ).toThrow(REFUSED);
    expect(
      update(
        `UPDATE connection_operation_grants SET extension_id = 'flow-owner' WHERE id = 'agent'`
      )
    ).toThrow(REFUSED);
    // Re-pointing the extension's grant at another extension through the subject id alone.
    expect(
      update(`UPDATE connection_operation_grants SET subject_id = 'other' WHERE id = 'ext'`)
    ).toThrow(REFUSED);

    // Revoking stays possible.
    sqlite
      .prepare(`UPDATE connection_operation_grants SET revoked_at = ? WHERE id = 'ext'`)
      .run(NOW);
    expect(
      sqlite
        .prepare(
          `SELECT subject_type, agent_id, extension_id, revoked_at FROM connection_operation_grants WHERE id = 'ext'`
        )
        .get()
    ).toEqual({
      subject_type: 'extension',
      agent_id: null,
      extension_id: 'flow-owner',
      revoked_at: NOW,
    });
  });

  it('keeps both guards on the latest schema, through every later migration', () => {
    // Drizzle does not know the triggers exist, so a later rebuild of the table would drop them.
    const triggers = (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'connection_operation_grants' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers).toEqual([
      // Added by 20261110152045_dor3547_extension_grant_guards (Security S-2).
      'connection_operation_grants_extension_read_only_insert',
      'connection_operation_grants_extension_read_only_update',
      'connection_operation_grants_extension_subject_insert',
      'connection_operation_grants_extension_subject_update',
    ]);
  });

  it('adds a nullable arguments hash to usage rows (S6)', () => {
    const column = (
      sqlite.prepare(`PRAGMA table_info('connector_usage_attempts')`).all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === 'arguments_hash');
    expect(column).toEqual(expect.objectContaining({ name: 'arguments_hash', notnull: 0 }));
  });
});

describe('extension connection approvals (N2)', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = latest();
    seedConnection(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  const base = {
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
  function insertApproval(id: string, overrides: Partial<typeof base> = {}): void {
    const row = { ...base, ...overrides };
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
      .run({ id, ...row });
  }

  it('keys a live approval on the install, so a same-id copy elsewhere is another row', () => {
    insertApproval('a1');
    // The same install and service twice, both live: refused.
    expect(() => insertApproval('a2')).toThrow(/UNIQUE constraint failed/);
    // A project copy with the same id is a different install, and stands alone.
    insertApproval('a3', {
      install_scope: 'local',
      install_real_path: '/work/project/.dork/extensions/flow-owner',
    });
    // Once revoked, the install can be approved again.
    sqlite
      .prepare(`UPDATE extension_connection_approvals SET revoked_at = ? WHERE id = 'a1'`)
      .run(NOW);
    insertApproval('a4');
    expect(
      sqlite
        .prepare(
          `SELECT id FROM extension_connection_approvals WHERE revoked_at IS NULL ORDER BY id`
        )
        .all()
    ).toEqual([{ id: 'a3' }, { id: 'a4' }]);
  });

  it('accepts only trusted origins, never path-trust, dev-link or agent-built copies (Q7)', () => {
    insertApproval('core', { install_origin: 'core', origin_source: null });
    insertApproval('pinned', {
      install_origin: 'digest_pinned',
      origin_source: null,
      install_real_path: '/elsewhere/flow-owner',
    });
    for (const origin of ['path_trust', 'dev_link', 'create_extension', 'user', '']) {
      // No source, so only the origin CHECK can refuse it (Security S-4: with a
      // source set, the origin_source CHECK refused these rows instead, and
      // the unanchored pattern matched its name as a prefix).
      expect(() =>
        insertApproval(`bad-${origin}`, {
          install_origin: origin,
          origin_source: null,
          install_real_path: `/x/${origin}`,
        })
      ).toThrow(/CHECK constraint failed: extension_connection_approvals_origin$/);
    }
  });

  it('names a source exactly when the origin is a trusted source', () => {
    expect(() => insertApproval('no-source', { origin_source: null })).toThrow(
      /extension_connection_approvals_origin_source/
    );
    expect(() =>
      insertApproval('extra-source', { install_origin: 'core', origin_source: 'someone/else' })
    ).toThrow(/extension_connection_approvals_origin_source/);
  });

  it('refuses a bad scope, a bad extension id or an empty digest', () => {
    expect(() => insertApproval('scope', { install_scope: 'project' })).toThrow(
      /extension_connection_approvals_scope/
    );
    for (const extensionId of ['extension:flow', 'Flow', '', '-flow']) {
      expect(() => insertApproval(`id-${extensionId}`, { extension_id: extensionId })).toThrow(
        /extension_connection_approvals_extension_id/
      );
    }
    expect(() => insertApproval('files', { approved_files_digest: '' })).toThrow(
      /extension_connection_approvals_digests/
    );
    expect(() => insertApproval('ops', { approved_operations_digest: '' })).toThrow(
      /extension_connection_approvals_digests/
    );
  });

  it('names a real connected account', () => {
    // Connections are tombstoned, never deleted, so revoking an approval when
    // an account goes is the store's job; the database only refuses a row
    // pointing at an account that never existed.
    sqlite.pragma('foreign_keys = ON');
    expect(() => insertApproval('ghost', { connection_id: 'no-such-account' })).toThrow(
      /FOREIGN KEY constraint failed/
    );
  });
});
