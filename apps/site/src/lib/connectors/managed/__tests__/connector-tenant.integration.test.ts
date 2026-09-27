/**
 * @vitest-environment node
 */

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as siteSchema from '@/db/schema';
import { resolveConnectorTenant, type ManagedConnectorDatabase } from '../authority-service';
import { provisionManagedTestDatabase } from './managed-database-fixture';

// Booting PGlite and replaying the managed migrations costs seconds per case
// under load; the sibling integration suites measured the same 5-15s band.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('resolveConnectorTenant over a non-unique owner index', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;
  let queries: Array<{ query: string; params: unknown[] }>;

  beforeEach(async () => {
    client = new PGlite();
    await provisionManagedTestDatabase(client);
    queries = [];
    db = drizzle(client, {
      schema: siteSchema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    }) as unknown as ManagedConnectorDatabase;
  });

  afterEach(async () => {
    await client.close();
  });

  async function tenantRows(ownerId: string) {
    return db
      .select()
      .from(siteSchema.connectorTenant)
      .where(eq(siteSchema.connectorTenant.ownerUserId, ownerId));
  }

  async function capacityRows(tenantId: string) {
    return db
      .select()
      .from(siteSchema.managedConnectorEventCapacity)
      .where(eq(siteSchema.managedConnectorEventCapacity.tenantId, tenantId));
  }

  it('runs against an owner index that does not enforce one tenant per owner', async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'connector_tenant' AND indexdef LIKE '%(owner_user_id)%'`
    );
    expect(rows).toEqual([
      {
        indexname: 'connector_tenant_owner_idx',
        indexdef: expect.not.stringContaining('UNIQUE'),
      },
    ]);
  });

  it('creates one tenant, with its event capacity, on the first request', async () => {
    const tenant = await resolveConnectorTenant(db, 'owner-a');

    expect(tenant.ownerUserId).toBe('owner-a');
    expect(await tenantRows('owner-a')).toEqual([expect.objectContaining({ id: tenant.id })]);
    expect(await capacityRows(tenant.id)).toHaveLength(1);
  });

  it('reuses the existing tenant instead of creating another', async () => {
    const first = await resolveConnectorTenant(db, 'owner-a');
    const second = await resolveConnectorTenant(db, 'owner-a');

    expect(second).toEqual(first);
    expect(await tenantRows('owner-a')).toHaveLength(1);
    expect(await capacityRows(first.id)).toHaveLength(1);
  });

  // PGlite runs every transaction on one connection, so these requests run one
  // after another and this case cannot race. It documents the intent; the
  // ordering test below ("serializes each owner…") is what guards the lock.
  it('creates exactly one tenant when first requests for one owner arrive together', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => resolveConnectorTenant(db, 'owner-a'))
    );

    const ids = new Set(results.map((tenant) => tenant.id));
    expect(ids.size).toBe(1);
    expect(await tenantRows('owner-a')).toHaveLength(1);
    expect(await capacityRows([...ids][0]!)).toHaveLength(1);
  });

  it('serializes each owner on its own advisory lock before reading', async () => {
    await resolveConnectorTenant(db, 'owner-a');
    await resolveConnectorTenant(db, 'owner-b');

    const lockIndexes = queries.flatMap((entry, index) =>
      entry.query.includes('pg_advisory_xact_lock') ? [index] : []
    );
    expect(lockIndexes.map((index) => queries[index]!.params)).toEqual([
      ['connector_tenant:owner-a'],
      ['connector_tenant:owner-b'],
    ]);
    // Each lock is the first statement of its call, ahead of the tenant read.
    for (const index of lockIndexes) {
      expect(queries[index + 1]!.query).toMatch(/^select .* from "connector_tenant"/);
    }
  });

  it('always returns the oldest of several existing tenants and adds none', async () => {
    await client.exec(`
      INSERT INTO connector_tenant (id, owner_user_id, created_at) VALUES
        ('33333333-3333-4333-8333-333333333333', 'owner-a', '2026-09-02T00:00:00Z'),
        ('22222222-2222-4222-8222-222222222222', 'owner-a', '2026-09-01T00:00:00Z');
    `);

    const picks = await Promise.all([
      resolveConnectorTenant(db, 'owner-a'),
      resolveConnectorTenant(db, 'owner-a'),
    ]);
    picks.push(await resolveConnectorTenant(db, 'owner-a'));

    expect(picks.map((tenant) => tenant.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(await tenantRows('owner-a')).toHaveLength(2);
  });

  it('breaks a created_at tie between duplicates by id', async () => {
    await client.exec(`
      INSERT INTO connector_tenant (id, owner_user_id, created_at) VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner-a', '2026-09-01T00:00:00Z'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner-a', '2026-09-01T00:00:00Z');
    `);

    const first = await resolveConnectorTenant(db, 'owner-a');
    const second = await resolveConnectorTenant(db, 'owner-a');

    expect(first.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(second.id).toBe(first.id);
  });
});
