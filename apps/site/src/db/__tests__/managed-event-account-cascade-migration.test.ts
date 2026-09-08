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
// here pays it: at a load average of 280 this file failed with `Test timed out
// in 5000ms` at 5503ms, on a branch that touches nothing near it (DOR-1886).
// One database per case is what the 0013-vs-head states under test require, so
// the budget moves rather than the fixture.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const clients: PGlite[] = [];
const folders: string[] = [];

function migrationsThrough(lastIndex: number): string {
  const folder = mkdtempSync(join(tmpdir(), 'dorkos-event-cascade-migrations-'));
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
      entries: journal.entries.filter(({ idx }) => idx <= lastIndex),
    })
  );
  return folder;
}

async function createClient(): Promise<PGlite> {
  const client = new PGlite();
  clients.push(client);
  return client;
}

async function seedEventGraph(client: PGlite): Promise<void> {
  await client.exec(`
    INSERT INTO "user"(id, name, email, email_verified)
    VALUES ('owner-a', 'Owner A', 'owner-a@dork.test', true);
    INSERT INTO instance(id, user_id, name, platform, dorkos_version)
    VALUES ('instance-a', 'owner-a', 'Laptop A', 'darwin', '1.0.0');
    INSERT INTO connector_tenant(id, owner_user_id, provider_user_id)
    VALUES (
      '11111111-1111-4111-8111-111111111111',
      'owner-a',
      '22222222-2222-4222-8222-222222222222'
    );
    INSERT INTO managed_connector_provider(
      tenant_id, id, provider_type, configuration_digest
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'managed:composio',
      'composio',
      'digest-a'
    );
    INSERT INTO managed_connector_connection(
      tenant_id, id, originating_instance_id, provider_instance_id, provider_user_id,
      external_account_ref, toolkit, auth_config_id, label, lifecycle,
      authentication_status, material_generation
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'gmail-a',
      'instance-a',
      'managed:composio',
      '22222222-2222-4222-8222-222222222222',
      'ca-a',
      'gmail',
      'ac-a',
      'Gmail A',
      'active',
      'active',
      1
    );
    INSERT INTO managed_connector_event_definition(
      tenant_id, id, provider_instance_id, toolkit, event_type, definition_hash, definition
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'managed:composio',
      'gmail',
      'GMAIL_NEW_MESSAGE',
      'definition-a',
      '{}'
    );
    INSERT INTO managed_connector_event_binding(
      tenant_id, id, provider_instance_id, provider_generation, external_account_ref,
      definition_id, filter_hash, filter, provider_trigger_ref, state
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
      'managed:composio',
      1,
      'ca-a',
      '33333333-3333-4333-8333-333333333333',
      'filter-a',
      '{}',
      'trigger-a',
      'ready'
    );
    INSERT INTO managed_connector_event_subscription(
      tenant_id, id, connection_id, target_instance_id, binding_id, agent_id,
      destination_kind, destination_id, scope_version, connection_generation, enabled
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'subscription-a',
      'gmail-a',
      'instance-a',
      '44444444-4444-4444-8444-444444444444',
      'agent-a',
      'agent',
      'agent-a',
      1,
      1,
      true
    );
    INSERT INTO managed_connector_event_inbox(
      tenant_id, subscription_id, subscription_version, provider_event_id,
      target_instance_id, protected_payload, received_at, expires_at, metadata_expires_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'subscription-a',
      1,
      'event-a',
      'instance-a',
      'encrypted-a',
      now(),
      now() + interval '7 days',
      now() + interval '30 days'
    );
  `);
}

async function migrationHashes(client: PGlite): Promise<string[]> {
  const result = await client.query<{ hash: string }>(
    'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id'
  );
  return result.rows.map(({ hash }) => hash);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('0014 managed event account cascade migration', () => {
  it('proves the populated 0013 schema blocks tenant deletion before the fix', async () => {
    const client = await createClient();
    await migrate(drizzle(client), { migrationsFolder: migrationsThrough(13) });
    await seedEventGraph(client);

    await expect(
      client.query(
        `DELETE FROM connector_tenant
          WHERE id = '11111111-1111-4111-8111-111111111111'`
      )
    ).rejects.toThrow();
  });

  it('upgrades a populated 0013 graph, keeps internal history restrictive, and reruns safely', async () => {
    const client = await createClient();
    await migrate(drizzle(client), { migrationsFolder: migrationsThrough(13) });
    await seedEventGraph(client);

    const database = drizzle(client);
    await migrate(database, { migrationsFolder: MIGRATIONS_DIR });
    const firstHashes = await migrationHashes(client);
    await migrate(database, { migrationsFolder: MIGRATIONS_DIR });
    expect(await migrationHashes(client)).toEqual(firstHashes);

    const directTenantEdges = await client.query<{ child: string; delete_action: string }>(`
      SELECT child.relname AS child, constraint_record.confdeltype::text AS delete_action
        FROM pg_constraint constraint_record
        JOIN pg_class child ON child.oid = constraint_record.conrelid
        JOIN pg_class parent ON parent.oid = constraint_record.confrelid
       WHERE constraint_record.contype = 'f'
         AND parent.relname = 'connector_tenant'
         AND child.relname LIKE 'managed_connector_event_%'
       ORDER BY child.relname
    `);
    expect(directTenantEdges.rows).toEqual([
      { child: 'managed_connector_event_binding', delete_action: 'c' },
      { child: 'managed_connector_event_definition', delete_action: 'c' },
      { child: 'managed_connector_event_inbox', delete_action: 'c' },
      { child: 'managed_connector_event_subscription', delete_action: 'c' },
    ]);

    const internalEventEdges = await client.query<{ delete_action: string }>(`
      SELECT constraint_record.confdeltype::text AS delete_action
        FROM pg_constraint constraint_record
        JOIN pg_class child ON child.oid = constraint_record.conrelid
        JOIN pg_class parent ON parent.oid = constraint_record.confrelid
       WHERE constraint_record.contype = 'f'
         AND child.relname LIKE 'managed_connector_event_%'
         AND parent.relname <> 'connector_tenant'
    `);
    expect(internalEventEdges.rows).toHaveLength(6);
    expect(new Set(internalEventEdges.rows.map(({ delete_action }) => delete_action))).toEqual(
      new Set(['a'])
    );

    await client.query(`DELETE FROM "user" WHERE id = 'owner-a'`);
    for (const table of [
      'connector_tenant',
      'managed_connector_event_definition',
      'managed_connector_event_binding',
      'managed_connector_event_subscription',
      'managed_connector_event_inbox',
    ]) {
      const remaining = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM ${table}`
      );
      expect(remaining.rows[0].count).toBe('0');
    }
  });
});
