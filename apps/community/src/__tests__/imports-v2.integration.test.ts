/**
 * Import any size (spec `community-export-any-size`, task 2.1, AC-14): a version 2 owner export,
 * written by this server's own exporter, uploaded in resumable parts and restored in resumable
 * batches; the part routes' limits; and version 2 archives tampered with in each way the spec
 * names. The version 1 round trip is `imports-restore.integration.test.ts`, which runs through
 * the same reader and dispatch.
 */
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tombstonePayloadHash } from '../content-removal.js';
import { REMOVED_ENTRY_TEXT, ERASED_ENTRY_TEXT } from '../content/tombstones.js';
import { ERASED_MEMBER_NAME } from '../erasure/erasure.js';
import { uuidv5 } from '../imports/derived-id.js';
import type { ImportWorkerHooks } from '../imports/process.js';
import { sweepImports } from '../imports/worker.js';
import { responseCookies } from './bootstrap-test-helper.js';
import {
  downloadArchive,
  exportCommunity,
  exportMember,
  requestOwnerExport,
  runExport,
  seedEntries,
  seedFile,
  type ExportCommunity,
} from './export-jobs-fixture.js';
import { openArchive, type OpenedArchive } from './export-test-helpers.js';
import {
  createImport,
  issueKey,
  readArchive,
  readImport,
  sha256,
  uploadArchive,
  versionOneExport,
} from './import-fixture.js';
import { drainCleanup } from './member-erasure-fixture.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

const KIB = 1024;
const MIB = 1024 * KIB;
/** Enough for four part uploads to one import and one more elsewhere, then a refusal. */
const PART_CONCURRENCY = 5;
/** Small enough to reach with parts that are still arriving; several times the test archive. */
const MAX_IMPORT_BYTES = 8 * MIB;
/** Where `complete` pauses before hashing, when a test sets it. */
let beforeCompleteHash: (importId: string) => Promise<void> = async () => undefined;

let h: TenancyHarness;
let operatorCookie = '';
let key = '';
let source: ExportCommunity;
let pat: TenancyMember;
let archive: Buffer = Buffer.alloc(0);
let opened: OpenedArchive;
let iconChecksum = '';
const channels: { general: string; hidden: string; elsewhere: string } = {
  general: '',
  hidden: '',
  elsewhere: '',
};
const marked = {
  root: '',
  reply: '',
  removed: '',
  erased: '',
  mention: '',
  /** Pat's agent, a message it wrote, a message mentioning it, and a file it uploaded. */
  agent: '',
  byAgent: '',
  agentMention: '',
  agentFile: '',
};

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))
    .rows[0].n;
}

/** Run the import worker until nothing is due. */
async function runImports(hooks: ImportWorkerHooks = {}): Promise<void> {
  for (let round = 0; round < 200; round++) {
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    const result = await sweepImports(h.pool, h.blobStore, h.config.limits, new Date(), hooks);
    if (!result.claimed) return;
  }
  throw new Error('Import work did not settle');
}

function connectionLost(): Error {
  return Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
}

function putPart(
  importId: string,
  partNumber: number,
  bytes: Uint8Array,
  bearer: string,
  declared = sha256(bytes)
): Promise<Response> {
  return h.call(`/api/v1/imports/${importId}/archive/parts/${partNumber}`, {
    method: 'PUT',
    bearer,
    headers: { 'content-type': 'application/octet-stream', 'x-part-sha256': declared },
    raw: new Uint8Array(bytes),
  });
}

function complete(importId: string, body: Record<string, unknown>, bearer: string) {
  return h.call(`/api/v1/imports/${importId}/archive/complete`, { bearer, body });
}

async function listParts(importId: string, bearer: string) {
  const response = await expectStatus(
    await h.call(`/api/v1/imports/${importId}/archive/parts`, { bearer }),
    200,
    'list parts'
  );
  return response.json() as Promise<{
    parts: { partNumber: number; byteSize: number; sha256: string }[];
    maxPartBytes: number;
    maxArchiveBytes: number;
  }>;
}

/** Cut bytes into parts of `size`. */
function cut(bytes: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
  return parts;
}

/**
 * Open a raw part upload: send its headers and the first `sent` bytes, and leave it hanging
 * (the returned `close` drops it) or wait for the answer. The answer is the raw HTTP text.
 */
async function rawPart(
  importId: string,
  partNumber: number,
  bytes: Uint8Array,
  bearer: string,
  sent: number,
  declaredLength = bytes.byteLength
): Promise<{ answer: Promise<string>; close: () => void }> {
  const { port } = new URL(h.baseUrl);
  const socket = connect(Number(port), '127.0.0.1');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => undefined);
  const answer = new Promise<string>((resolve) =>
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
  );
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      `PUT /api/v1/imports/${importId}/archive/parts/${partNumber} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${bearer}`,
      'Content-Type: application/octet-stream',
      `Content-Length: ${declaredLength}`,
      `X-Part-SHA256: ${sha256(bytes)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')
  );
  if (sent > 0) socket.write(bytes.subarray(0, sent));
  return { answer, close: () => socket.destroy() };
}

/** Wait until the database shows `n` part uploads in flight. */
async function partUploadsInFlight(n: number): Promise<void> {
  for (let attempt = 0; attempt < 3_000; attempt++) {
    if ((await count('SELECT 1 FROM community_import_part_uploads')) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} part uploads in flight`);
}

/**
 * Wait until the server holds (`held`) or has given back the lease of one part upload.
 *
 * The lease is the server's own record that the part is arriving, so a test waits on it rather
 * than a guessed sleep: a dropped connection frees it only once the server notices the drop,
 * which a busy machine takes longer to do than the client takes to close its end. The deadline
 * stays far under the lease's expiry, so a lease the server never gives back still fails.
 */
