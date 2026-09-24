/**
 * Import, part 2 (spec `community-host-operator-api` P3, task 4.2): the worker that checks an
 * uploaded owner export, reports on it, waits for a commit, restores it all or nothing, and
 * the owner claim that adopts the exporting owner's own history.
 *
 * One source community, A, is seeded once with everything a version 1 export carries and
 * exported once; each test imports that archive (or a tampered copy) into a new community.
 */
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import { CommunityExportManifestV1Schema } from '@dorkos/shared/community-wire';
import { uuidv5 } from '../imports/derived-id.js';
import type { ImportWorkerHooks } from '../imports/process.js';
import { sweepImports } from '../imports/worker.js';
import { responseCookies } from './bootstrap-test-helper.js';
import { drainCleanup, person, post, seedCanaries, upload } from './member-erasure-fixture.js';
import {
  buildArchive,
  createImport,
  issueKey,
  ownerExport,
  readArchive,
  readImport,
  sha256,
  uploadArchive,
} from './import-fixture.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  createChannel,
  expectStatus,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let clock = new Date();
let key = '';
let a = '';
let archive: Buffer = Buffer.alloc(0);
let source: { manifest: CommunityExportManifestV1; files: Map<string, Uint8Array> };

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))
    .rows[0].n;
}

/** Run the import worker until nothing is due, with the test clock. */
async function runImports(hooks: ImportWorkerHooks = {}): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await h.pool.query('UPDATE community_imports SET next_attempt_at=$1 WHERE settled_at IS NULL', [
      clock,
    ]);
    await drainCleanup(h);
    const result = await sweepImports(h.pool, h.blobStore, h.config.limits, clock, hooks);
    if (!result.claimed) return;
  }
  throw new Error('Import work did not settle');
}

/** Create an import, upload `bytes`, and run the worker. */
async function importArchive(
  bytes: Buffer,
  body: Record<string, unknown> = {}
): Promise<{ importId: string; communityId: string }> {
  const created = await createImport(h, { bearer: key }, body);
  await expectStatus(
    await uploadArchive(h, created.importId, bytes, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  await runImports();
  return created;
}

/**
 * The worker's connection dropping mid-job, the transient failure a crash looks like to the
 * job: it is retried, unlike a fault that would only repeat.
 */
function connectionLost(): Error {
  return Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
}

async function commit(importId: string): Promise<void> {
  await expectStatus(
    await h.call(`/api/v1/host/imports/${importId}/commit`, { bearer: key, body: {} }),
    200,
    'commit'
  );
  await runImports();
}

/** Issue an owner claim for a ready import and redeem it as a brand-new account. */
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

/** Rebuild the source archive with a changed manifest, files, or entry layout. */
function tampered(
  change: (manifest: CommunityExportManifestV1, files: Map<string, Uint8Array>) => void
): Buffer {
  const manifest = structuredClone(source.manifest);
  const files = new Map([...source.files].map(([id, bytes]) => [id, new Uint8Array(bytes)]));
  change(manifest, files);
  return buildArchive(manifest, files);
}

async function expectNothingLeft(communityId: string): Promise<void> {
  await runImports();
  expect(await count('SELECT 1 FROM communities WHERE id=$1', [communityId])).toBe(0);
  expect(await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [communityId])).toBe(0);
  for (const table of ['channels', 'entries', 'members', 'attachments', 'audit_events'])
    expect(await count(`SELECT 1 FROM ${table} WHERE community_id=$1`, [communityId])).toBe(0);
}

beforeAll(async () => {
  h = await startTenancyHarness('importrestore', { now: () => clock });
  const host = await bootstrapHost(h, 'Olive Owner', 'olive@example.test');
  a = host.communityId;
  key = await issueKey(h, ['communities:import', 'communities:read', 'communities:write']);
  const owner = { cookie: host.cookie, memberId: host.memberId };
  const p = await person(h, await admit(h, a, owner.cookie, { name: 'Zeph', email: 'z@e.test' }));
  const leaver = await admit(h, a, owner.cookie, { name: 'Lee Leaver', email: 'lee@e.test' });
  await expectStatus(
    await h.call(`/api/v1/communities/${a}/channels/${host.channelId}/join`, {
      cookie: p.cookie,
      body: {},
    }),
    200,
    'join general'
  );
  const seeded = await seedCanaries(h, {
    communityId: a,
    channelId: host.channelId,
    p,
    other: owner,
  });
  // A post mentioning a person and an agent, by the owner.
  await expectStatus(
    await h.call(`/api/v1/communities/${a}/channels/${host.channelId}/entries`, {
      cookie: owner.cookie,
      body: {
        text: 'thanks both',
        idempotencyKey: 'mentions',
        mentions: [p.memberId, seeded.agent.id],
      },
    }),
    201,
    'mentioning post'
  );
  const secret = await createChannel(h, a, owner.cookie, 'secret', [leaver.cookie]);
  await h.call(`/api/v1/communities/${a}/channels/${secret}`, {
    method: 'PATCH',
    cookie: owner.cookie,
    body: { name: 'secret' },
  });
  await h.pool.query("UPDATE channels SET visibility='private' WHERE id=$1", [secret]);
  await post(
    h,
    a,
    secret,
    { cookie: leaver.cookie },
    { text: 'goodbye all', idempotencyKey: 'bye' }
  );
  const file = await upload(h, a, secret, owner.cookie, 'plan.txt', 'the plan');
  await post(
    h,
    a,
    secret,
    { cookie: owner.cookie },
    {
      text: 'the plan, attached',
      idempotencyKey: 'plan',
      attachmentIds: [file],
    }
  );
  const old = await createChannel(h, a, owner.cookie, 'old-news');
  await post(h, a, old, { cookie: owner.cookie }, { text: 'last word', idempotencyKey: 'last' });
  await expectStatus(
    await h.call(`/api/v1/communities/${a}/channels/${old}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { archived: true },
    }),
    200,
    'archive channel'
  );
  await expectStatus(
    await h.call(`/api/v1/communities/${a}/members/${leaver.memberId}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    }),
    204,
    'remove member'
  );
  await h.pool.query('UPDATE agents SET active=false,revoked_at=now() WHERE id=$1', [
    seeded.agent.id,
  ]);
  archive = await ownerExport(h, a, owner.cookie, TENANCY_PASSWORD);
  source = readArchive(archive);
  CommunityExportManifestV1Schema.parse(source.manifest);
});

