import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import type { Pool } from 'pg';
import { sweepErasures } from '../erasure/worker.js';
import type { ErasureOptions } from '../erasure/erasure.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { sweepExpiredPairings } from '../routes/pairings.js';
import {
  expectStatus,
  pairInstall,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

/** The canary person every residue scan looks for. */
export const PERSON = { name: 'Zephyrine Quill', email: 'zq-canary@example.test' } as const;

/** Every canary string the person leaves in one community. */
export const CANARY = {
  laptop: 'zq-canary-laptop',
  declined: 'zq-canary-declined',
  abandoned: 'zq-canary-abandoned',
  agentName: 'ZQ Canary Bot',
  localAgent: 'zq-canary-local',
  text1: 'canary-text-1',
  text2: 'canary-text-2',
  text3: 'canary-text-3',
  key: 'zq-canary-key',
  file: 'zq-canary.txt',
  bytes: 'canary-bytes-1',
  unbound: 'zq-canary-unbound.txt',
  unboundBytes: 'canary-bytes-2',
  channel: 'zq-canary-channel',
} as const;

/** Read a response body after asserting its status. */
export async function body<T = Record<string, unknown>>(
  response: Response,
  status: number,
  step: string
): Promise<T> {
  await expectStatus(response, status, step);
  return (await response.json()) as T;
}

/** A person's membership in one community, with the account behind it. */
export interface Person extends TenancyMember {
  userId: string;
  handle: string;
}

/** Look up the account and handle behind a membership. */
export async function person(h: TenancyHarness, member: TenancyMember): Promise<Person> {
  const row = (
    await h.pool.query<{ user_id: string; handle: string }>(
      'SELECT user_id,handle FROM members WHERE id=$1',
      [member.memberId]
    )
  ).rows[0];
  return { ...member, userId: row.user_id, handle: row.handle };
}

/** Upload one text file as a browser session and return its attachment id. */
export async function upload(
  h: TenancyHarness,
  communityId: string,
  channelId: string,
  cookie: string,
  name: string,
  text: string
): Promise<string> {
  const response = await h.call(
    `/api/v1/communities/${communityId}/channels/${channelId}/attachments`,
    {
      method: 'POST',
      cookie,
      headers: {
        'content-type': 'text/plain',
        'idempotency-key': `upload-${name}`,
        'x-file-name': encodeURIComponent(name),
        'x-file-size': String(Buffer.byteLength(text)),
      },
      raw: text,
    }
  );
  return (await body<{ attachment: { id: string } }>(response, 201, `upload ${name}`)).attachment
    .id;
}

/** Post one entry and return it. */
export async function post(
  h: TenancyHarness,
  communityId: string,
  channelId: string,
  auth: { cookie?: string; bearer?: string },
  entry: { text: string; idempotencyKey: string; parentEntryId?: string; attachmentIds?: string[] }
): Promise<{ id: string; seq: number; cursor: string }> {
  const response = await h.call(
    `/api/v1/communities/${communityId}/channels/${channelId}/entries`,
    {
      ...auth,
      body: entry,
    }
  );
  return (
    await body<{ entry: { id: string; seq: number; cursor: string } }>(
      response,
      201,
      `post ${entry.idempotencyKey}`
    )
  ).entry;
}

/** Start a pairing request as a local install, returning its id. */
export async function startPairing(
  h: TenancyHarness,
  communityId: string,
  installName: string
): Promise<string> {
  const response = await h.call(`/api/v1/communities/${communityId}/pairings/start`, {
    headers: { origin: '' },
    body: { installName, challenge: 'A'.repeat(43), scopes: ['read'] },
  });
  return (await body<{ pairingId: string }>(response, 201, `pairing ${installName}`)).pairingId;
}

/** Everything the canary person left in one community. */
export interface Seeded {
  communityId: string;
  channelId: string;
  grant: string;
  agent: { id: string; handle: string; token: string };
  rootEntryId: string;
  replyEntryId: string;
  agentEntryId: string;
  fileEntryId: string;
  attachmentId: string;
  unboundId: string;
  questionEntryId: string;
}

/**
 * Seed the canary person's data in one community: an approved, a declined, and an abandoned
 * pairing; an agent; a post, a reply in someone else's thread, an agent post, a post with a
 * file, and an unbound upload. `other` asks the question P replies to.
 */
export async function seedCanaries(
  h: TenancyHarness,
  input: {
    communityId: string;
    channelId: string;
    p: Person;
    other: TenancyMember;
  }
): Promise<Seeded> {
  const { communityId, channelId, p, other } = input;
  const base = `/api/v1/communities/${communityId}`;
  const grant = await pairInstall(
    h,
    communityId,
    p.cookie,
    ['read', 'post', 'enroll-agent'],
    CANARY.laptop
  );
  const declined = await startPairing(h, communityId, CANARY.declined);
  await body(
    await h.call(`${base}/pairings/decline`, { cookie: p.cookie, body: { pairingId: declined } }),
    200,
    'decline pairing'
  );
  await startPairing(h, communityId, CANARY.abandoned);
  const enrolled = await body<{ token: string; agent: { memberId: string; handle: string } }>(
    await h.call(`${base}/agents`, {
      bearer: grant,
      body: { localAgentId: CANARY.localAgent, displayName: CANARY.agentName },
    }),
    201,
    'enroll agent'
  );
  const agent = {
    id: enrolled.agent.memberId,
    handle: enrolled.agent.handle,
    token: enrolled.token,
  };
  await body(
    await h.call(`${base}/channels/${channelId}/agents`, {
      cookie: p.cookie,
      body: { agentId: agent.id },
    }),
    200,
    'agent joins channel'
  );
  const root = await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: `${CANARY.text1} from Zephyrine`,
      idempotencyKey: CANARY.key,
    }
  );
  const question = await post(
    h,
    communityId,
    channelId,
    { cookie: other.cookie },
    {
      text: 'Does anyone know the answer?',
      idempotencyKey: 'question',
    }
  );
  const reply = await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: `${CANARY.text3} is my answer`,
      idempotencyKey: 'reply',
      parentEntryId: question.id,
    }
  );
  const agentEntry = await post(
    h,
    communityId,
    channelId,
    { bearer: agent.token },
    {
      text: `${CANARY.text2} from the bot`,
      idempotencyKey: 'agent-post',
    }
  );
  const attachmentId = await upload(
    h,
    communityId,
    channelId,
    p.cookie,
    CANARY.file,
    `${CANARY.bytes} file body`
  );
  const fileEntry = await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: 'see the file',
      idempotencyKey: 'file-post',
      attachmentIds: [attachmentId],
    }
  );
  const unboundId = await upload(
    h,
    communityId,
    channelId,
    p.cookie,
    CANARY.unbound,
    `${CANARY.unboundBytes} never posted`
  );
  return {
    communityId,
    channelId,
    grant,
    agent,
    rootEntryId: root.id,
    replyEntryId: reply.id,
    agentEntryId: agentEntry.id,
    fileEntryId: fileEntry.id,
    attachmentId,
    unboundId,
    questionEntryId: question.id,
  };
}

