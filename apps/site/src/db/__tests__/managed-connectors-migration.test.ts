/**
 * @vitest-environment node
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite and replaying the migrations costs seconds, and every case
// here pays it: measured at 4.8s of vitest's 5s default at a load average of
// 280, which is 200ms of margin on a machine running other agents' suites
// (DOR-1886). One database per case is what the two migration states under test
// require, so the budget moves rather than the fixture.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const MANAGED_MIGRATION_TAG = '0011_curious_chameleon';

const clients: PGlite[] = [];
const folders: string[] = [];

function migrationFolderThrough(lastIndex: number): string {
  const folder = mkdtempSync(join(tmpdir(), 'dorkos-managed-migrations-'));
  folders.push(folder);
  cpSync(MIGRATIONS_DIR, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  writeFileSync(
    journalPath,
    JSON.stringify({
      version: journal.version,
      dialect: journal.dialect,
      entries: journal.entries.filter((entry) => entry.idx <= lastIndex),
    })
  );
  return folder;
}

async function createClient(): Promise<PGlite> {
  const client = new PGlite();
  clients.push(client);
  return client;
}

async function appliedTags(client: PGlite): Promise<string[]> {
  const result = await client.query<{ hash: string }>(
    `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`
  );
  return result.rows.map((row) => row.hash);
}

async function publicTables(client: PGlite): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name`
  );
  return result.rows.map((row) => row.table_name);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('0011 hosted managed connector migration', () => {
  it('installs the complete schema on a fresh database and remains idempotent on restart', async () => {
    const client = await createClient();
    const database = drizzle(client);

    await migrate(database, { migrationsFolder: MIGRATIONS_DIR });
    const firstMigrationHashes = await appliedTags(client);
    await migrate(database, { migrationsFolder: MIGRATIONS_DIR });

    expect(await appliedTags(client)).toEqual(firstMigrationHashes);
    expect(await publicTables(client)).toEqual(
      expect.arrayContaining([
        'connector_tenant',
        'managed_connector_auth_flow',
        'managed_connector_authority_command',
        'managed_connector_connection',
        'managed_connector_execution_attempt',
        'managed_connector_grant',
        'managed_connector_operation_revision',
        'managed_connector_provider',
      ])
    );
  });

  it('upgrades a populated 0010 database without changing existing auth ownership', async () => {
    const client = await createClient();
    const throughIssuer = migrationFolderThrough(10);
    await migrate(drizzle(client), { migrationsFolder: throughIssuer });
    await client.exec(`
      INSERT INTO "user" ("id", "name", "email", "email_verified")
      VALUES ('owner-a', 'Owner A', 'owner-a@dork.test', true);
      INSERT INTO "instance" (
        "id", "user_id", "name", "platform", "dorkos_version", "created_at", "last_seen_at"
      ) VALUES (
        'instance-a', 'owner-a', 'Owner laptop', 'darwin', '1.0.0', now(), now()
      );
      INSERT INTO "account" (
        "id", "account_id", "provider_id", "user_id", "issuer", "created_at", "updated_at"
      ) VALUES (
        'credential-a', 'owner-a@dork.test', 'credential', 'owner-a', 'local:credential', now(), now()
      );
    `);

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });

    const owner = await client.query<{ email: string }>(
      `SELECT email FROM "user" WHERE id = 'owner-a'`
    );
    const account = await client.query<{ issuer: string; account_id: string }>(
      `SELECT issuer, account_id FROM "account" WHERE id = 'credential-a'`
    );
    const managedMigration = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ).entries.find((entry: { tag: string }) => entry.tag === MANAGED_MIGRATION_TAG);

    expect(managedMigration).toBeDefined();
    expect(owner.rows).toEqual([{ email: 'owner-a@dork.test' }]);
    expect(account.rows).toEqual([{ issuer: 'local:credential', account_id: 'owner-a@dork.test' }]);
    expect(await publicTables(client)).toContain('managed_connector_execution_attempt');
  });
});
