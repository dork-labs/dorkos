import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { channelRoster, CHANNEL_ROSTER_SQL } from '../content/roster.js';
import { channelWatermarks, CHANNEL_WATERMARK_SQL } from '../content/watermark.js';
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
 * Each tenant reference is declared once: a tenant key (community_id, x) already enforces the
 * plain key on x, and a second key only doubles the checks every insert and delete runs (0027).
 *
 * The last block runs the queries that once read a whole community or host per job or per post
 * (DOR-2572) against a seeded host, and bounds the rows their plans read.
 */

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_index_coverage_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
// One Client, not a Pool: `Pool.end()` resolves as soon as its idle clients leave its list,
// before their sockets close, and the pool's idle-error listener stays on them. The
// `DROP DATABASE … WITH (FORCE)` below could then terminate a backend still shutting down, and
// its 57P01 reached a pool with no error listener: an unhandled error that failed the whole run
// in the merge queue. `Client.end()` resolves only once the connection has closed.
let db: Client;

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
  pending_admissions_invite_tenant_fk: EXPIRING,
  admission_receipts_invite_tenant_fk: EXPIRING,
  admission_receipts_member_tenant_fk: EXPIRING,
  community_deletion_jobs_requester_tenant_fk: ONE_PER_JOB,
  community_imports_adopt_member_id_fkey: ONE_PER_JOB,
  community_imports_created_by_api_key_id_fkey: ONE_PER_JOB,
  community_imports_created_by_user_id_fkey: ONE_PER_JOB,
  erasure_requests_member_tenant_fk: PER_COMMUNITY_FEW,
  erasure_requests_user_id_fkey: 'one row per erasure request',
  invites_channel_tenant_fk: PER_COMMUNITY_FEW,
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

/**
 * Plain keys kept beside a tenant key on the same reference, by constraint name, with the reason.
 */
const PLAIN_KEYS_KEPT: Record<string, string> = {
  admission_receipts_admission_id_fkey:
    'ON DELETE CASCADE removes a receipt with its admission; the tenant key is NO ACTION',
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl.toString());
  db = new Client({ connectionString: testUrl.toString() });
  await db.connect();
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

  it('declare each tenant reference once', async () => {
    // A plain key x -> parent(id) beside a tenant key (community_id, x) -> parent(community_id,
    // id) on the same table. With community_id NOT NULL, the tenant key enforces all the plain
    // key does, so the plain one is a second check on every insert and parent delete.
    const duplicated = await db.query<{ name: string }>(
      `SELECT p.conname AS name
       FROM pg_constraint p JOIN pg_constraint t
         ON t.conrelid=p.conrelid AND t.confrelid=p.confrelid AND t.contype='f'
        AND cardinality(p.conkey)=1 AND cardinality(t.conkey)=2
        AND t.conkey[2]=p.conkey[1] AND t.confkey[2]=p.confkey[1]
        AND t.conkey[1]=(SELECT attnum FROM pg_attribute
                         WHERE attrelid=p.conrelid AND attname='community_id')
        AND t.confkey[1]=(SELECT attnum FROM pg_attribute
                          WHERE attrelid=p.confrelid AND attname='community_id')
       WHERE p.contype='f' AND p.connamespace='public'::regnamespace
       ORDER BY 1`
    );
    // Equal, not a subset: a kept key that is no longer duplicated is a stale allowance.
    expect(duplicated.rows.map((row) => row.name)).toEqual(Object.keys(PLAIN_KEYS_KEPT).sort());
  });
});

/** A plan node from `EXPLAIN (ANALYZE, FORMAT JSON)`, with only the fields read here. */
interface PlanNode {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

/**
 * Rows a query's plan read from a table: those it kept and those its filters dropped. With
 * `hashJoins`, nested loops are priced out, as the planner itself does once a channel is large
 * enough that probing row by row costs more than reading a table whole; a join that does not
 * name the community then has to read every row of the table on the host.
 */
async function rowsRead(
  sql: string,
  values: unknown[],
  table: string,
  hashJoins = false
): Promise<number> {
  await db.query('BEGIN');
  try {
    if (hashJoins) await db.query('SET LOCAL enable_nestloop = off');
    const result = await db.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      values
    );
    const walk = (node: PlanNode): number =>
      (node['Relation Name'] === table
        ? (node['Actual Rows'] +
            (node['Rows Removed by Filter'] ?? 0) +
            (node['Rows Removed by Index Recheck'] ?? 0)) *
          node['Actual Loops']
        : 0) + (node.Plans ?? []).reduce((sum, child) => sum + walk(child), 0);
    return walk(result.rows[0]['QUERY PLAN'][0].Plan);
  } finally {
    await db.query('ROLLBACK');
  }
}