/** One place a needle was found. */
export interface Hit {
  table: string;
  column: string;
  communityId: string | null;
  rowId: string | null;
  needle: string;
}

/**
 * Search every text, varchar, text[], json, and jsonb column of every table in the public
 * schema, enumerated from the catalogue, case-insensitively for each needle. A table added
 * later is scanned without anyone listing it.
 */
export async function scanDatabase(pool: Pool, needles: readonly string[]): Promise<Hit[]> {
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name,c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
       AND (c.data_type IN ('text','character varying','json','jsonb')
         OR (c.data_type='ARRAY' AND c.udt_name IN ('_text','_varchar')))
     ORDER BY c.table_name,c.column_name`
  );
  const shape = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema='public' AND column_name IN ('community_id','id')`
  );
  const has = (table: string, column: string) =>
    shape.rows.some((row) => row.table_name === table && row.column_name === column);
  const lowered = needles.map((needle) => needle.toLowerCase());
  const hits: Hit[] = [];
  for (const { table_name: table, column_name: column } of columns.rows) {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const community =
      table === 'communities' ? 'id' : has(table, 'community_id') ? 'community_id' : 'NULL';
    const rowId = has(table, 'id') ? 'id' : 'NULL';
    const rows = await pool.query<{
      community_id: string | null;
      row_id: string | null;
      value: string;
    }>(
      `SELECT ${community === 'NULL' ? 'NULL' : quote(community)}::text AS community_id,
              ${rowId === 'NULL' ? 'NULL' : quote(rowId)}::text AS row_id,
              lower(${quote(column)}::text) AS value
       FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`
    );
    for (const row of rows.rows) {
      for (const needle of lowered) {
        if (row.value.includes(needle))
          hits.push({ table, column, communityId: row.community_id, rowId: row.row_id, needle });
      }
    }
  }
  return hits;
}

/**
 * Every uuid column of every tenant table (enumerated from the catalogue) that holds `id` in
 * one community's rows, as `table.column`.
 */