async function waitForPartLease(importId: string, partNumber: number, held: boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const leased =
      (await count(
        'SELECT 1 FROM community_import_part_uploads WHERE import_id=$1 AND part_number=$2',
        [importId, partNumber]
      )) > 0;
    if (leased === held) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Part ${partNumber} of ${importId} was never ${held ? 'taken' : 'given back'}`);
}

/** Upload an archive in parts of `size` and complete it; returns the import. */
async function importInParts(
  bytes: Buffer,
  size: number,
  body: Record<string, unknown> = {}
): Promise<{ importId: string; communityId: string; uploadToken: string }> {
  const created = await createImport(h, { bearer: key }, body);
  const parts = cut(bytes, size);
  for (const [index, part] of parts.entries())
    await expectStatus(
      await putPart(created.importId, index + 1, part, created.uploadToken),
      200,
      `part ${index + 1}`
    );
  await expectStatus(
    await complete(
      created.importId,
      { parts: parts.length, archiveBytes: bytes.length, archiveSha256: sha256(bytes) },
      created.uploadToken
    ),
    200,
    'complete'
  );
  return created;
}

async function commit(importId: string, hooks: ImportWorkerHooks = {}): Promise<void> {
  await expectStatus(
    await h.call(`/api/v1/host/imports/${importId}/commit`, { bearer: key, body: {} }),
    200,
    'commit'
  );
  await runImports(hooks);
}

async function claim(communityId: string, name: string, email: string): Promise<TenancyMember> {
  const issued = await expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}/owner-claims/reissue`, {
      bearer: key,
      body: {},
    }),
    200,
    'reissue claim'
  );
  const grant = await preflightOwnerClaim(h, (await issued.json()).ownerClaimToken);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name, email, password: TENANCY_PASSWORD },
      cookie: grant,
    }),
    200,
    'sign up'
  );
  const cookie = `${grant}; ${responseCookies(signedUp)}`;
  const claimed = await expectStatus(
    await h.call('/api/v1/owner-claims/claim', { cookie, body: {} }),
    200,
    'claim'
  );
  return { cookie, memberId: (await claimed.json()).memberId };
}

async function expectNothingLeft(communityId: string): Promise<void> {
  await runImports();
  await drainCleanup(h);
  expect(await count('SELECT 1 FROM communities WHERE id=$1', [communityId])).toBe(0);
  expect(await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [communityId])).toBe(0);
  for (const table of ['channels', 'entries', 'members', 'attachments', 'audit_events'])
    expect(await count(`SELECT 1 FROM ${table} WHERE community_id=$1`, [communityId])).toBe(0);
}

/**
 * Write the exported archive again with fflate (a plain zip, which the reader also reads), in
 * the same entry order, after `change` edits its entries. Files stay stored; the rest deflate.
 */
function rebuilt(change: (entries: [string, Buffer][]) => void): Buffer {
  const entries: [string, Buffer][] = opened.names.map((name) => [
    name,
    Buffer.from(opened.files.get(name)!),
  ]);
  change(entries);
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of entries) {
    const file =
      name.startsWith('files/') || name === 'community/icon'
        ? new ZipPassThrough(name)
        : new ZipDeflate(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

function withManifest(change: (manifest: Record<string, unknown>) => void) {
  return (entries: [string, Buffer][]) => {
    const at = entries.findIndex(([name]) => name === 'manifest.json');
    const manifest = JSON.parse(entries[at][1].toString('utf8'));
    change(manifest);
    entries[at][1] = Buffer.from(JSON.stringify(manifest));
  };
}

function withLines(name: string, change: (lines: Record<string, unknown>[]) => void) {
  return (entries: [string, Buffer][]) => {
    const at = entries.findIndex(([entry]) => entry === name);
    const lines = entries[at][1]
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    change(lines);
    entries[at][1] = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  };
}

/** A deflated entry whose directory record claims one byte less than it inflates to. */
function inflatingPast(bytes: Buffer, name: string, trueSize: number): Buffer {
  const encoded = Buffer.from(name);
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (
      bytes.readUInt32LE(at) === 0x02014b50 &&
      bytes.subarray(at + 46, at + 46 + encoded.length).equals(encoded)
    ) {
      bytes.writeUInt32LE(trueSize - 1, at + 24);
      return bytes;
    }
  }
  throw new Error('central directory record not found');
}

beforeAll(async () => {
  h = await startTenancyHarness('importv2', {
    env: {
      COMMUNITY_IMPORT_PART_CONCURRENCY: PART_CONCURRENCY,
      COMMUNITY_IMPORT_MAX_BYTES: MAX_IMPORT_BYTES,
    },
    hooks: { beforeCompleteHash: (importId) => beforeCompleteHash(importId) },
  });
  operatorCookie = (await bootstrapHost(h, 'Vera Host', 'vera@import-v2.test')).cookie;
  key = await issueKey(h, ['communities:import', 'communities:read', 'communities:write']);

  // Community A: public, private, and a channel its owner is not in; 12,000 messages, a thread,
  // a mention, a removed and an erased message, files in two channels, an icon, a description,
  // and a closed admission policy.
  source = await exportCommunity(h, operatorCookie, 'Source Place');
  channels.general = source.channelId;
  pat = await exportMember(h, source, 'Pat Member');
  const hidden = await expectStatus(
    await h.call(`${source.base}/channels`, {
      cookie: source.owner.cookie,
      body: { name: 'hidden', visibility: 'private' },
    }),
    201,
    'private channel'
  );
  channels.hidden = (await hidden.json()).channel.id;
  const elsewhere = await expectStatus(
    await h.call(`${source.base}/channels`, {
      cookie: source.owner.cookie,
      body: { name: 'elsewhere', visibility: 'public' },
    }),
    201,
    'third channel'
  );
  channels.elsewhere = (await elsewhere.json()).channel.id;
  await h.pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
    channels.elsewhere,
    source.owner.memberId,
  ]);

  const general = await seedEntries(h, source, {
    authorMemberId: source.owner.memberId,
    count: 12_000,
  });
  await seedEntries(h, source, {
    channelId: channels.hidden,
    authorMemberId: source.owner.memberId,
    count: 5,
  });
  await seedEntries(h, source, {
    channelId: channels.elsewhere,
    authorMemberId: pat.memberId,
    count: 3,
  });
  marked.root = general[10].id;
  marked.mention = general[11].id;
  marked.removed = general[12].id;
  marked.erased = general[13].id;
  const reply = await h.pool.query<{ id: string }>(
    `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
       parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
     SELECT $1,$2,last_seq+1,$3,'Pat','a reply',$4,$4,'reply-1',md5('a reply') FROM channels
     WHERE id=$2 RETURNING id`,
    [source.communityId, channels.general, pat.memberId, marked.root]
  );
  marked.reply = reply.rows[0].id;
  await h.pool.query('UPDATE channels SET last_seq=last_seq+1 WHERE id=$1', [channels.general]);
  await h.pool.query(
    `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_member_id)
     VALUES($1,1,$2,$3)`,
    [marked.mention, source.communityId, pat.memberId]
  );
  await h.pool.query(
    "UPDATE entries SET text=$2,removed_by='moderator',removed_at=now() WHERE id=$1",
    [marked.removed, REMOVED_ENTRY_TEXT.moderator]
  );
  await h.pool.query('UPDATE entries SET text=$2,erased_at=now() WHERE id=$1', [
    marked.erased,
    ERASED_ENTRY_TEXT,
  ]);
  const files = [];
  for (let index = 0; index < 6; index++)
    files.push(
      await seedFile(h, source, {
        entryId: general[100 + index * 1_000].id,
        uploaderMemberId: source.owner.memberId,
        name: `notes-${index}.txt`,
        bytes: 200 * KIB + index,
      })
    );
  // Pat's agent: in the general channel, the author of one message, mentioned in another, and
  // the uploader of one file (the one on its own message).
  const agent = await h.pool.query<{ id: string }>(
    `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
     VALUES($1,$2,'Pat Bot','pat-bot','local-1') RETURNING id`,
    [source.communityId, pat.memberId]
  );
  marked.agent = agent.rows[0].id;
  await h.pool.query(
    'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
    [source.communityId, 'pat-bot', marked.agent]
  );
  await h.pool.query(
    'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
    [source.communityId, channels.general, marked.agent]
  );
  marked.byAgent = general[100].id;
  marked.agentMention = general[21].id;
  marked.agentFile = files[0].id;
  await h.pool.query(
    `UPDATE entries SET author_member_id=NULL,author_agent_id=$2,author_display_name='Pat Bot'
     WHERE id=$1`,
    [marked.byAgent, marked.agent]
  );
  await h.pool.query(
    `INSERT INTO entry_mentions(entry_id,position,community_id,mentioned_agent_id)
     VALUES($1,1,$2,$3)`,
    [marked.agentMention, source.communityId, marked.agent]
  );
  await h.pool.query(
    'UPDATE attachments SET uploader_member_id=NULL,uploader_agent_id=$2 WHERE id=$1',
    [marked.agentFile, marked.agent]
  );
  const hiddenEntry = await h.pool.query<{ id: string }>(
    'SELECT id FROM entries WHERE channel_id=$1 ORDER BY seq LIMIT 1',
    [channels.hidden]
  );
  await seedFile(h, source, {
    entryId: hiddenEntry.rows[0].id,
    uploaderMemberId: source.owner.memberId,
    name: 'secret plans.txt',
    bytes: Buffer.from('only the hidden channel sees this'),
    channelId: channels.hidden,
  });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 7)]);
  iconChecksum = sha256(png);
  const settings = await h.pool.query<{ settings_version: number }>(
    'SELECT settings_version FROM communities WHERE id=$1',
    [source.communityId]
  );
  await expectStatus(
    await h.call(`${source.base}/settings/icon`, {
      method: 'PUT',
      cookie: source.owner.cookie,
      headers: {
        'if-match': `"${settings.rows[0].settings_version}"`,
        'content-type': 'image/png',
      },
      raw: new Uint8Array(png),
    }),
    200,
    'icon'
  );
  await h.pool.query(
    "UPDATE communities SET description='Where we talk',admission_policy='closed' WHERE id=$1",
    [source.communityId]
  );

  // Small segments, so the archive holds many data files and the files span several of them.
  const requested = await requestOwnerExport(h, source);
  await runExport(h, { segmentBytes: 256 * KIB });
  archive = await downloadArchive(h, source, requested.export.id);
  opened = await openArchive(archive);
  expect(opened.manifest.version).toBe(2);
  expect(opened.manifest.files.entries.length).toBeGreaterThan(3);
  expect(opened.manifest.files.attachments.length).toBeGreaterThan(2);
}, 600_000);