/** A deterministic id for the seeded host below. */
const seeded = (name: string) => {
  const hex = createHash('md5').update(`guard:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

describe('per-job and per-post queries', () => {
  // Community a: 300 members, 30 agents, four channels of 5,000 messages and an empty fifth.
  // Community b stands for the rest of the host: 20,000 members, 2,000 agents, one channel.
  // Channel a:c:1 holds 250 of a's members and 20 of its agents.
  beforeAll(async () => {
    await db.query(`
      CREATE FUNCTION pg_temp.g(t text) RETURNS uuid LANGUAGE sql IMMUTABLE
        AS $$ SELECT md5('guard:'||t)::uuid $$;
      INSERT INTO "user"(id,name,email,"emailVerified")
      SELECT 'guard-'||i,'Guard '||i,'guard'||i||'@example.test',true
      FROM generate_series(1,20300) i;
      INSERT INTO communities(id,name,lifecycle,activated_at)
      VALUES (pg_temp.g('a'),'Small','active',now()),(pg_temp.g('b'),'Large','active',now());
      INSERT INTO members(id,community_id,user_id,display_name,handle,role,active)
      SELECT pg_temp.g(c||':m:'||i),pg_temp.g(c),'guard-'||(CASE c WHEN 'a' THEN i ELSE 300+i END),
        'Member '||i,'m'||i,CASE WHEN i=1 THEN 'owner' ELSE 'member' END,i%50<>0
      FROM (VALUES ('a',300),('b',20000)) AS size(c,n), generate_series(1,n) i;
      INSERT INTO agents(id,community_id,owner_member_id,display_name,handle,local_agent_id,active)
      SELECT pg_temp.g(c||':a:'||i),pg_temp.g(c),pg_temp.g(c||':m:'||(i%100+1)),'Agent '||i,
        'a'||i,'local-'||i,true
      FROM (VALUES ('a',30),('b',2000)) AS size(c,n), generate_series(1,n) i;
      INSERT INTO channels(id,community_id,name,visibility)
      SELECT pg_temp.g(c||':c:'||k),pg_temp.g(c),'channel-'||k,'public'
      FROM (VALUES ('a',5),('b',1)) AS size(c,n), generate_series(1,n) k;
      INSERT INTO channel_members(community_id,channel_id,member_id)
      SELECT pg_temp.g(c),pg_temp.g(c||':c:1'),pg_temp.g(c||':m:'||i)
      FROM (VALUES ('a',250),('b',20000)) AS size(c,n), generate_series(1,n) i;
      INSERT INTO agent_channel_members(community_id,channel_id,agent_id)
      SELECT pg_temp.g(c),pg_temp.g(c||':c:1'),pg_temp.g(c||':a:'||i)
      FROM (VALUES ('a',20),('b',2000)) AS size(c,n), generate_series(1,n) i;
      INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
        idempotency_key,payload_hash)
      SELECT pg_temp.g(c),pg_temp.g(c||':c:'||k),s,pg_temp.g(c||':m:'||(s%250+1)),'Member',
        'hello','k'||s,'h'
      FROM (VALUES ('a',4),('b',1)) AS size(c,n), generate_series(1,n) k,
        generate_series(1,5000) s;
      ANALYZE;
    `);
  }, 120_000);

  it('read one index entry per channel for a watermark', async () => {
    // Purpose: fails if the export or erasure watermark reads the community's messages again,
    // or stops matching the GROUP BY it replaced.
    const community = seeded('a');
    const replaced = await db.query<{ channel_id: string; seq: string }>(
      'SELECT channel_id,max(seq)::text AS seq FROM entries WHERE community_id=$1 GROUP BY channel_id',
      [community]
    );
    const marks = await channelWatermarks(db, community);
    expect(marks).toEqual(new Map(replaced.rows.map((row) => [row.channel_id, Number(row.seq)])));
    expect(marks.size).toBe(4);
    // The empty channel has no mark; another community's channel matches nothing.
    expect(
      await channelWatermarks(db, community, [seeded('a:c:2'), seeded('a:c:5'), seeded('b:c:1')])
    ).toEqual(new Map([[seeded('a:c:2'), 5000]]));
    expect(await rowsRead(CHANNEL_WATERMARK_SQL, [community, null], 'entries')).toBeLessThanOrEqual(
      5
    );
  });

  it("read only the channel's community for a roster", async () => {
    // Purpose: fails if the mention or roster query reads other communities' members or agents
    // again, or stops returning what the query it replaced returned.
    const [community, channel] = [seeded('a'), seeded('a:c:1')];
    const replaced = await db.query(
      `SELECT m.id,m.display_name,m.handle,m.role,NULL::uuid AS owner_member_id,
         NULL::text AS owner_display_name,'human'::text AS kind,cm.joined_at
       FROM channel_members cm JOIN members m ON m.id=cm.member_id
       WHERE cm.channel_id=$1 AND m.active
       UNION ALL SELECT a.id,a.display_name,a.handle,NULL::text AS role,a.owner_member_id,
         owner.display_name AS owner_display_name,'agent'::text AS kind,acm.joined_at
       FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
       JOIN members owner ON owner.id=a.owner_member_id
       WHERE acm.channel_id=$1 AND a.active AND owner.active
       ORDER BY joined_at,id`,
      [channel]
    );
    const roster = await channelRoster(db, channel, community);
    expect(roster).toEqual(replaced.rows);
    expect(roster.filter((row) => row.kind === 'human')).toHaveLength(245);
    expect(roster.filter((row) => row.kind === 'agent')).toHaveLength(20);
    expect(await channelRoster(db, channel, seeded('b'))).toEqual([]);
    // Community a has 300 members and 30 agents; the host has 20,300 and 2,030. Whichever join
    // the planner picks, the roster reads within community a: about 314 member rows by probes,
    // or a's 300 members twice (once for people, once for agents' owners) by hashing. A join on
    // id alone, without the community, reads all 20,300 once the planner hashes it.
    for (const hashJoins of [false, true]) {
      expect(
        await rowsRead(CHANNEL_ROSTER_SQL, [channel, community], 'members', hashJoins)
      ).toBeLessThanOrEqual(2 * 300);
      expect(
        await rowsRead(CHANNEL_ROSTER_SQL, [channel, community], 'agents', hashJoins)
      ).toBeLessThanOrEqual(30);
    }
  });
});