afterAll(async () => {
  await h?.close();
});

// Purpose: the whole path, end to end. An export is checked, pauses with a counts-only report,
// is committed, and restores every channel, message, thread, mention, file, and audit event
// through the derived-ID map; the claimant adopts the owner's own history and nothing else
// carries an account or a credential. Fails on any lost or reordered field.
it('restores an owner export exactly, and the claimant adopts the owner’s history', async () => {
  const { manifest, files } = source;
  expect(manifest.entries.length).toBeGreaterThan(5);
  expect(manifest.attachments.length).toBe(2);
  expect(manifest.channels.some((channel) => channel.archived)).toBe(true);
  expect(manifest.channels.some((channel) => channel.visibility === 'private')).toBe(true);
  expect(manifest.members.some((member) => !member.active)).toBe(true);
  expect(manifest.agents.some((agent) => agent.revoked_at !== null)).toBe(true);
  expect(manifest.entries.some((entry) => entry.mentions.length === 2)).toBe(true);
  expect(manifest.entries.some((entry) => entry.parent_entry_id !== null)).toBe(true);

  const { importId, communityId } = await importArchive(archive);
  const checked = await readImport(h, importId, key);
  expect(checked.state).toBe('validated');
  expect(checked.report).toEqual({
    manifestVersion: 1,
    sourceLifecycle: 'active',
    channels: manifest.channels.length,
    entries: manifest.entries.length,
    attachments: manifest.attachments.length,
    historicalMembers: manifest.members.length,
    historicalAgents: manifest.agents.length,
    auditEvents: manifest.auditEvents!.length,
    attachmentBytes: manifest.attachments.reduce((sum, file) => sum + file.byteSize, 0),
    countedBytes: manifest.attachments.reduce((sum, file) => sum + file.byteSize, 0),
    fitsStorageLimit: true,
  });
  // The report carries counts and sizes only: no key or value from the export's text or names.
  const reportText = JSON.stringify(checked);
  for (const needle of [
    ...manifest.channels.map((channel) => channel.name),
    ...manifest.members.map((member) => member.display_name),
    ...manifest.entries.map((entry) => entry.text),
    ...manifest.attachments.map((file) => file.name),
  ])
    expect(reportText).not.toContain(needle);
  // Nothing is visible, and no file is stored, until the host commits.
  expect(await count('SELECT 1 FROM channels WHERE community_id=$1', [communityId])).toBe(0);
  expect(
    await count("SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='attachment'", [
      communityId,
    ])
  ).toBe(0);

  await commit(importId);
  const ready = await readImport(h, importId, key);
  expect(ready.state).toBe('ready');
  const derive = (id: string) => uuidv5(importId, id);

  const channels = await h.pool.query(
    `SELECT id,name,description,visibility,archived,created_at,last_seq::text FROM channels
     WHERE community_id=$1 ORDER BY id`,
    [communityId]
  );
  expect(channels.rows.map((row) => row.id).sort()).toEqual(
    manifest.channels.map((channel) => derive(channel.id)).sort()
  );
  for (const channel of manifest.channels) {
    const row = channels.rows.find((candidate) => candidate.id === derive(channel.id));
    expect(row).toMatchObject({
      name: channel.name,
      description: channel.description,
      visibility: channel.visibility,
      archived: channel.archived,
    });
    expect(row.created_at.toISOString()).toBe(channel.created_at);
    const seqs = manifest.entries
      .filter((entry) => entry.channel_id === channel.id)
      .map((entry) => Number(entry.seq));
    expect(Number(row.last_seq)).toBe(seqs.length ? Math.max(...seqs) : 0);
  }

  const entries = await h.pool.query(
    `SELECT e.id,e.channel_id,e.seq::text,e.author_member_id,e.author_agent_id,
       e.author_display_name,e.text,e.parent_entry_id,e.thread_root_entry_id,e.created_at,
       COALESCE((SELECT array_agg(COALESCE(m.mentioned_member_id,m.mentioned_agent_id)
         ORDER BY m.position) FROM entry_mentions m WHERE m.entry_id=e.id),'{}') AS mentions
     FROM entries e WHERE e.community_id=$1`,
    [communityId]
  );
  expect(entries.rowCount).toBe(manifest.entries.length);
  const byId = new Map(entries.rows.map((row) => [row.id, row]));
  for (const entry of manifest.entries) {
    const row = byId.get(derive(entry.id));
    expect(row).toBeDefined();
    expect({
      channel: row.channel_id,
      seq: row.seq,
      member: row.author_member_id,
      agent: row.author_agent_id,
      name: row.author_display_name,
      text: row.text,
      parent: row.parent_entry_id,
      root: row.thread_root_entry_id,
      mentions: row.mentions,
      at: row.created_at.toISOString(),
    }).toEqual({
      channel: derive(entry.channel_id),
      seq: entry.seq,
      member: entry.author_member_id && derive(entry.author_member_id),
      agent: entry.author_agent_id && derive(entry.author_agent_id),
      name: entry.author_display_name,
      text: entry.text,
      parent: entry.parent_entry_id && derive(entry.parent_entry_id),
      root: entry.thread_root_entry_id && derive(entry.thread_root_entry_id),
      mentions: entry.mentions.map(derive),
      at: entry.created_at,
    });
  }

  for (const attachment of manifest.attachments) {
    const row = (
      await h.pool.query('SELECT blob_key,entry_id,checksum FROM attachments WHERE id=$1', [
        derive(attachment.id),
      ])
    ).rows[0];
    expect(row).toMatchObject({
      entry_id: derive(attachment.entryId),
      checksum: attachment.checksum,
    });
    const read = await h.blobStore.get(row.blob_key);
    const chunks: Buffer[] = [];
    for await (const chunk of read.body) chunks.push(chunk as Buffer);
    expect(sha256(Buffer.concat(chunks))).toBe(attachment.checksum);
    expect(sha256(files.get(attachment.id)!)).toBe(attachment.checksum);
  }
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='attachment' AND state='committed'",
      [communityId]
    )
  ).toBe(manifest.attachments.length);
  // The uploaded export is queued for deletion once its content is restored.
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging' AND state<>'pending_delete'",
      [communityId]
    )
  ).toBe(0);
  expect(
    await count(`SELECT 1 FROM audit_events WHERE community_id=$1 AND id=ANY($2::uuid[])`, [
      communityId,
      manifest.auditEvents!.map((event) => derive(event.id)),
    ])
  ).toBe(manifest.auditEvents!.length);
  expect(
    await count(
      "SELECT 1 FROM audit_events WHERE community_id=$1 AND action='community.import' AND actor_kind='system'",
      [communityId]
    )
  ).toBe(1);
  expect(
    await count(
      "SELECT 1 FROM host_audit_events WHERE community_id=$1 AND action='import.complete' AND actor_kind='system'",
      [communityId]
    )
  ).toBe(1);

  // Every restored author is historical: no account, inactive, imported; agents revoked.
  expect(
    await count(
      "SELECT 1 FROM members WHERE community_id=$1 AND (user_id IS NOT NULL OR active OR origin<>'imported')",
      [communityId]
    )
  ).toBe(0);
  expect(
    await count('SELECT 1 FROM agents WHERE community_id=$1 AND (active OR revoked_at IS NULL)', [
      communityId,
    ])
  ).toBe(0);
  expect(await count('SELECT 1 FROM community_handles WHERE community_id=$1', [communityId])).toBe(
    manifest.members.length + manifest.agents.length
  );

  const claimant = await claim(communityId, 'Olive Again', 'olive2@example.test');
  const ownerRow = derive(manifest.requesterMemberId);
  expect(claimant.memberId).toBe(ownerRow);
  const adopted = await h.pool.query(
    `SELECT m.active,m.role,m.origin,u.email FROM members m JOIN "user" u ON u.id=m.user_id
     WHERE m.id=$1`,
    [ownerRow]
  );
  expect(adopted.rows).toEqual([
    { active: true, role: 'owner', origin: 'imported', email: 'olive2@example.test' },
  ]);
  expect(
    await count('SELECT 1 FROM members WHERE community_id=$1 AND user_id IS NOT NULL AND id<>$2', [
      communityId,
      ownerRow,
    ])
  ).toBe(0);
  for (const table of [
    'connection_grants',
    'agent_credentials',
    'connection_pairings',
    'invites',
    'pending_admissions',
  ])
    expect(await count(`SELECT 1 FROM ${table} WHERE community_id=$1`, [communityId])).toBe(0);
  // The adopted owner is in every channel and reads their own past messages as theirs.
  expect(
    await count('SELECT 1 FROM channel_members WHERE community_id=$1 AND member_id=$2', [
      communityId,
      ownerRow,
    ])
  ).toBe(manifest.channels.length);
  const general = manifest.channels.find((channel) => channel.name === 'general')!;
  const page = await expectStatus(
    await h.call(
      `/api/v1/communities/${communityId}/channels/${derive(general.id)}/entries?limit=50`,
      {
        cookie: claimant.cookie,
      }
    ),
    200,
    'read history'
  );
  const own = (await page.json()).entries.filter(
    (entry: { authorMemberId: string }) => entry.authorMemberId === ownerRow
  );
  expect(own.length).toBeGreaterThan(0);
  const notice = await expectStatus(
    await h.call(`/api/v1/communities/${communityId}/history-origin`, { cookie: claimant.cookie }),
    200,
    'history origin'
  );
  expect((await notice.json()).importedAt).toEqual(expect.any(String));

  // A re-export of the imported community parses and keeps every historical author.
  const again = readArchive(await ownerExport(h, communityId, claimant.cookie, TENANCY_PASSWORD));
  const reparsed = CommunityExportManifestV1Schema.parse(again.manifest);
  expect(reparsed.members.length).toBe(manifest.members.length);
  expect(reparsed.members.filter((member) => member.email === null)).toHaveLength(
    manifest.members.length - 1
  );
});