export async function scanUuidColumns(
  pool: Pool,
  communityId: string,
  id: string
): Promise<string[]> {
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name,c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type='uuid'
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema='public'
         AND k.table_name=c.table_name AND k.column_name='community_id')
     ORDER BY c.table_name,c.column_name`
  );
  const found: string[] = [];
  for (const { table_name: table, column_name: column } of columns.rows) {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const rows = await pool.query(
      `SELECT 1 FROM ${quote(table)} WHERE community_id=$1 AND ${quote(column)}=$2 LIMIT 1`,
      [communityId, id]
    );
    if (rows.rowCount) found.push(`${table}.${column}`);
  }
  return found;
}

/** Search every object in a filesystem BlobStore directory, returning the keys that match. */
export async function scanBlobs(
  directory: string,
  needles: readonly string[]
): Promise<{ key: string; needle: string }[]> {
  const hits: { key: string; needle: string }[] = [];
  for (const name of await readdir(directory)) {
    const bytes = await readFile(join(directory, name));
    const text = [bytes, ...deflatedEntries(bytes)]
      .map((part) => part.toString('utf8'))
      .join('\n')
      .toLowerCase();
    for (const needle of needles)
      if (text.includes(needle.toLowerCase())) hits.push({ key: name, needle });
  }
  return hits;
}

/**
 * Inflate every deflated zip entry found in one stored blob (an export segment keeps its
 * NDJSON rows deflated), so a residue scan reads what an archive says, not its compressed bytes.
 */
function deflatedEntries(bytes: Buffer): Buffer[] {
  const found: Buffer[] = [];
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  for (let at = bytes.indexOf(signature); at >= 0; at = bytes.indexOf(signature, at + 4)) {
    if (at + 30 > bytes.length || bytes.readUInt16LE(at + 8) !== 8) continue;
    const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
    try {
      found.push(
        inflateRawSync(bytes.subarray(start), { finishFlush: zlibConstants.Z_SYNC_FLUSH })
      );
    } catch {
      // Not an entry: the signature appeared inside other bytes.
    }
  }
  return found;
}

/** The blob store directory of a filesystem-backed harness. */
export function storageDirectory(h: TenancyHarness): string {
  if (h.config.storage.kind !== 'filesystem') throw new Error('Filesystem storage required');
  return h.config.storage.directory;
}

/**
 * The needles that identify the person: their name and each word of it, their handle and
 * their agents', their email, every canary string, and the hashes of their entry payloads
 * and file bytes. Hashes are read before erasure, while the rows still hold them.
 */
export async function personNeedles(
  pool: Pool,
  p: { userId: string; handle: string },
  agentHandles: string[]
): Promise<string[]> {
  const hashes = await pool.query<{ hash: string }>(
    `SELECT e.payload_hash AS hash FROM entries e
     LEFT JOIN agents a ON a.id=e.author_agent_id
     JOIN members m ON m.id=COALESCE(e.author_member_id,a.owner_member_id)
     WHERE m.user_id=$1
     UNION SELECT att.checksum FROM attachments att
     LEFT JOIN agents a ON a.id=att.uploader_agent_id
     JOIN members m ON m.id=COALESCE(att.uploader_member_id,a.owner_member_id)
     WHERE m.user_id=$1`,
    [p.userId]
  );
  return [
    PERSON.name,
    ...PERSON.name.split(' '),
    p.handle,
    ...agentHandles,
    PERSON.email,
    ...Object.values(CANARY),
    ...hashes.rows.map((row) => row.hash),
  ];
}

/** Also sha256 of a text, for checking file hashes independently of the database. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Run every due erasure at an injected clock until none is left. */
export async function runErasures(
  pool: Pool,
  now: Date,
  options: ErasureOptions = {}
): Promise<number> {
  let completed = 0;
  for (let round = 0; round < 50; round++) {
    const result = await sweepErasures(pool, { ...options, now });
    if (!result.claimed) break;
    completed += result.completed;
  }
  return completed;
}

/**
 * Let unused pairing requests in these communities reach the sweep, as they would 70 minutes
 * after they started (ten to expire, an hour of grace), and sweep them.
 */
export async function sweepAbandonedPairings(h: TenancyHarness, communityIds: string[]) {
  await h.pool.query(
    `UPDATE connection_pairings SET expires_at=now()-interval '61 minutes'
     WHERE consumed_at IS NULL AND community_id=ANY($1::uuid[])`,
    [communityIds]
  );
  await sweepExpiredPairings(h.pool);
}

/** Finish every queued blob deletion, advancing the sweep's retry clock each round. */
export async function drainCleanup(h: TenancyHarness): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await h.pool.query(
      "UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second'"
    );
    await sweepPendingBlobDeletions(h.pool, h.blobStore, 100);
    const left = await h.pool.query(
      "SELECT 1 FROM pending_blob_deletions UNION ALL SELECT 1 FROM managed_blobs WHERE state='pending_delete' LIMIT 1"
    );
    if (!left.rowCount) return;
  }
  throw new Error('Blob cleanup did not finish');
}

/** Hours from now as a Date, for the injected worker clock. */
export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

/** The password every fixture account uses. */
export const PASSWORD = TENANCY_PASSWORD;
