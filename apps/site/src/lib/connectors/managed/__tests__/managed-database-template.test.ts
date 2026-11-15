/**
 * @vitest-environment node
 *
 * The managed suites test tenant isolation, authority and revocation against a
 * COPY of one provisioned database instead of provisioning their own (DOR-4190).
 * That is only sound if a copy is indistinguishable from a database provisioned
 * from scratch, and if no copy can see another's writes. This pins both.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createManagedTestDatabaseTemplate,
  provisionManagedTestDatabase,
  type PGliteTemplate,
} from './managed-database-fixture';

// A fresh provision and a template build each boot PGlite and replay the managed
// migrations; same 5-15s band under load as the managed integration suites.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Catalogue views that together describe everything a test could depend on. */
const CATALOGUE = {
  tables: `SELECT table_schema, table_name, table_type FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
  columns: `SELECT table_schema, table_name, column_name, ordinal_position, data_type, udt_name,
                   is_nullable, column_default, character_maximum_length, numeric_precision
            FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 4`,
  constraints: `SELECT n.nspname, conrelid::regclass::text AS tbl, conname, contype,
                       pg_get_constraintdef(c.oid) AS def
                FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3`,
  indexes: `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3`,
  sequences: `SELECT schemaname, sequencename, data_type, start_value, increment_by, last_value
              FROM pg_sequences ORDER BY 1, 2`,
  types: `SELECT n.nspname, t.typname, t.typtype,
                 array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          LEFT JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND t.typtype IN ('e', 'd')
          GROUP BY 1, 2, 3 ORDER BY 1, 2`,
  functions: `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
                     md5(p.prosrc) AS body
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3`,
  triggers: `SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def
             FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
  roles: `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                 rolbypassrls
          FROM pg_roles ORDER BY 1`,
  grants: `SELECT grantee, table_schema, table_name, privilege_type, is_grantable
           FROM information_schema.role_table_grants
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3, 4`,
  rowSecurity: `SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
  policies: `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
             FROM pg_policies ORDER BY 1, 2, 3`,
  migrations: `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
  seededOwners: `SELECT id, name, email FROM "user" ORDER BY id`,
  seededInstances: `SELECT id, user_id, revoked_at FROM "instance" ORDER BY id`,
  seededKeys: `SELECT id, reference_id, enabled, permissions, metadata FROM "apikey" ORDER BY id`,
} as const;

async function catalogue(client: PGlite): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, query] of Object.entries(CATALOGUE)) {
    out[name] = (await client.query(query)).rows;
  }
  return out;
}

describe('managed test database template', () => {
  let template: PGliteTemplate;
  let provisioned: PGlite;

  beforeAll(async () => {
    template = await createManagedTestDatabaseTemplate();
    provisioned = new PGlite();
    await provisionManagedTestDatabase(provisioned);
  });

  afterAll(async () => {
    await provisioned.close();
  });

  it('gives a copy the same schema, migration history, roles, grants and rows as a fresh provision', async () => {
    const copy = await template.fresh();
    try {
      const expected = await catalogue(provisioned);
      const actual = await catalogue(copy);
      for (const name of Object.keys(CATALOGUE)) {
        expect({ [name]: actual[name] }).toEqual({ [name]: expected[name] });
      }
      // Guard against the comparison silently going vacuous.
      expect(expected.tables.length).toBeGreaterThan(15);
      expect(expected.columns.length).toBeGreaterThan(150);
      expect(expected.constraints.length).toBeGreaterThan(40);
      expect(expected.indexes.length).toBeGreaterThan(20);
      expect(expected.migrations).toHaveLength(5);
      expect(expected.seededInstances).toHaveLength(3);
    } finally {
      await copy.close();
    }
  });

  it('keeps every copy independent of every other and of the template', async () => {
    const a = await template.fresh();
    const b = await template.fresh();
    try {
      await a.exec(`
        INSERT INTO "user" ("id", "name", "email") VALUES ('owner-x', 'X', 'x@dork.test');
        UPDATE "instance" SET "revoked_at" = now() WHERE "id" = 'instance-a';
        DELETE FROM "apikey" WHERE "id" = 'key-b';
        CREATE TABLE "only_in_a" ("id" text PRIMARY KEY);
      `);
      // Another live copy sees none of it.
      expect(await catalogue(b)).toEqual(await catalogue(provisioned));
      await b.exec(
        `INSERT INTO "user" ("id", "name", "email") VALUES ('owner-y', 'Y', 'y@dork.test')`
      );
      const owners = await a.query<{ id: string }>(`SELECT id FROM "user" ORDER BY id`);
      expect(owners.rows.map((r) => r.id)).toEqual(['owner-a', 'owner-b', 'owner-x']);

      // And a copy taken after both wrote is still the provisioned state.
      const c = await template.fresh();
      try {
        expect(await catalogue(c)).toEqual(await catalogue(provisioned));
      } finally {
        await c.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