// Purpose: an import never reuses IDs. The same archive imported twice gives two communities
// with no ID in common. Fails if source IDs were preserved.
it('gives two imports of one archive disjoint IDs', async () => {
  const first = await importArchive(archive, { autoCommit: true });
  const second = await importArchive(archive, { autoCommit: true });
  expect((await readImport(h, first.importId, key)).state).toBe('ready');
  const ids = async (communityId: string) =>
    (
      await h.pool.query<{ id: string }>(
        `SELECT id FROM entries WHERE community_id=$1 UNION ALL SELECT id FROM channels WHERE community_id=$1
         UNION ALL SELECT id FROM members WHERE community_id=$1`,
        [communityId]
      )
    ).rows.map((row) => row.id);
  const one = new Set(await ids(first.communityId));
  const two = await ids(second.communityId);
  expect(two.length).toBe(one.size);
  expect(two.filter((id) => one.has(id))).toEqual([]);
  const sourceIds = new Set(await ids(a));
  expect([...one].filter((id) => sourceIds.has(id))).toEqual([]);
});

// Purpose: a worker that stops after some files resumes where it stopped: every file is
// stored exactly once and no orphaned file is left in the inventory.
it('resumes a restore after a crash without storing a file twice', async () => {
  const extra = tampered((manifest, files) => {
    const template = manifest.attachments[0];
    for (let index = 0; index < 3; index++) {
      const id = randomUUID();
      const bytes = Buffer.from(`extra file ${index}`);
      files.set(id, bytes);
      manifest.attachments.push({
        ...template,
        id,
        byteSize: bytes.length,
        checksum: sha256(bytes),
        archivePath: `attachments/${id}`,
      });
    }
  });
  const { importId, communityId } = await importArchive(extra);
  await expectStatus(
    await h.call(`/api/v1/host/imports/${importId}/commit`, { bearer: key, body: {} }),
    200,
    'commit'
  );
  // The worker stops after two of five files (a crash, as far as this job is concerned): the
  // two stay recorded and the import stays restoring.
  await h.pool.query('UPDATE community_imports SET next_attempt_at=$1 WHERE id=$2', [
    clock,
    importId,
  ]);
  await sweepImports(h.pool, h.blobStore, h.config.limits, clock, {
    afterFile: async (stored) => {
      if (stored === 2) throw connectionLost();
    },
  });
  expect((await readImport(h, importId, key)).state).toBe('restoring');
  expect(await count('SELECT 1 FROM community_import_files WHERE import_id=$1', [importId])).toBe(
    2
  );
  await runImports();
  expect((await readImport(h, importId, key)).state).toBe('ready');
  const blobs = await h.pool.query(
    "SELECT state,count(*)::int AS n FROM managed_blobs WHERE community_id=$1 AND purpose='attachment' GROUP BY state",
    [communityId]
  );
  expect(blobs.rows).toEqual([{ state: 'committed', n: 5 }]);
  expect(await count('SELECT 1 FROM attachments WHERE community_id=$1', [communityId])).toBe(5);
});

