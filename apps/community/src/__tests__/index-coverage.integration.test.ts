import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';

/**
 * Postgres indexes the referenced side of a foreign key and never the referencing side. Without
 * an index there, every delete of a parent row (and every change to its key) scans the child
 * table once per row, inside the deleting transaction. A community's deletion, a member's
 * erasure and an account's erasure all delete parents in bulk, so one missing index turns them
 * from seconds into hours (migration 0024 measured 45 s to 3 s for 20,000 messages).
 *
 * These tests read the migrated catalog. A new foreign key must come with an index whose
 * leading column is one of its columns, or a line below saying why the child table stays small.
 */

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_index_coverage_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
let db: Pool;

const HOST_TABLE = 'a host-level table with a handful of rows per operator or key';
const EXPIRING = 'rows expire and a sweep deletes them, so the table stays small';
const ONE_PER_JOB = 'one row per import or deletion job';
const PER_COMMUNITY_FEW = 'a few rows per community, reached through community_id';

/** Foreign keys allowed without a leading index, by constraint name, with the reason. */
const UNINDEXED_FOREIGN_KEYS: Record<string, string> = {
  bootstrap_grants_revoked_by_api_key_id_fkey: HOST_TABLE,
  bootstrap_grants_revoked_by_fkey: HOST_TABLE,
  community_creation_receipts_operator_api_key_id_fkey: HOST_TABLE,
  community_creation_receipts_operator_user_id_fkey: HOST_TABLE,
  host_api_keys_issued_by_user_id_fkey: HOST_TABLE,
  host_api_keys_revoked_by_user_id_fkey: HOST_TABLE,
  host_api_keys_successor_id_fkey: HOST_TABLE,
  host_audit_events_actor_api_key_id_fkey: HOST_TABLE,
  host_audit_events_actor_user_id_fkey: HOST_TABLE,
  host_audit_events_subject_api_key_id_fkey: HOST_TABLE,
  tenant_reconciliation_community_id_fkey: 'a single row',
  pending_admissions_invite_id_fkey: EXPIRING,
  pending_admissions_invite_tenant_fk: EXPIRING,
  admission_receipts_invite_id_fkey: EXPIRING,
  admission_receipts_invite_tenant_fk: EXPIRING,
  admission_receipts_member_id_fkey: EXPIRING,
  admission_receipts_member_tenant_fk: EXPIRING,
  export_archives_requester_member_id_fkey:
    'archives expire; the tenant key is served by export_archives_requester_idx',
  community_deletion_jobs_requester_tenant_fk: ONE_PER_JOB,
  community_imports_adopt_member_id_fkey: ONE_PER_JOB,
  community_imports_created_by_api_key_id_fkey: ONE_PER_JOB,
  community_imports_created_by_user_id_fkey: ONE_PER_JOB,
  erasure_requests_member_tenant_fk: PER_COMMUNITY_FEW,
  erasure_requests_user_id_fkey: 'one row per erasure request',
  invites_channel_fk: PER_COMMUNITY_FEW,
  invites_channel_tenant_fk: PER_COMMUNITY_FEW,
  invites_issuer_member_id_fkey: PER_COMMUNITY_FEW,
  invites_issuer_tenant_fk: PER_COMMUNITY_FEW,
  community_takedowns_actor_api_key_id_fkey: `${HOST_TABLE}: one row per host takedown`,
  community_takedowns_actor_user_id_fkey: `${HOST_TABLE}: one row per host takedown`,
  community_takedowns_released_by_user_id_fkey: `${HOST_TABLE}: one row per host takedown`,
  // From migration 0022 (owner replacement, #2350). Listed before it lands; see the stale check.
  owner_replacements_prior_owner_tenant_fk: `${PER_COMMUNITY_FEW}: one row per owner replacement`,
  owner_replacements_new_owner_tenant_fk: `${PER_COMMUNITY_FEW}: one row per owner replacement`,
  owner_replacement_object_tokens_community_id_fkey:
    'a few short-lived tokens per replacement, reached through replacement_id',
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl.toString());
  db = new Pool({ connectionString: testUrl.toString() });
});