afterAll(async () => {
  await h?.close();
});

// Purpose (AC-14): the whole path. A version 2 export is uploaded in parts, the upload is cut
// off after two parts and resumed from the part list, completed, checked, committed through a
// worker that dies mid-restore, and claimed. Counts, text, thread shape, tombstones, removal
// markers, mentions, file bytes, the icon, the description, the admission policy, and the
// owner's own channel memberships all match through the derived-ID map, and each row is
// restored once. Fails on any lost field, any row written twice, or a resume that restarts.
it('restores a version 2 export uploaded in parts, across a cut-off upload and a crash', async () => {
  const created = await createImport(h, { bearer: key }, { name: 'Moved Place' });
  const { importId, communityId, uploadToken } = created;
  const parts = cut(archive, Math.ceil(archive.length / 5));
  expect(parts.length).toBe(5);
  for (const index of [0, 1])
    await expectStatus(await putPart(importId, index + 1, parts[index], uploadToken), 200, 'part');
  // The third part breaks off half-way: nothing of it is kept.
  const dropped = await rawPart(importId, 3, parts[2], uploadToken, parts[2].length >> 1);
  // Drop only once the server is receiving the body, so this is a drop part-way through, and go
  // on only once the server has noticed it: the client's end closes before the server's does.
  await waitForPartLease(importId, 3, true);
  dropped.close();
  await dropped.answer;
  await waitForPartLease(importId, 3, false);
  const resumed = await listParts(importId, uploadToken);
  expect(resumed.parts.map((part) => part.partNumber)).toEqual([1, 2]);
  expect(resumed.parts[1]).toEqual({
    partNumber: 2,
    byteSize: parts[1].length,
    sha256: sha256(parts[1]),
  });
  expect(resumed.maxPartBytes).toBe(h.config.exports.segmentBytes);
  // The same part again is a no-op.
  const blobs = await count(
    "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging'",
    [communityId]
  );
  await expectStatus(await putPart(importId, 2, parts[1], uploadToken), 200, 'repeat part');
  expect(
    await count("SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging'", [
      communityId,
    ])
  ).toBe(blobs);
  for (let index = resumed.parts.length; index < parts.length; index++)
    await expectStatus(await putPart(importId, index + 1, parts[index], uploadToken), 200, 'part');
  const completed = await expectStatus(
    await complete(
      importId,
      { parts: parts.length, archiveBytes: archive.length, archiveSha256: sha256(archive) },
      uploadToken
    ),
    200,
    'complete'
  );
  expect((await completed.json()).state).toBe('validating');
  // The token is spent: no more parts.
  await expectStatus(await putPart(importId, 1, parts[0], uploadToken), 409, 'part after complete');

  await runImports();
  const checked = await readImport(h, importId, key);
  const { counts } = opened.manifest;
  const attachmentRows = opened.rows<{ byteSize: number }>('attachments');
  const attachmentBytes = attachmentRows.reduce((sum, row) => sum + row.byteSize, 0);
  expect(checked).toMatchObject({ state: 'validated', archiveBytes: archive.length });
  expect(checked.report).toEqual({
    manifestVersion: 2,
    sourceLifecycle: 'active',
    channels: counts.channels,
    entries: counts.entries,
    attachments: counts.attachments,
    historicalMembers: counts.members,
    historicalAgents: counts.agents,
    auditEvents: counts.auditEvents,
    attachmentBytes,
    countedBytes: attachmentBytes + opened.manifest.community.icon!.byteSize,
    fitsStorageLimit: true,
    shortened: 0,
  });
  expect(counts.entries).toBe(12_000 + 5 + 3 + 1);

  // The worker dies twice: once storing files, once between batches of rows.
  let files = 0;
  let batches = 0;
  await commit(importId, {
    afterFile: async () => {
      if (++files === 3) throw connectionLost();
    },
    afterBatch: async () => {
      if (++batches === 5) throw connectionLost();
    },
  });
  expect(files).toBeGreaterThan(3);
  expect(batches).toBeGreaterThan(12);
  expect(await readImport(h, importId, key)).toMatchObject({ state: 'ready' });
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging' AND state<>'pending_delete'",
      [communityId]
    )
  ).toBe(0);
  expect(await count('SELECT 1 FROM community_import_parts WHERE import_id=$1', [importId])).toBe(
    0
  );

  const derive = (id: string) => uuidv5(importId, id);
  const sourceEntries = opened.rows<{
    id: string;
    channel_id: string;
    text: string;
    parent_entry_id: string | null;
    removal: string | null;
  }>('entries');
  const restored = await h.pool.query<{
    id: string;
    channel_id: string;
    seq: string;
    text: string;
    parent_entry_id: string | null;
    removed_by: string | null;
    erased_at: Date | null;
  }>(
    `SELECT e.id,e.channel_id,e.seq::text,e.text,e.parent_entry_id,e.removed_by,e.erased_at
     FROM entries e WHERE e.community_id=$1 ORDER BY e.channel_id,e.seq`,
    [communityId]
  );
  // Each row once: as many as the export holds, every one under its derived ID.
  expect(restored.rows).toHaveLength(sourceEntries.length);
  const byId = new Map(restored.rows.map((row) => [row.id, row]));
  for (const entry of sourceEntries) {
    const row = byId.get(derive(entry.id));
    expect(row, entry.id).toBeDefined();
    expect(row!.channel_id).toBe(derive(entry.channel_id));
    expect(row!.text).toBe(entry.text);
    expect(row!.parent_entry_id).toBe(entry.parent_entry_id && derive(entry.parent_entry_id));
  }
  // Sequences run 1 to n in each channel, in the export's order.
  const perChannel = new Map<string, number>();
  for (const row of restored.rows) {
    const next = (perChannel.get(row.channel_id) ?? 0) + 1;
    expect(Number(row.seq)).toBe(next);
    perChannel.set(row.channel_id, next);
  }
  const lastSeq = await h.pool.query<{ id: string; last_seq: string }>(
    'SELECT id,last_seq::text FROM channels WHERE community_id=$1',
    [communityId]
  );
  for (const channel of lastSeq.rows)
    expect(Number(channel.last_seq)).toBe(perChannel.get(channel.id) ?? 0);
  expect(byId.get(derive(marked.reply))!.parent_entry_id).toBe(derive(marked.root));
  expect(byId.get(derive(marked.removed))).toMatchObject({
    removed_by: 'moderator',
    text: REMOVED_ENTRY_TEXT.moderator,
  });
  expect(byId.get(derive(marked.erased))!.erased_at).not.toBeNull();
  expect(byId.get(derive(marked.erased))!.text).toBe(ERASED_ENTRY_TEXT);
  const mention = await h.pool.query(
    'SELECT mentioned_member_id FROM entry_mentions WHERE entry_id=$1',
    [derive(marked.mention)]
  );
  expect(mention.rows).toEqual([{ mentioned_member_id: derive(pat.memberId) }]);

  // The agent: revoked, its handle kept, its message, its mention, and its file.
  const agent = await h.pool.query(
    `SELECT a.owner_member_id,a.handle,a.active,a.revoked_at IS NOT NULL AS revoked,h.agent_id
     FROM agents a JOIN community_handles h ON h.agent_id=a.id WHERE a.id=$1`,
    [derive(marked.agent)]
  );
  expect(agent.rows).toEqual([
    {
      owner_member_id: derive(pat.memberId),
      handle: 'pat-bot',
      active: false,
      revoked: true,
      agent_id: derive(marked.agent),
    },
  ]);
  expect(
    (
      await h.pool.query('SELECT author_member_id,author_agent_id FROM entries WHERE id=$1', [
        derive(marked.byAgent),
      ])
    ).rows
  ).toEqual([{ author_member_id: null, author_agent_id: derive(marked.agent) }]);
  expect(
    (
      await h.pool.query(
        'SELECT mentioned_member_id,mentioned_agent_id FROM entry_mentions WHERE entry_id=$1',
        [derive(marked.agentMention)]
      )
    ).rows
  ).toEqual([{ mentioned_member_id: null, mentioned_agent_id: derive(marked.agent) }]);
  expect(
    (
      await h.pool.query(
        'SELECT uploader_member_id,uploader_agent_id FROM attachments WHERE id=$1',
        [derive(marked.agentFile)]
      )
    ).rows
  ).toEqual([{ uploader_member_id: null, uploader_agent_id: derive(marked.agent) }]);

  // File bytes, through storage.
  const stored = await h.pool.query<{ id: string; blob_key: string; checksum: string }>(
    'SELECT id,blob_key,checksum FROM attachments WHERE community_id=$1',
    [communityId]
  );
  expect(stored.rows).toHaveLength(counts.attachments);
  for (const file of stored.rows) {
    const read = await h.blobStore.get(file.blob_key);
    const hash = createHash('sha256');
    for await (const chunk of read.body) hash.update(chunk as Buffer);
    expect(hash.digest('hex')).toBe(file.checksum);
  }

  const community = await h.pool.query(
    `SELECT c.name,c.description,c.admission_policy,c.icon_content_type,m.checksum AS icon
     FROM communities c JOIN managed_blobs m ON m.blob_key=c.icon_blob_key WHERE c.id=$1`,
    [communityId]
  );
  expect(community.rows[0]).toEqual({
    name: 'Moved Place',
    description: 'Where we talk',
    admission_policy: 'closed',
    icon_content_type: 'image/png',
    icon: iconChecksum,
  });

  // The owner keeps their own channels, not every channel; nobody else's membership comes.
  const owner = await claim(communityId, 'Vera Again', 'vera-again@import-v2.test');
  expect(owner.memberId).toBe(derive(source.owner.memberId));
  const joined = await h.pool.query<{ channel_id: string }>(
    'SELECT channel_id FROM channel_members WHERE community_id=$1 AND member_id=$2',
    [communityId, owner.memberId]
  );
  expect(joined.rows.map((row) => row.channel_id).sort()).toEqual(
    [derive(channels.general), derive(channels.hidden)].sort()
  );
  expect(
    await count('SELECT 1 FROM channel_members WHERE community_id=$1 AND member_id<>$2', [
      communityId,
      owner.memberId,
    ])
  ).toBe(0);
}, 600_000);

