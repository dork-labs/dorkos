import type { PoolClient } from 'pg';
import type { ExportScope } from './authority.js';
import { fileNumber } from './data-segments.js';

/** Most rows in one collection file. */
export const COLLECTION_FILE_ROWS = 100_000;
/** Rows read per query. */
const PAGE_ROWS = 1_000;

/** The manifest's name for each collection. */
export type CollectionKey =
  'channels' | 'members' | 'agents' | 'channelMembers' | 'agentChannelMembers' | 'auditEvents';

/** Files and rows written for one collection. */
export interface CollectionTally {
  files: string[];
  count: number;
}

/** Every collection's tally, in manifest order. */
export type CollectionTallies = Record<CollectionKey, CollectionTally>;

/** A fresh, empty tally for every collection. */
export function emptyTallies(): CollectionTallies {
  return {
    channels: { files: [], count: 0 },
    members: { files: [], count: 0 },
    agents: { files: [], count: 0 },
    channelMembers: { files: [], count: 0 },
    agentChannelMembers: { files: [], count: 0 },
    auditEvents: { files: [], count: 0 },
  };
}

/** Whose collections an export writes. */
export interface CollectionScope {
  communityId: string;
  scope: ExportScope;
  memberId: string;
  /** Personal scope: the exported channels. */
  channelIds: readonly string[];
}

interface KeyColumn {
  column: string;
  type: 'uuid' | 'timestamptz';
  field: string;
}

