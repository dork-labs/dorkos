/**
 * Import, part 2 (spec `community-host-operator-api` P3, task 4.2): the worker that checks an
 * uploaded owner export, reports on it, waits for a commit, restores it all or nothing, and
 * the owner claim that adopts the exporting owner's own history.
 *
 * One source community, A, is seeded once with everything a version 1 export carries and
 * exported once; each test imports that archive (or a tampered copy) into a new community.
 */
import { randomUUID } from 'node:crypto';
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
    const result = await sweepImports(h.pool, h.blobStore, clock, hooks);
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
  await sweepImports(h.pool, h.blobStore, clock, {
    afterFile: async (stored) => {
      if (stored === 2) throw new Error('worker stopped');
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
    await sweepImports(h.pool, h.blobStore, clock, {
      beforeRows: async () => {
        throw new Error('stopped before rows');
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