// Purpose: files are committed only with the rows. A worker stopped after the last file and
// before the row transaction leaves no visible channel and no committed file.
it('shows nothing when stopped between the last file and the rows', async () => {
  const created = await createImport(h, { bearer: key }, { autoCommit: true });
  await expectStatus(
    await uploadArchive(h, created.importId, archive, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  await h.pool.query('UPDATE community_imports SET next_attempt_at=$1', [clock]);
  await drainCleanup(h);
  // Check, then restore every file and stop before the row transaction.
  for (let run = 0; run < 2; run++) {
    await h.pool.query('UPDATE community_imports SET next_attempt_at=$1', [clock]);
    await sweepImports(h.pool, h.blobStore, h.config.limits, clock, {
      beforeRows: async () => {
        throw connectionLost();
      },
    });
  }
  expect((await readImport(h, created.importId, key)).state).toBe('restoring');
  expect(await count('SELECT 1 FROM channels WHERE community_id=$1', [created.communityId])).toBe(
    0
  );
  expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [created.communityId])).toBe(0);
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state='committed' AND purpose='attachment'",
      [created.communityId]
    )
  ).toBe(0);
  expect(
    await count("SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state='stored'", [
      created.communityId,
    ])
  ).toBe(2);
  // Cancelling then removes the stored files and the community.
  await expectStatus(
    await h.call(`/api/v1/host/imports/${created.importId}/cancel`, { bearer: key, body: {} }),
    200,
    'cancel'
  );
  await expectNothingLeft(created.communityId);
});