// Purpose: a version 1 archive from the real version 1 exporter imports through the same
// reader when it arrives in parts, so the upload route and the archive version are independent.
it('restores a version 1 export uploaded in parts', async () => {
  const v1 = versionOneExport();
  const { importId, communityId } = await importInParts(v1, Math.ceil(v1.length / 3));
  await runImports();
  expect((await readImport(h, importId, key)).report.manifestVersion).toBe(1);
  await commit(importId);
  expect(await readImport(h, importId, key)).toMatchObject({ state: 'ready' });
  expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [communityId])).toBe(
    readArchive(v1).manifest.entries.length
  );
});

// Purpose: `complete` checks the whole export. A mismatch discards every part and keeps the
// token, which then succeeds with the right parts; too large an export is refused before any
// part is read, and missing parts are named without discarding the ones that arrived.
it('refuses a wrong, incomplete, or too large complete, and keeps the token', async () => {
  const created = await createImport(h, { bearer: key });
  const { importId, uploadToken } = created;
  const parts = cut(archive, 1 * MIB);
  for (const [index, part] of parts.entries())
    await expectStatus(await putPart(importId, index + 1, part, uploadToken), 200, 'part');
  const whole = {
    parts: parts.length,
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
  };

  const tooLarge = await complete(
    importId,
    { ...whole, archiveBytes: h.config.imports.maxBytes + 1 },
    uploadToken
  );
  expect(tooLarge.status).toBe(413);
  expect((await tooLarge.json()).code).toBe('IMPORT_TOO_LARGE');
  const missing = await complete(importId, { ...whole, parts: parts.length + 1 }, uploadToken);
  expect(missing.status).toBe(400);
  expect((await listParts(importId, uploadToken)).parts).toHaveLength(parts.length);
  // A size that does not add up is caught without hashing, and keeps the parts.
  const miscounted = await complete(
    importId,
    { ...whole, archiveBytes: archive.length + 1 },
    uploadToken
  );
  expect(miscounted.status).toBe(400);
  expect((await listParts(importId, uploadToken)).parts).toHaveLength(parts.length);

  const wrong = await complete(importId, { ...whole, archiveSha256: 'f'.repeat(64) }, uploadToken);
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).code).toBe('IMPORT_ARCHIVE_INVALID');
  expect((await listParts(importId, uploadToken)).parts).toEqual([]);
  expect(await readImport(h, importId, key)).toMatchObject({ state: 'awaiting_upload' });

  for (const [index, part] of parts.entries())
    await expectStatus(await putPart(importId, index + 1, part, uploadToken), 200, 'part again');
  await expectStatus(await complete(importId, whole, uploadToken), 200, 'complete');
  // A retry of the same complete, whose answer was lost, is a success.
  await expectStatus(await complete(importId, whole, uploadToken), 200, 'complete again');
  await h.call(`/api/v1/host/imports/${importId}/cancel`, { bearer: key, body: {} });
  await expectNothingLeft(created.communityId);
});

