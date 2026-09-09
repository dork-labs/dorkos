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

// The over-limit case migrates a real PGlite database containing 100,001 rows.
// It timed out at vitest's 5s default on all three normal-hook attempts, while
// the unchanged file passed 2/2 in 2.99s alone. The aggregate cause is unproven,
// so keep the real ceiling proof and use the repo's measured 30s PGlite budget.
vi.setConfig({ testTimeout: 30_000 });

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const clients: PGlite[] = [];
const folders: string[] = [];

function migrationsThrough(lastIndex: number): string {
  const folder = mkdtempSync(join(tmpdir(), 'dorkos-event-capacity-migrations-'));
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

async function seedTenantGraph(client: PGlite): Promise<void> {
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
  `);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('0015 managed event capacity migration', () => {
  it('backfills exact retained rows, stored bytes and earliest capacity-changing expiry', async () => {
    const client = await createClient();
    await migrate(drizzle(client), { migrationsFolder: migrationsThrough(14) });
    await seedTenantGraph(client);
    await client.exec(`
      INSERT INTO "user"(id, name, email, email_verified)
      VALUES ('owner-empty', 'Owner Empty', 'owner-empty@dork.test', true);
      INSERT INTO connector_tenant(id, owner_user_id, provider_user_id)
      VALUES (
        '55555555-5555-4555-8555-555555555555',
        'owner-empty',
        '66666666-6666-4666-8666-666666666666'
      );
      INSERT INTO managed_connector_event_inbox(
        tenant_id, subscription_id, subscription_version, provider_event_id,
        target_instance_id, protected_payload, received_at, expires_at, metadata_expires_at
      ) VALUES
        (
          '11111111-1111-4111-8111-111111111111', 'subscription-a', 1, 'event-a',
          'instance-a', 'abc', '2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z',
          '2026-01-30T00:00:00Z'
        ),
        (
          '11111111-1111-4111-8111-111111111111', 'subscription-a', 1, 'event-b',
          'instance-a', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
          '2026-01-20T00:00:00Z'
        ),
        (
          '11111111-1111-4111-8111-111111111111', 'subscription-a', 1, 'event-c',
          'instance-a', 'é', '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z',
          '2026-01-05T00:00:00Z'
        );
    `);

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    const rows = await client.query<{
      tenant_id: string;
      accepted_in_window: number;
      retained_rows: number;
      protected_payload_bytes: string;
      next_cleanup_at: Date | null;
    }>(`
      SELECT tenant_id, accepted_in_window, retained_rows,
             protected_payload_bytes::text, next_cleanup_at
        FROM managed_connector_event_capacity
       ORDER BY tenant_id
    `);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      tenant_id: '11111111-1111-4111-8111-111111111111',
      accepted_in_window: 0,
      retained_rows: 3,
      protected_payload_bytes: '5',
    });
    expect(new Date(rows.rows[0].next_cleanup_at!).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(rows.rows[1]).toMatchObject({
      tenant_id: '55555555-5555-4555-8555-555555555555',
      accepted_in_window: 0,
      retained_rows: 0,
      protected_payload_bytes: '0',
      next_cleanup_at: null,
    });

    const checks = await client.query<{ name: string }>(`
      SELECT conname AS name
        FROM pg_constraint
       WHERE conrelid = 'managed_connector_event_capacity'::regclass
         AND contype = 'c'
       ORDER BY conname
    `);
    expect(checks.rows.map(({ name }) => name)).toEqual([
      'managed_event_capacity_accepted_nonnegative',
      'managed_event_capacity_bytes_nonnegative',
      'managed_event_capacity_rows_nonnegative',
    ]);
    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'managed_connector_event_capacity'
       ORDER BY indexname
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'managed_event_capacity_cleanup_idx'
    );
    await expect(
      client.exec(`
        UPDATE managed_connector_event_capacity SET retained_rows = -1
        WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
      `)
    ).rejects.toThrow();
    await client.exec(`DELETE FROM "user" WHERE id = 'owner-a'`);
    expect(
      (
        await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM managed_connector_event_capacity ORDER BY tenant_id`
        )
      ).rows
    ).toEqual([{ tenant_id: '55555555-5555-4555-8555-555555555555' }]);
  });

  it('refuses an existing tenant above the retained-row ceiling without truncating receipts', async () => {
    const client = await createClient();
    await migrate(drizzle(client), { migrationsFolder: migrationsThrough(14) });
    await seedTenantGraph(client);
    await client.exec(`
      INSERT INTO managed_connector_event_inbox(
        tenant_id, subscription_id, subscription_version, provider_event_id,
        target_instance_id, protected_payload, received_at, expires_at, metadata_expires_at
      )
      SELECT
        '11111111-1111-4111-8111-111111111111', 'subscription-a', 1,
        'event-' || value::text, 'instance-a', '', now(), now() + interval '7 days',
        now() + interval '30 days'
      FROM generate_series(1, 100001) AS value;
    `);

    await expect(migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow(
      'retained storage exceeds the service ceiling'
    );
    const retained = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM managed_connector_event_inbox`
    );
    expect(retained.rows[0].count).toBe('100001');
  });
});