afterAll(async () => {
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

interface IndexRow {
  table: string;
  name: string;
  columns: string[];
  predicate: string | null;
  unique: boolean;
}

/**
 * Plain-column btree indexes in the public schema, with their KEY columns in order. INCLUDE
 * columns are left out: they ride along in the leaf pages but cannot be searched on.
 */
async function indexes(): Promise<IndexRow[]> {
  const result = await db.query<IndexRow>(
    `SELECT t.relname AS table, c.relname AS name, i.indisunique AS unique,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            array(SELECT a.attname::text
                  FROM unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) WITH ORDINALITY k(n, o)
                  JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n
                  ORDER BY k.o) AS columns
     FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
     JOIN pg_am am ON am.oid=c.relam
     WHERE t.relnamespace='public'::regnamespace AND i.indexprs IS NULL AND am.amname='btree'`
  );
  return result.rows;
}

/**
 * Whether an index can find a foreign key's child rows by the parent's key. Its first column
 * must be one of the key's columns, and not only community_id, which would read the whole
 * community per row. A partial index serves only when its predicate is `<key column> IS NOT
 * NULL`, which the check's equality implies.
 */
function serves(index: IndexRow, columns: string[]): boolean {
  const [first, second] = index.columns;
  if (!columns.includes(first)) return false;
  const tenantOnly = first === 'community_id' && !(second && columns.includes(second));
  if (tenantOnly && columns.join() !== 'community_id') return false;
  if (index.predicate === null) return true;
  return columns.some((column) =>
    new RegExp(`^\\(?${column} IS NOT NULL\\)?$`).test(index.predicate as string)
  );
}

/** Foreign keys in the public schema that no index serves, and every key that exists. */
async function unindexedForeignKeys(): Promise<{ unindexed: string[]; existing: Set<string> }> {
  const all = await indexes();
  const keys = await db.query<{ name: string; table: string; columns: string[] }>(
    `SELECT c.conname AS name, t.relname AS table,
            array(SELECT a.attname::text FROM unnest(c.conkey) k
                  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k) AS columns
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
     WHERE c.contype='f' AND c.connamespace='public'::regnamespace`
  );
  return {
    unindexed: keys.rows
      .filter(
        (key) => !all.some((index) => index.table === key.table && serves(index, key.columns))
      )
      .map((key) => key.name)
      .sort(),
    existing: new Set(keys.rows.map((key) => key.name)),
  };
}

describe('community indexes', () => {
  it('back every foreign key with an index on the referencing columns', async () => {
    const { unindexed, existing } = await unindexedForeignKeys();
    expect(unindexed.filter((name) => !(name in UNINDEXED_FOREIGN_KEYS))).toEqual([]);
    // An allowance for a key that now has an index is stale. One for a key that does not exist
    // is allowed, so a key a pending migration adds can be listed before it lands.
    expect(
      Object.keys(UNINDEXED_FOREIGN_KEYS)
        .filter((name) => existing.has(name) && !unindexed.includes(name))
        .sort()
    ).toEqual([]);
  });

  it('count an INCLUDE column as no support for a foreign key', async () => {
    await db.query(`CREATE TABLE index_probe_parent (id uuid PRIMARY KEY)`);
    await db.query(
      `CREATE TABLE index_probe_child (id uuid PRIMARY KEY, x int,
         parent_id uuid CONSTRAINT index_probe_child_parent_fkey REFERENCES index_probe_parent(id))`
    );
    try {
      await db.query(
        `CREATE INDEX index_probe_include ON index_probe_child(x) INCLUDE (parent_id)`
      );
      expect((await unindexedForeignKeys()).unindexed).toContain('index_probe_child_parent_fkey');
      await db.query(`CREATE INDEX index_probe_key ON index_probe_child(parent_id)`);
      expect((await unindexedForeignKeys()).unindexed).not.toContain(
        'index_probe_child_parent_fkey'
      );
    } finally {
      await db.query(`DROP TABLE index_probe_child, index_probe_parent`);
    }
  });

  it('keep no index that is only the leading columns of another', async () => {
    const all = (await indexes()).filter((index) => index.predicate === null);
    const redundant = all
      .filter((index) => !index.unique)
      .flatMap((index) =>
        all
          .filter(
            (other) =>
              other.table === index.table &&
              other.name !== index.name &&
              other.columns.length >= index.columns.length &&
              index.columns.every((column, position) => other.columns[position] === column)
          )
          .map((other) => `${index.name} (covered by ${other.name})`)
      );
    expect(redundant).toEqual([]);
  });
});