// Purpose: a part replaced before complete keeps only the new bytes; a part whose bytes do not
// match its declared hash is refused and leaves nothing; bad part numbers and oversized parts
// are refused before the body is read; and a single upload is refused once parts have come.
it('replaces a part, and refuses a part that does not match or does not fit', async () => {
  const created = await createImport(h, { bearer: key });
  const { importId, communityId, uploadToken } = created;
  const first = archive.subarray(0, 64 * KIB);
  await expectStatus(await putPart(importId, 1, first, uploadToken), 200, 'part 1');
  const other = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(100, 1)]);
  const replaced = await expectStatus(await putPart(importId, 1, other, uploadToken), 200, 'swap');
  expect((await replaced.json()).sha256).toBe(sha256(other));
  await drainCleanup(h);
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging' AND state='committed'",
      [communityId]
    )
  ).toBe(1);

  const lying = await putPart(importId, 2, first, uploadToken, 'a'.repeat(64));
  expect(lying.status).toBe(400);
  expect((await listParts(importId, uploadToken)).parts.map((part) => part.partNumber)).toEqual([
    1,
  ]);
  // Refusals before the body is read get a body small enough to have been sent already.
  const tiny = Buffer.from('PK\u0003\u0004tiny');
  expect((await putPart(importId, 0, tiny, uploadToken)).status).toBe(400);
  expect((await putPart(importId, 10_001, tiny, uploadToken)).status).toBe(400);
  // Declared larger than a part may be: refused on the header, with no byte sent.
  const huge = await rawPart(importId, 2, first, uploadToken, 0, h.config.exports.segmentBytes + 1);
  expect(await huge.answer).toMatch(/^HTTP\/1\.1 413/);
  // The first part must start a zip archive, as a single upload must.
  expect((await putPart(importId, 1, Buffer.alloc(100, 2), uploadToken)).status).toBe(400);
  const single = await uploadArchive(h, importId, tiny, { bearer: uploadToken });
  expect(single.status).toBe(409);
  // Another import's token cannot reach these parts.
  const stranger = await createImport(h, { bearer: key });
  expect((await putPart(importId, 2, tiny, stranger.uploadToken)).status).toBe(401);
  expect(
    (await h.call(`/api/v1/imports/${importId}/archive/parts`, { bearer: stranger.uploadToken }))
      .status
  ).toBe(401);
  for (const target of [importId, stranger.importId])
    await h.call(`/api/v1/host/imports/${target}/cancel`, { bearer: key, body: {} });
  await expectNothingLeft(communityId);
  await expectNothingLeft(stranger.communityId);
});