describe('a tampered export fails with its named code and leaves nothing', () => {
  const cases: [string, () => Buffer, string][] = [
    [
      'a changed file byte',
      () =>
        tampered((_manifest, files) => {
          const [id, bytes] = [...files][0];
          const changed = new Uint8Array(bytes);
          changed[0] ^= 1;
          files.set(id, changed);
        }),
      'IMPORT_CHECKSUM_MISMATCH',
    ],
    [
      'a mention outside the manifest',
      () =>
        tampered((manifest) => {
          manifest.entries[0].mentions = [randomUUID()];
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a reply whose parent is in another channel',
      () =>
        tampered((manifest) => {
          const reply = manifest.entries.find((entry) => entry.parent_entry_id)!;
          const elsewhere = manifest.entries.find(
            (entry) => entry.channel_id !== reply.channel_id && !entry.parent_entry_id
          )!;
          reply.parent_entry_id = elsewhere.id;
          reply.thread_root_entry_id = elsewhere.id;
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an owner who is not the exporter',
      () =>
        tampered((manifest) => {
          manifest.requesterMemberId = manifest.members.find(
            (member) => member.role !== 'owner'
          )!.id;
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a ../x entry name',
      () =>
        buildArchive(null, undefined, [
          ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
          ['../x', Buffer.from('escape')],
        ]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a second manifest.json',
      () =>
        buildArchive(null, undefined, [
          ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
          ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
        ]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file before the manifest',
      () =>
        buildArchive(null, undefined, [
          ...[...source.files].map(([id, bytes]): [string, Uint8Array] => [
            `attachments/${id}`,
            bytes,
          ]),
          ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
        ]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a personal export',
      () =>
        tampered((manifest) => {
          manifest.scope = 'personal';
        }),
      'IMPORT_NOT_OWNER_EXPORT',
    ],
    [
      'version 2',
      () => tampered((manifest) => Object.assign(manifest, { version: 2 })),
      'IMPORT_VERSION_UNSUPPORTED',
    ],
    [
      'a file that inflates past its declared size',
      () => inflatingArchive(),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a manifest over 16 MiB',
      () =>
        tampered((manifest) => {
          manifest.entries[0].text = 'x'.repeat(17 * 1024 * 1024);
        }),
      'IMPORT_TOO_LARGE',
    ],
    [
      'a null character in a message',
      () =>
        tampered((manifest) => {
          manifest.entries[0].text = 'nul \u0000 here';
        }),
      'IMPORT_ARCHIVE_INVALID',
    ],
  ];
  for (const [label, build, code] of cases) {
    it(label, async () => {
      const { importId, communityId } = await importArchive(build(), { autoCommit: true });
      const result = await readImport(h, importId, key);
      expect(result).toMatchObject({ state: 'failed', failureCode: code, report: null });
      expect(
        await count(
          "SELECT 1 FROM host_audit_events WHERE community_id=$1 AND action='import.fail' AND actor_kind='system'",
          [communityId]
        )
      ).toBe(1);
      await expectNothingLeft(communityId);
    });
  }
});

/**
 * An archive whose one file is deflated and whose central directory claims a size one byte
 * short, with the manifest agreeing, so only inflating the bytes can reveal the lie.
 */
function inflatingArchive(): Buffer {
  const manifest = structuredClone(source.manifest);
  const [id, bytes] = [...source.files][0];
  const attachment = manifest.attachments.find((file) => file.id === id)!;
  manifest.attachments = [attachment];
  attachment.byteSize = bytes.length - 1;
  const zipped = buildArchive(manifest, new Map([[id, bytes]]), undefined, { deflate: true });
  const name = Buffer.from(`attachments/${id}`);
  for (let at = zipped.length - 22; at >= 0; at--) {
    if (
      zipped.readUInt32LE(at) === 0x02014b50 &&
      zipped.subarray(at + 46, at + 46 + name.length).equals(name)
    ) {
      zipped.writeUInt32LE(bytes.length - 1, at + 24);
      return zipped;
    }
  }
  throw new Error('central directory record not found');
}

// Purpose: an export that does not fit the community's storage limit fails before any file
// is restored, with the storage limit's own code.
it('fails an import that does not fit the storage limit before storing a file', async () => {
  const { importId, communityId } = await importArchive(archive, {
    autoCommit: true,
    limits: { maxActiveMembers: null, maxStorageBytes: 1 },
  });
  expect(await readImport(h, importId, key)).toMatchObject({
    state: 'failed',
    failureCode: 'STORAGE_LIMIT_REACHED',
  });
  expect(
    await count("SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='attachment'", [
      communityId,
    ])
  ).toBe(0);
  await expectNothingLeft(communityId);
});

// Purpose: a checked import can be cancelled at the pause, leaving nothing, and one left
// uncommitted for seven days is cancelled for the host.
it('cancels at validated, and cancels a checked import left for seven days', async () => {
  const paused = await importArchive(archive);
  expect((await readImport(h, paused.importId, key)).state).toBe('validated');
  await expectStatus(
    await h.call(`/api/v1/host/imports/${paused.importId}/cancel`, { bearer: key, body: {} }),
    200,
    'cancel'
  );
  await expectNothingLeft(paused.communityId);
  expect((await readImport(h, paused.importId, key)).report).not.toBeNull();

  const stale = await importArchive(archive);
  clock = new Date(Date.now() + 8 * 24 * 60 * 60_000);
  try {
    await runImports();
    expect((await readImport(h, stale.importId, key)).state).toBe('cancelled');
    await expectNothingLeft(stale.communityId);
  } finally {
    clock = new Date();
  }
});

// Purpose: commit is only for a checked import; a commit before the check or after the end
// is a state conflict, and a key without the import scope cannot commit.
it('commits only a validated import, with the import scope', async () => {
  const created = await createImport(h, { bearer: key });
  const early = await h.call(`/api/v1/host/imports/${created.importId}/commit`, {
    bearer: key,
    body: {},
  });
  expect(early.status).toBe(409);
  const reader = await issueKey(h, ['communities:read']);
  await expectStatus(
    await uploadArchive(h, created.importId, archive, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  await runImports();
  const refused = await h.call(`/api/v1/host/imports/${created.importId}/commit`, {
    bearer: reader,
    body: {},
  });
  expect(refused.status).toBe(403);
  await commit(created.importId);
  const late = await h.call(`/api/v1/host/imports/${created.importId}/commit`, {
    bearer: key,
    body: {},
  });
  expect(late.status).toBe(409);
});

// Purpose: a ready community that nobody claimed can be abandoned by the host; it holds
// content, so its rows and files are removed in the background.
it('abandons a ready, unclaimed import with all of its content', async () => {
  const { importId, communityId } = await importArchive(archive, { autoCommit: true });
  expect((await readImport(h, importId, key)).state).toBe('ready');
  const abandoned = await h.call(`/api/v1/host/communities/${communityId}`, {
    method: 'DELETE',
    bearer: key,
  });
  expect(abandoned.status).toBe(202);
  await expectNothingLeft(communityId);
  expect((await readImport(h, importId, key)).state).toBe('cancelled');
});

/** A hand-built owner export: one owner, one channel, and whatever `change` adds. */
function handBuilt(
  change: (manifest: CommunityExportManifestV1, files: Map<string, Uint8Array>) => void
): Buffer {
  const owner = randomUUID();
  const manifest: CommunityExportManifestV1 = {
    version: 1,
    scope: 'owner',
    requesterMemberId: owner,
    community: { id: randomUUID(), lifecycle: 'active', lifecycleVersion: 2, settingsVersion: 1 },
    auditEvents: [],
    channels: [
      {
        id: randomUUID(),
        name: 'c'.repeat(80),
        description: 'd'.repeat(1_000),
        visibility: 'public',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    members: [
      {
        id: owner,
        display_name: 'O',
        handle: 'oo',
        role: 'owner',
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        removed_at: null,
        email: null,
      },
    ],
    agents: [],
    entries: [],
    attachments: [],
  };
  const files = new Map<string, Uint8Array>();
  change(manifest, files);
  return buildArchive(manifest, files);
}

// Purpose: an import is held to exactly what the member API can serve. An export at every
// limit at once (eight files on one message, text at COMMUNITY_TEXT_BYTES, a sequence at
// 2^53-1, a one-letter author, the longest channel name and description) restores, and every
// read a member makes of it (channels, history, the thread, thread summaries) answers 200.
it('restores content at every limit and serves it through the member API', async () => {
  const archive = handBuilt((manifest, files) => {
    const channel = manifest.channels[0].id;
    const owner = manifest.requesterMemberId;
    const root = randomUUID();
    const reply = randomUUID();
    const base = {
      channel_id: channel,
      author_member_id: owner,
      author_agent_id: null,
      author_display_name: 'O',
      mentions: [owner],
      created_at: '2026-01-02T00:00:00.000Z',
    };
    manifest.entries.push(
      {
        ...base,
        id: root,
        seq: '9007199254740990',
        text: 'é'.repeat(h.config.limits.textBytes / 2),
        parent_entry_id: null,
        thread_root_entry_id: null,
      },
      {
        ...base,
        id: reply,
        seq: '9007199254740991',
        text: 'reply',
        parent_entry_id: root,
        thread_root_entry_id: root,
      }
    );
    for (let n = 0; n < 8; n++) {
      const id = randomUUID();
      const bytes = Buffer.from(`file ${n}`);
      files.set(id, bytes);
      manifest.attachments.push({
        id,
        channelId: channel,
        entryId: root,
        uploaderMemberId: owner,
        uploaderAgentId: null,
        name: `f${n}.txt`,
        contentType: 'text/plain',
        byteSize: bytes.length,
        checksum: sha256(bytes),
        uploadedAt: '2026-01-02T00:00:00.000Z',
        archivePath: `attachments/${id}`,
      });
    }
  });
  const { importId, communityId } = await importArchive(archive, { autoCommit: true });
  expect((await readImport(h, importId, key)).state).toBe('ready');
  const owner = await claim(communityId, 'Extreme Owner', `extreme-${randomUUID()}@e.test`);
  const base = `/api/v1/communities/${communityId}`;
  const channels = await expectStatus(
    await h.call(`${base}/channels`, { cookie: owner.cookie }),
    200,
    'channels'
  );
  const [channel] = (await channels.json()).channels;
  const history = await expectStatus(
    await h.call(`${base}/channels/${channel.id}/entries?limit=50`, { cookie: owner.cookie }),
    200,
    'history'
  );
  const entries = (await history.json()).entries;
  const root = entries.find((entry: { parentEntryId: string | null }) => !entry.parentEntryId);
  expect(root.attachments).toHaveLength(8);
  expect(root.seq).toBe(9007199254740990);
  await expectStatus(
    await h.call(`${base}/channels/${channel.id}/entries?limit=50&thread=${root.id}`, {
      cookie: owner.cookie,
    }),
    200,
    'thread'
  );
  const threads = await expectStatus(
    await h.call(`${base}/channels/${channel.id}/threads?roots=${root.id}`, {
      cookie: owner.cookie,
    }),
    200,
    'thread summaries'
  );
  expect((await threads.json()).threads[0].lastReplySeq).toBe(9007199254740991);
});

describe('an export past a member-API or host limit fails and leaves nothing', () => {
  const past: [string, (m: CommunityExportManifestV1) => void, string][] = [
    [
      'a sequence past 2^53',
      (m) => {
        m.entries.push({
          id: randomUUID(),
          channel_id: m.channels[0].id,
          seq: '9007199254740993',
          author_member_id: m.requesterMemberId,
          author_agent_id: null,
          author_display_name: 'O',
          text: 'x',
          mentions: [],
          parent_entry_id: null,
          thread_root_entry_id: null,
          created_at: '2026-01-02T00:00:00.000Z',
        });
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an empty author name',
      (m) => {
        m.entries.push({
          id: randomUUID(),
          channel_id: m.channels[0].id,
          seq: '1',
          author_member_id: m.requesterMemberId,
          author_agent_id: null,
          author_display_name: '',
          text: 'x',
          mentions: [],
          parent_entry_id: null,
          thread_root_entry_id: null,
          created_at: '2026-01-02T00:00:00.000Z',
        });
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a channel name over 80 characters',
      (m) => void (m.channels[0].name = 'c'.repeat(81)),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a message newer than the upload',
      (m) => {
        m.entries.push({
          id: randomUUID(),
          channel_id: m.channels[0].id,
          seq: '1',
          author_member_id: m.requesterMemberId,
          author_agent_id: null,
          author_display_name: 'O',
          text: 'x',
          mentions: [],
          parent_entry_id: null,
          thread_root_entry_id: null,
          created_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        });
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
  ];
  for (const [label, change, code] of past) {
    it(label, async () => {
      const { importId, communityId } = await importArchive(handBuilt(change), {
        autoCommit: true,
      });
      expect(await readImport(h, importId, key)).toMatchObject({
        state: 'failed',
        failureCode: code,
      });
      await expectNothingLeft(communityId);
    });
  }
});

describe('a hostile archive fails before anything is stored', () => {
  // Purpose: the entry count is bounded before the central directory is read, so a file
  // declaring more entries than an export can hold is refused as too large.
  it('an entry-count bomb', async () => {
    const entries: [string, Uint8Array][] = [
      ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
      ...Array.from({ length: 10_001 }, (): [string, Uint8Array] => [
        `attachments/${randomUUID()}`,
        new Uint8Array(1),
      ]),
    ];
    const { importId, communityId } = await importArchive(buildArchive(null, undefined, entries), {
      autoCommit: true,
    });
    expect(await readImport(h, importId, key)).toMatchObject({ failureCode: 'IMPORT_TOO_LARGE' });
    await expectNothingLeft(communityId);
  });

  // Purpose: a small deflated entry that declares a huge size is refused from the directory
  // alone, before a byte is inflated.
  it('a deflate bomb', async () => {
    const id = randomUUID();
    const zeros = new Uint8Array(30 * 1024 * 1024);
    const archive = handBuilt((manifest, files) => {
      files.set(id, zeros);
      manifest.attachments.push({
        id,
        channelId: manifest.channels[0].id,
        entryId: randomUUID(),
        uploaderMemberId: manifest.requesterMemberId,
        uploaderAgentId: null,
        name: 'z',
        contentType: 'text/plain',
        byteSize: zeros.length,
        checksum: sha256(zeros),
        uploadedAt: '2026-01-02T00:00:00.000Z',
        archivePath: `attachments/${id}`,
      });
    });
    const zipped = buildArchive(
      JSON.parse(strFromU8(unzipSync(archive)['manifest.json'])),
      new Map([[id, zeros]]),
      undefined,
      { deflate: true }
    );
    expect(zipped.length).toBeLessThan(1024 * 1024);
    const { importId, communityId } = await importArchive(zipped, { autoCommit: true });
    expect(await readImport(h, importId, key)).toMatchObject({ failureCode: 'IMPORT_TOO_LARGE' });
    await expectNothingLeft(communityId);
  });

  // Purpose: the archive holds exactly the files its manifest names: an extra file, or one
  // file twice, is refused.
  it('an extra file, and a file stored twice', async () => {
    const extra = buildArchive(null, undefined, [
      ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
      ...[...source.files].map(([id, bytes]): [string, Uint8Array] => [`attachments/${id}`, bytes]),
      [`attachments/${randomUUID()}`, Buffer.from('smuggled')],
    ]);
    const [firstId, firstBytes] = [...source.files][0];
    const twice = buildArchive(null, undefined, [
      ['manifest.json', Buffer.from(JSON.stringify(source.manifest))],
      ...[...source.files].map(([id, bytes]): [string, Uint8Array] => [`attachments/${id}`, bytes]),
      [`attachments/${firstId}`, firstBytes],
    ]);
    for (const bytes of [extra, twice]) {
      const { importId, communityId } = await importArchive(bytes, { autoCommit: true });
      expect(await readImport(h, importId, key)).toMatchObject({
        failureCode: 'IMPORT_ARCHIVE_INVALID',
      });
      await expectNothingLeft(communityId);
    }
  });
});

// Purpose: restored audit events carry their own mark, so an event an export claims can never
// pass for one this host wrote; this host's own import event is native.
it('marks restored audit events as imported', async () => {
  const { communityId } = await importArchive(archive, { autoCommit: true });
  const origins = await h.pool.query<{ origin: string; action: string }>(
    'SELECT origin,action FROM audit_events WHERE community_id=$1',
    [communityId]
  );
  expect(origins.rows.filter((row) => row.action === 'community.import')).toEqual([
    { origin: 'native', action: 'community.import' },
  ]);
  expect(
    origins.rows
      .filter((row) => row.action !== 'community.import')
      .every((row) => row.origin === 'imported')
  ).toBe(true);
  expect(origins.rows.length).toBe(source.manifest.auditEvents!.length + 1);
});

// Purpose: a fault that would repeat (a missing piece of the job, not storage going away)
// ends the import at once instead of retrying it eight times as a storage failure.
it('fails at once when the uploaded export is gone, instead of retrying', async () => {
  const created = await createImport(h, { bearer: key }, { autoCommit: true });
  await expectStatus(
    await uploadArchive(h, created.importId, archive, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  const staging = await h.pool.query<{ staging_blob_key: string }>(
    'SELECT staging_blob_key FROM community_imports WHERE id=$1',
    [created.importId]
  );
  await h.blobStore.delete(staging.rows[0].staging_blob_key);
  await h.pool.query('UPDATE community_imports SET next_attempt_at=$1 WHERE id=$2', [
    clock,
    created.importId,
  ]);
  await sweepImports(h.pool, h.blobStore, h.config.limits, clock);
  const row = await h.pool.query(
    'SELECT state,attempts,failure_code FROM community_imports WHERE id=$1',
    [created.importId]
  );
  expect(row.rows[0]).toEqual({
    state: 'failed',
    attempts: 0,
    failure_code: 'IMPORT_STORAGE_UNAVAILABLE',
  });
  await expectNothingLeft(created.communityId);
});

// Purpose: if the community stops being unclaimed before the rows are written, the import
// ends as cancelled instead of retrying forever, and its own files go while the community,
// which is no longer the import's to remove, stays.
it('cancels an import whose community moved on, and keeps that community', async () => {
  const created = await createImport(h, { bearer: key }, { autoCommit: true });
  await expectStatus(
    await uploadArchive(h, created.importId, archive, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  const user = (await h.pool.query<{ id: string }>('SELECT id FROM "user" LIMIT 1')).rows[0].id;
  await runImports({
    beforeRows: async () => {
      const client = await h.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO members(community_id,user_id,display_name,handle,role)
           VALUES($1,$2,'Someone','someone','owner')`,
          [created.communityId, user]
        );
        await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [
          created.communityId,
        ]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  });
  expect(await readImport(h, created.importId, key)).toMatchObject({ state: 'cancelled' });
  const settled = await h.pool.query('SELECT settled_at FROM community_imports WHERE id=$1', [
    created.importId,
  ]);
  expect(settled.rows[0].settled_at).not.toBeNull();
  expect(await count('SELECT 1 FROM communities WHERE id=$1', [created.communityId])).toBe(1);
  expect(
    await count("SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state<>'pending_delete'", [
      created.communityId,
    ])
  ).toBe(0);
});