interface CollectionSpec {
  key: CollectionKey;
  prefix: string;
  /** `SELECT ... WHERE ...` with `$1` community, `$2` member, `$3` channels. */
  select: string;
  keys: KeyColumn[];
  line(row: Record<string, unknown>): string;
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
const uuidKey = (column: string, field: string): KeyColumn => ({ column, type: 'uuid', field });

function specs(scope: ExportScope): CollectionSpec[] {
  const owner = scope === 'owner';
  const list: CollectionSpec[] = [
    {
      key: 'channels',
      prefix: 'channels',
      select: `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at FROM channels c
        WHERE c.community_id=$1 ${owner ? '' : 'AND c.id=ANY($3::uuid[])'}`,
      keys: [uuidKey('c.id', 'id')],
      line: (row) =>
        JSON.stringify({
          id: row.id,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          archived: row.archived,
          created_at: iso(row.created_at),
        }),
    },
    {
      key: 'members',
      prefix: 'members',
      // LEFT JOIN: an erased member keeps their husk row, with no account and so no email. A
      // personal export holds only the requester's own row.
      select: `SELECT m.id,m.display_name,m.handle,m.role,m.active,m.created_at,m.removed_at,u.email
        FROM members m LEFT JOIN "user" u ON u.id=m.user_id
        WHERE m.community_id=$1 ${owner ? '' : 'AND m.id=$2'}`,
      keys: [uuidKey('m.id', 'id')],
      line: (row) =>
        JSON.stringify({
          id: row.id,
          display_name: row.display_name,
          handle: row.handle,
          role: row.role,
          active: row.active,
          created_at: iso(row.created_at),
          removed_at: iso(row.removed_at),
          email: row.email ?? null,
        }),
    },
    {
      key: 'agents',
      prefix: 'agents',
      select: `SELECT a.id,a.owner_member_id,a.display_name,a.handle,a.active,a.created_at,a.revoked_at
        FROM agents a WHERE a.community_id=$1 ${owner ? '' : 'AND a.owner_member_id=$2'}`,
      keys: [uuidKey('a.id', 'id')],
      line: (row) =>
        JSON.stringify({
          id: row.id,
          owner_member_id: row.owner_member_id,
          display_name: row.display_name,
          handle: row.handle,
          active: row.active,
          created_at: iso(row.created_at),
          revoked_at: iso(row.revoked_at),
        }),
    },
    {
      key: 'channelMembers',
      prefix: 'channel-members',
      select: `SELECT cm.channel_id,cm.member_id,cm.joined_at FROM channel_members cm
        WHERE cm.community_id=$1
        ${owner ? '' : 'AND cm.member_id=$2 AND cm.channel_id=ANY($3::uuid[])'}`,
      keys: [uuidKey('cm.channel_id', 'channel_id'), uuidKey('cm.member_id', 'member_id')],
      line: (row) =>
        JSON.stringify({
          channel_id: row.channel_id,
          member_id: row.member_id,
          joined_at: iso(row.joined_at),
        }),
    },
    {
      key: 'agentChannelMembers',
      prefix: 'agent-channel-members',
      select: `SELECT acm.channel_id,acm.agent_id,acm.joined_at FROM agent_channel_members acm
        WHERE acm.community_id=$1
        ${
          owner
            ? ''
            : `AND acm.channel_id=ANY($3::uuid[]) AND acm.agent_id IN (
                 SELECT id FROM agents WHERE owner_member_id=$2 AND community_id=$1)`
        }`,
      keys: [uuidKey('acm.channel_id', 'channel_id'), uuidKey('acm.agent_id', 'agent_id')],
      line: (row) =>
        JSON.stringify({
          channel_id: row.channel_id,
          agent_id: row.agent_id,
          joined_at: iso(row.joined_at),
        }),
    },
  ];
  if (owner)
    list.push({
      key: 'auditEvents',
      prefix: 'audit-events',
      select: `SELECT ae.id,ae.community_id,ae.actor_member_id,ae.actor_kind,ae.action,ae.subject_id,
          ae.prior_state,ae.next_state,ae.changed_fields,ae.created_at,
          ae.created_at::text AS created_at_key
        FROM audit_events ae WHERE ae.community_id=$1`,
      // The key is read as text: a JavaScript Date keeps milliseconds, the column microseconds.
      keys: [
        { column: 'ae.created_at', type: 'timestamptz', field: 'created_at_key' },
        uuidKey('ae.id', 'id'),
      ],
      line: (row) =>
        JSON.stringify({
          id: row.id,
          community_id: row.community_id,
          actor_member_id: row.actor_member_id,
          actor_kind: row.actor_kind,
          action: row.action,
          subject_id: row.subject_id,
          prior_state: row.prior_state,
          next_state: row.next_state,
          changed_fields: row.changed_fields,
          created_at: iso(row.created_at),
        }),
    });
  return list;
}

async function* collectionPages(
  client: PoolClient,
  scope: CollectionScope,
  spec: CollectionSpec
): AsyncGenerator<Record<string, unknown>[]> {
  let after: unknown[] | null = null;
  const order = spec.keys.map((key) => key.column).join(',');
  while (true) {
    const params: unknown[] = [scope.communityId, scope.memberId, scope.channelIds];
    let keyset = '';
    if (after) {
      const placeholders = spec.keys.map(
        (key, index) => `$${params.length + index + 1}::${key.type}`
      );
      params.push(...after);
      keyset = `AND (${order}) > (${placeholders.join(',')})`;
    }
    params.push(PAGE_ROWS);
    // Every query names all three scope parameters, so each has a type even where unused.
    const page = await client.query<Record<string, unknown>>(
      `WITH exported AS (SELECT $2::uuid AS member_id,$3::uuid[] AS channel_ids)
       ${spec.select} ${keyset} ORDER BY ${order} LIMIT $${params.length}`,
      params
    );
    if (!page.rows.length) return;
    yield page.rows;
    const last = page.rows[page.rows.length - 1];
    after = spec.keys.map((key) => last[key.field]);
    if (page.rows.length < PAGE_ROWS) return;
  }
}

/** One collection file: its archive name and its NDJSON bytes, read as the writer consumes it. */
export interface CollectionFile {
  name: string;
  source: AsyncIterable<Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * Every collection file of an export, in order, read through `client` (a `REPEATABLE READ`
 * transaction, so names, roles and memberships agree with each other). A file ends at
 * {@link COLLECTION_FILE_ROWS} rows or once it holds `fileBytes` bytes. A file is yielded only
 * once its first page has been read, so an empty collection writes no file. Consume each file's
 * source fully before asking for the next file; `tallies` records names and row counts.
 */
export async function* collectionFiles(
  client: PoolClient,
  scope: CollectionScope,
  tallies: CollectionTallies,
  fileBytes: number
): AsyncGenerator<CollectionFile> {
  for (const spec of specs(scope.scope)) {
    const pages = collectionPages(client, scope, spec);
    let buffered: Record<string, unknown>[] = [];
    let offset = 0;
    let exhausted = false;
    const nextRow = async (): Promise<Record<string, unknown> | null> => {
      if (offset >= buffered.length) {
        if (exhausted) return null;
        const next = await pages.next();
        if (next.done) {
          exhausted = true;
          return null;
        }
        buffered = next.value;
        offset = 0;
      }
      return buffered[offset++];
    };
    // The row that starts the next file, set by the previous file's source when it is cut.
    const cut: { next: Record<string, unknown> | null } = { next: await nextRow() };
    while (cut.next) {
      const tally = tallies[spec.key];
      const name = `${spec.prefix}/${fileNumber(tally.files.length + 1)}.ndjson`;
      tally.files.push(name);
      const start = cut.next;
      cut.next = null;
      const source = async function* () {
        let rows = 0;
        let bytes = 0;
        let chunk: string[] = [];
        let row: Record<string, unknown> | null = start;
        while (row) {
          const line = `${spec.line(row)}\n`;
          chunk.push(line);
          rows++;
          bytes += Buffer.byteLength(line);
          tally.count++;
          if (chunk.length >= PAGE_ROWS) {
            yield encoder.encode(chunk.join(''));
            chunk = [];
          }
          row = await nextRow();
          if (row && (rows >= COLLECTION_FILE_ROWS || bytes >= fileBytes)) {
            cut.next = row;
            row = null;
          }
        }
        if (chunk.length) yield encoder.encode(chunk.join(''));
      };
      yield { name, source: source() };
    }
  }
}
