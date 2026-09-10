/** Shared synthetic Postgres fixture; contains no live identity, config or credentials. */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../drizzle/', import.meta.url));
const MANAGED_MIGRATION_PREFIXES = ['0011_', '0012_', '0013_', '0015_', '0016_'];

function isolatedMigrationFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'dorkos-managed-connectors-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };
  const selected = MANAGED_MIGRATION_PREFIXES.map((prefix) => {
    const name = readdirSync(MIGRATIONS_DIR).find(
      (file) => file.startsWith(prefix) && file.endsWith('.sql')
    );
    if (!name) throw new Error('Managed migration missing.');
    const entry = journal.entries.find((value) => value.tag === name.slice(0, -4));
    if (!entry) throw new Error('Managed migration journal entry missing.');
    writeFileSync(join(folder, name), readFileSync(join(MIGRATIONS_DIR, name)));
    return entry;
  });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: journal.version,
      dialect: journal.dialect,
      entries: selected.map((entry, idx) => ({ ...entry, idx })),
    })
  );
  return folder;
}

/** Build the real append-only managed schema over isolated synthetic owner/instance rows. */
export async function provisionManagedTestDatabase(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "email_verified" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE "instance" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
      "name" text NOT NULL,
      "platform" text NOT NULL,
      "dorkos_version" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "last_seen_at" timestamp DEFAULT now() NOT NULL,
      "revoked_at" timestamp
    );
    CREATE TABLE "apikey" (
      "id" text PRIMARY KEY NOT NULL,
      "reference_id" text NOT NULL,
      "enabled" boolean DEFAULT true,
      "expires_at" timestamp,
      "permissions" text,
      "metadata" text
    );
    INSERT INTO "user" ("id", "name", "email") VALUES
      ('owner-a', 'Owner A', 'a@dork.test'),
      ('owner-b', 'Owner B', 'b@dork.test');
    INSERT INTO "instance" ("id", "user_id", "name", "platform", "dorkos_version") VALUES
      ('instance-a', 'owner-a', 'A', 'darwin', '1.0.0'),
      ('instance-c', 'owner-a', 'C', 'darwin', '1.0.0'),
      ('instance-b', 'owner-b', 'B', 'linux', '1.0.0');
    INSERT INTO "apikey" ("id", "reference_id", "enabled", "permissions", "metadata") VALUES
      ('key-a', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-a","scope":"instance"}'),
      ('key-c', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-c","scope":"instance"}'),
      ('key-b', 'owner-b', true, '{"instance":["link"],"connectors":["authority","execute","usage"]}', '{"instanceId":"instance-b","scope":"instance"}');
  `);
  const folder = isolatedMigrationFolder();
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