// Purpose (AC-14): a fifth part upload to one import, and one past the replica's concurrency,
// are refused with 429 and Retry-After before a byte of their body is read, and the uploads in
// flight are not disturbed.
it('limits part uploads in flight per import and per replica', async () => {
  const one = await createImport(h, { bearer: key });
  const two = await createImport(h, { bearer: key });
  const three = await createImport(h, { bearer: key });
  const part = archive.subarray(0, 256 * KIB);
  const held = [];
  for (let number = 1; number <= 4; number++)
    held.push(await rawPart(one.importId, number, part, one.uploadToken, 1024));
  await partUploadsInFlight(4);
  const fifth = await rawPart(one.importId, 5, part, one.uploadToken, 0);
  const refused = await fifth.answer;
  expect(refused).toMatch(/^HTTP\/1\.1 429/);
  expect(refused).toMatch(/retry-after: 5/i);
  expect(refused).toContain('RATE_LIMITED');

  held.push(await rawPart(two.importId, 1, part, two.uploadToken, 1024));
  await partUploadsInFlight(5);
  const past = await rawPart(three.importId, 1, part, three.uploadToken, 0);
  const pastAnswer = await past.answer;
  expect(pastAnswer).toMatch(/^HTTP\/1\.1 429/);
  expect(pastAnswer).toMatch(/retry-after: 5/i);

  for (const upload of held) upload.close();
  await Promise.all(held.map((upload) => upload.answer));
  for (let attempt = 0; attempt < 3_000; attempt++) {
    if (!(await count('SELECT 1 FROM community_import_part_uploads'))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await count('SELECT 1 FROM community_import_part_uploads')).toBe(0);
  expect(
    await count('SELECT 1 FROM community_import_parts WHERE import_id=ANY($1)', [
      [one.importId, two.importId, three.importId],
    ])
  ).toBe(0);
  // A slot is free again.
  await expectStatus(await putPart(three.importId, 1, part, three.uploadToken), 200, 'after');
  for (const created of [one, two, three])
    await h.call(`/api/v1/host/imports/${created.importId}/cancel`, { bearer: key, body: {} });
  for (const created of [one, two, three]) await expectNothingLeft(created.communityId);
});

/** Rewrite the entry rows with these ids, wherever they are. */
function withEntries(ids: string[], change: (line: Record<string, unknown>) => void) {
  return (entries: [string, Buffer][]) => {
    for (const name of opened.manifest.files.entries) {
      const text = opened.files.get(name)!.toString('utf8');
      if (!ids.some((id) => text.includes(id))) continue;
      withLines(name, (lines) => {
        for (const line of lines) if (ids.includes(line.id as string)) change(line);
      })(entries);
    }
  };
}

// Purpose: a message the export marks removed or erased is restored as exactly the tombstone this
// host writes, whatever text or mentions the export planted there. A removed message can never
// be removed again, so planted text would otherwise stay for good.
it('restores a removed or erased message as its tombstone, never the text an export plants', async () => {
  const bytes = rebuilt(
    withEntries([marked.removed, marked.erased], (line) => {
      line.text = line.id === marked.removed ? 'PLANTED REMOVED' : 'PLANTED ERASED';
      line.mentions = [pat.memberId];
    })
  );
  const { importId } = await importInParts(bytes, 1 * MIB, { autoCommit: true });
  await runImports();
  expect(await readImport(h, importId, key)).toMatchObject({ state: 'ready' });
  const rows = await h.pool.query(
    `SELECT e.id,e.text,e.author_display_name,e.payload_hash,e.removed_by,
       e.erased_at IS NOT NULL AS erased,
       (SELECT count(*)::int FROM entry_mentions m WHERE m.entry_id=e.id) AS mentions
     FROM entries e WHERE e.id=ANY($1) ORDER BY e.removed_by NULLS LAST`,
    [[uuidv5(importId, marked.removed), uuidv5(importId, marked.erased)]]
  );
  expect(rows.rows).toEqual([
    {
      id: uuidv5(importId, marked.removed),
      text: REMOVED_ENTRY_TEXT.moderator,
      author_display_name: expect.any(String),
      payload_hash: tombstonePayloadHash(REMOVED_ENTRY_TEXT.moderator, null),
      removed_by: 'moderator',
      erased: false,
      mentions: 0,
    },
    {
      id: uuidv5(importId, marked.erased),
      text: ERASED_ENTRY_TEXT,
      author_display_name: ERASED_MEMBER_NAME,
      payload_hash: tombstonePayloadHash(ERASED_ENTRY_TEXT, null),
      removed_by: null,
      erased: true,
      mentions: 0,
    },
  ]);
}, 300_000);

// Purpose (AC-14): a caller that disconnects while `complete` checks the parts (as behind a proxy
// timeout) does not stop the check; the import moves on by itself, a retry during the check is
// told to wait, and a retry after it is answered with the result.
it('finishes a complete whose caller disconnected, and answers the retry', async () => {
  const created = await createImport(h, { bearer: key });
  const { importId, uploadToken } = created;
  const parts = cut(archive, 1 * MIB);
  for (const [index, part] of parts.entries())
    await expectStatus(await putPart(importId, index + 1, part, uploadToken), 200, 'part');
  const body = JSON.stringify({
    parts: parts.length,
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
  });
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  beforeCompleteHash = async (id) => {
    if (id !== importId) return;
    reached();
    await gate;
  };
  try {
    const { port } = new URL(h.baseUrl);
    const socket = connect(Number(port), '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      [
        `POST /api/v1/imports/${importId}/archive/complete HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${uploadToken}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n')
    );
    await paused;
    socket.destroy();
    const early = await complete(importId, JSON.parse(body), uploadToken);
    expect(early.status).toBe(202);
    expect(early.headers.get('retry-after')).toBe('5');
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    for (let attempt = 0; attempt < 3_000; attempt++) {
      const row = await h.pool.query(
        'SELECT upload_lease_token FROM community_imports WHERE id=$1',
        [importId]
      );
      if (!row.rows[0].upload_lease_token) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Settled without any retry: the caller's disconnect did not stop it.
    expect(await readImport(h, importId, key)).toMatchObject({ state: 'validating' });
  } finally {
    beforeCompleteHash = async () => undefined;
  }
  const retried = await expectStatus(
    await complete(importId, JSON.parse(body), uploadToken),
    200,
    'retry'
  );
  expect((await retried.json()).state).toBe('validating');
  await h.call(`/api/v1/host/imports/${importId}/cancel`, { bearer: key, body: {} });
  await expectNothingLeft(created.communityId);
}, 120_000);

// Purpose: parts still arriving count toward the largest import at their declared sizes, so
// parallel uploads cannot together pass `COMMUNITY_IMPORT_MAX_BYTES`.
it('counts parts still arriving toward the largest import', async () => {
  const created = await createImport(h, { bearer: key });
  const { importId, uploadToken } = created;
  const filler = Buffer.alloc(5 * MIB, 1);
  filler.write('PK\u0003\u0004');
  const held = await rawPart(importId, 1, filler, uploadToken, 1024);
  await partUploadsInFlight(1);
  const next = await rawPart(importId, 2, filler, uploadToken, 0, 4 * MIB);
  expect(await next.answer).toMatch(/^HTTP\/1\.1 413/);
  held.close();
  await held.answer;
  await h.call(`/api/v1/host/imports/${importId}/cancel`, { bearer: key, body: {} });
  await expectNothingLeft(created.communityId);
});

// Purpose (review): a small archive whose data files inflate a hundred times over into rows
// that cannot exist (256 MiB of memberships for agents the export does not hold) is refused
// before a row is read. The inflation cap itself is pinned in `import-v2.test.ts`.
it('refuses a membership bomb before reading it', async () => {
  const line = Buffer.from(
    `${JSON.stringify({ channel_id: channels.general, agent_id: randomUUID(), joined_at: '2026-01-01T00:00:00.000Z' })}\n`
  );
  const n = Math.floor((256 * MIB) / line.length);
  const big = Buffer.alloc(n * line.length);
  big.fill(line);
  const bytes = rebuilt((entries) => {
    entries.unshift(['agent-channel-members/000900.ndjson', big]);
    withManifest((manifest) => {
      const files = manifest.files as Record<string, string[]>;
      files.agentChannelMembers = [
        ...files.agentChannelMembers,
        'agent-channel-members/000900.ndjson',
      ];
      (manifest.counts as Record<string, number>).agentChannelMembers += n;
    })(entries);
  });
  expect(bytes.length).toBeLessThan(MAX_IMPORT_BYTES);
  const { importId, communityId } = await importInParts(bytes, 1 * MIB, { autoCommit: true });
  await runImports();
  expect(await readImport(h, importId, key)).toMatchObject({
    state: 'failed',
    failureCode: 'IMPORT_ARCHIVE_INVALID',
  });
  await expectNothingLeft(communityId);
}, 300_000);

// Purpose (review): agents' repetitive output is the core use case and compresses far more than
// people's chat (here about 80 times over), so a real export of it, written by this server's own
// exporter, must pass the inflation cap. Then a restore of it that fails after every message is
// in must tear down in bounded time: each deleted message's reply checks use the reply indexes
// rather than scanning the community (before them, 10,000 messages took 77 s and 40,000 took
// ten minutes).
it('imports an agent log that compresses far over, and tears a failed one down fast', async () => {
  const messages = 20_000;
  const community = await exportCommunity(h, operatorCookie, 'Agent Logs');
  const line = `[info] health ok: queue=0 workers=4 uptime stable ${'z'.repeat(40)}\n`;
  for (let done = 0; done < messages; done += 10_000)
    await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 10_000,
      textOf: (n) => `heartbeat ${n}\n${line.repeat(80)}`,
    });
  const requested = await requestOwnerExport(h, community);
  await runExport(h, { segmentBytes: 64 * MIB });
  const log = await downloadArchive(h, community, requested.export.id);
  const read = await openArchive(log);
  const inflated = read.names
    .filter((name) => name.endsWith('.ndjson'))
    .reduce((sum, name) => sum + read.files.get(name)!.length, 0);
  // Far over the 32 times an earlier cap allowed, past its 64 MiB floor.
  expect(inflated).toBeGreaterThan(64 * MIB + 32 * log.length);

  const ok = await importInParts(log, 4 * MIB, { autoCommit: true });
  await runImports();
  expect(await readImport(h, ok.importId, key)).toMatchObject({ state: 'ready' });
  expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [ok.communityId])).toBe(
    messages
  );

  // The same export again, failing once every message is restored.
  const doomed = await importInParts(log, 4 * MIB, { autoCommit: true });
  // One step at a time, stopping at the failure, before the teardown that would follow.
  const stopWhenFull = {
    afterBatch: async () => {
      if (
        (await count('SELECT 1 FROM entries WHERE community_id=$1', [doomed.communityId])) >=
        messages
      )
        throw new Error('stop');
    },
  };
  for (let round = 0; round < 200; round++) {
    await h.pool.query('UPDATE community_imports SET next_attempt_at=now() WHERE id=$1', [
      doomed.importId,
    ]);
    await sweepImports(h.pool, h.blobStore, h.config.limits, new Date(), stopWhenFull);
    if ((await readImport(h, doomed.importId, key)).state === 'failed') break;
  }
  expect(await readImport(h, doomed.importId, key)).toMatchObject({ state: 'failed' });
  expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [doomed.communityId])).toBe(
    messages
  );
  const started = performance.now();
  await expectNothingLeft(doomed.communityId);
  const teardownMs = performance.now() - started;
  // About 2 s with the reply indexes; without them each deleted message scans the community,
  // and this took 200 s.
  expect(teardownMs).toBeLessThan(60_000);
  // The checks both reply foreign keys run for each deleted message, as Postgres writes them.
  await h.pool.query('ANALYZE entries');
  const planOf = async (sql: string, params: unknown[]) =>
    (await h.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  const reply = randomUUID();
  expect(
    await planOf(
      'SELECT 1 FROM ONLY entries x WHERE $1::uuid=community_id AND $2::uuid=parent_entry_id FOR KEY SHARE OF x',
      // A community that still holds its 20,000 messages: the torn-down one is empty, and a
      // planner rightly scans an empty community by its own index.
      [ok.communityId, reply]
    )
  ).toContain('entries_parent_ref_idx');
  expect(
    await planOf(
      'SELECT 1 FROM ONLY entries x WHERE $1::uuid=thread_root_entry_id FOR KEY SHARE OF x',
      [reply]
    )
  ).toContain('entries_thread_root_ref_idx');
}, 1_200_000);

describe('a tampered version 2 export fails with its named code and leaves nothing', () => {
  const firstFile = () => opened.names.find((name) => name.startsWith('files/'))!;
  const channelsFile = () => opened.manifest.files.channels[0];
  const entriesFile = () => opened.manifest.files.entries[0];
  const cases: [string, () => Buffer, string][] = [
    [
      'a changed file byte',
      () =>
        rebuilt((entries) => {
          const file = entries.find(([name]) => name === firstFile())!;
          file[1][0] ^= 0xff;
        }),
      'IMPORT_CHECKSUM_MISMATCH',
    ],
    [
      'an NDJSON line that fails its schema',
      () =>
        rebuilt(
          withLines(channelsFile(), (lines) => {
            lines[0].visibility = 'secret';
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an NDJSON line with a field the schema does not know',
      () =>
        rebuilt(
          withLines(entriesFile(), (lines) => {
            lines[0].extra = true;
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a count that does not match the rows',
      () =>
        rebuilt(
          withManifest((manifest) => {
            (manifest.counts as Record<string, number>).entries += 1;
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a message listed twice',
      () =>
        rebuilt(
          withLines(entriesFile(), (lines) => {
            lines.splice(1, 0, lines[0]);
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      // Passes every per-row check; only the restore's insert sees the second copy.
      'a member listed twice',
      () =>
        rebuilt((entries) => {
          withLines(opened.manifest.files.members[0], (lines) => {
            lines.push(lines.find((line) => line.id === pat.memberId)!);
          })(entries);
          withManifest((manifest) => {
            (manifest.counts as Record<string, number>).members += 1;
          })(entries);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a reply whose parent is in another channel',
      () =>
        rebuilt((entries) => {
          const name = opened.manifest.files.entries.find((file) =>
            opened.files.get(file)!.toString('utf8').includes(marked.reply)
          )!;
          const elsewhere = opened
            .rows<{ id: string; channel_id: string }>('entries')
            .find((row) => row.channel_id === channels.elsewhere)!;
          withLines(name, (lines) => {
            const reply = lines.find((line) => line.id === marked.reply)!;
            reply.parent_entry_id = elsewhere.id;
            reply.thread_root_entry_id = elsewhere.id;
          })(entries);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file in a different channel than its message',
      () =>
        rebuilt((entries) => {
          withLines(opened.manifest.files.attachments[0], (lines) => {
            lines[0].channelId =
              lines[0].channelId === channels.hidden ? channels.general : channels.hidden;
          })(entries);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file on an erased message',
      () =>
        rebuilt((entries) => {
          for (const name of opened.manifest.files.attachments) {
            if (!opened.files.get(name)!.toString('utf8').includes(marked.agentFile)) continue;
            withLines(name, (lines) => {
              const file = lines.find((line) => line.id === marked.agentFile)!;
              file.entryId = marked.erased;
            })(entries);
          }
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      // Every other check passes: nothing mentions the owner, so only the id clash can refuse it
      // (a mention of a shared id would also fail, on the one-target rule).
      'an agent with a member’s id',
      () =>
        rebuilt((entries) => {
          const agent = {
            id: source.owner.memberId,
            owner_member_id: pat.memberId,
            display_name: 'Twin',
            handle: 'twin-bot',
            active: false,
            created_at: '2026-01-01T00:00:00.000Z',
            revoked_at: null,
          };
          entries.unshift(['agents/000777.ndjson', Buffer.from(`${JSON.stringify(agent)}\n`)]);
          withManifest((manifest) => {
            const files = manifest.files as Record<string, string[]>;
            files.agents = [...files.agents, 'agents/000777.ndjson'];
            (manifest.counts as Record<string, number>).agents += 1;
          })(entries);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an agent membership for an agent the export does not hold',
      () =>
        rebuilt((entries) => {
          withLines(opened.manifest.files.agentChannelMembers[0], (lines) => {
            lines.push({ ...lines[0], agent_id: randomUUID() });
          })(entries);
          withManifest((manifest) => {
            (manifest.counts as Record<string, number>).agentChannelMembers += 1;
          })(entries);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'more memberships than channels times people',
      () =>
        rebuilt(
          withManifest((manifest) => {
            (manifest.counts as Record<string, number>).channelMembers += 1_000;
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a duplicate name',
      () =>
        rebuilt((entries) => {
          const file = entries.find(([name]) => name === firstFile())!;
          entries.splice(entries.indexOf(file) + 1, 0, [file[0], file[1]]);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a name with ..',
      () =>
        rebuilt((entries) => {
          entries.unshift([`files/${randomUUID()}/../../escape`, Buffer.from('x')]);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a data file the manifest does not list',
      () =>
        rebuilt((entries) => {
          entries.unshift(['channels/999999.ndjson', Buffer.from('')]);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file no attachment names',
      () =>
        rebuilt((entries) => {
          entries.unshift([`files/${randomUUID()}/stowaway.txt`, Buffer.from('extra')]);
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an entry that inflates past its declared size',
      () => {
        const name = entriesFile();
        return inflatingPast(
          rebuilt(() => undefined),
          name,
          opened.files.get(name)!.length
        );
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'version 3',
      () =>
        rebuilt(
          withManifest((manifest) => {
            manifest.version = 3;
          })
        ),
      'IMPORT_VERSION_UNSUPPORTED',
    ],
    [
      'a personal export',
      () =>
        rebuilt(
          withManifest((manifest) => {
            manifest.scope = 'personal';
          })
        ),
      'IMPORT_NOT_OWNER_EXPORT',
    ],
    [
      'a line longer than any row',
      () =>
        rebuilt(
          withLines(entriesFile(), (lines) => {
            lines[0].text = 'x'.repeat(8 * MIB);
          })
        ),
      'IMPORT_ARCHIVE_INVALID',
    ],
  ];
  for (const [label, build, code] of cases) {
    it(
      label,
      async () => {
        const bytes = build();
        const { importId, communityId } = await importInParts(bytes, 1 * MIB, { autoCommit: true });
        await runImports();
        expect(await readImport(h, importId, key)).toMatchObject({
          state: 'failed',
          failureCode: code,
        });
        await expectNothingLeft(communityId);
      },
      120_000
    );
  }
});
