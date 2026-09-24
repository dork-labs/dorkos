/**
 * Import, part 1 (spec `community-host-operator-api` P3, task 4.1): the manifest contract,
 * historical members, creating an import, uploading its export, and cancelling it.
 *
 * Tests run in order and share one host whose first community, A, the operator owns.
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CommunityExportManifestV1Schema } from '@dorkos/shared/community-wire';
import { sweepImports } from '../imports/worker.js';
import { drainCleanup, post, upload } from './member-erasure-fixture.js';
import {
  buildArchive,
  createImport,
  droppedUpload,
  issueKey,
  minimalManifest,
  ownerExport,
  readArchive,
  readImport,
  sha256,
  uploadArchive,
} from './import-fixture.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let clock = new Date();
let operatorCookie = '';
let a = '';
let channelA = '';
let keyImport = '';
let keyRead = '';
let keyWrite = '';
const logged: string[] = [];

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))
    .rows[0].n;
}

/** Run the import sweep until it has nothing due, with the clock where the test set it. */
async function settleImports(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await h.pool.query('UPDATE community_imports SET next_attempt_at=$1 WHERE settled_at IS NULL', [
      clock,
    ]);
    await drainCleanup(h);
    const result = await sweepImports(h.pool, h.blobStore, clock);
    if (!result.claimed) return;
  }
  throw new Error('Import work did not settle');
}

beforeAll(async () => {
  // Every line the server logs during this file, to prove no one-time secret reaches a log.
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      );
    });
  }
  h = await startTenancyHarness('imports', { now: () => clock });
  const host = await bootstrapHost(h, 'Operator', 'operator@example.test');
  operatorCookie = host.cookie;
  a = host.communityId;
  channelA = host.channelId;
  keyImport = await issueKey(h, ['communities:import']);
  keyRead = await issueKey(h, ['communities:read']);
  keyWrite = await issueKey(h, ['communities:write']);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

// Purpose: the version 1 manifest schema is the contract an importer reads. A real owner
// export must parse with it, or the exporter and the importer have drifted apart.
it('parses a real owner export with the version 1 manifest schema', async () => {
  const root = await post(
    h,
    a,
    channelA,
    { cookie: operatorCookie },
    {
      text: 'hello from A',
      idempotencyKey: 'root',
    }
  );
  await post(
    h,
    a,
    channelA,
    { cookie: operatorCookie },
    {
      text: 'a reply',
      idempotencyKey: 'reply',
      parentEntryId: root.id,
    }
  );
  const file = await upload(h, a, channelA, operatorCookie, 'notes.txt', 'file body');
  await post(
    h,
    a,
    channelA,
    { cookie: operatorCookie },
    {
      text: 'see the file',
      idempotencyKey: 'with-file',
      attachmentIds: [file],
    }
  );
  const { manifest, files } = readArchive(
    await ownerExport(h, a, operatorCookie, TENANCY_PASSWORD)
  );
  const parsed = CommunityExportManifestV1Schema.parse(manifest);
  expect(parsed.scope).toBe('owner');
  expect(parsed.entries.map((entry) => entry.seq)).toEqual(['1', '2', '3']);
  expect(parsed.attachments).toHaveLength(1);
  expect(sha256(files.get(parsed.attachments[0].id)!)).toBe(parsed.attachments[0].checksum);
});

// Purpose: a historical member has no account. A re-export of a community holding one must
// still carry that author (with no email), or an inner join would silently drop them.
it('keeps a historical member, with a null email, in a re-export', async () => {
  const historical = await h.pool.query<{ id: string }>(
    `INSERT INTO members(community_id,user_id,display_name,handle,role,active,origin)
     VALUES($1,NULL,'Former Author','former','member',false,'imported') RETURNING id`,
    [a]
  );
  await h.pool.query(
    'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
    [a, 'former', historical.rows[0].id]
  );
  const { manifest } = readArchive(await ownerExport(h, a, operatorCookie, TENANCY_PASSWORD));
  const parsed = CommunityExportManifestV1Schema.parse(manifest);
  expect(parsed.members).toContainEqual(
    expect.objectContaining({
      id: historical.rows[0].id,
      display_name: 'Former Author',
      email: null,
    })
  );
});

// Purpose: only an imported, inactive member may lack an account; the database refuses any
// other member without one, so the rule cannot be bypassed by a code path that forgets it.
it('accepts a member without an account only when imported and inactive', async () => {
  const insert = (active: boolean, origin: string) =>
    h.pool.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role,active,origin)
       VALUES($1,NULL,'x',$2,'member',$3,$4)`,
      [a, `h${Math.random().toString(36).slice(2, 10)}`, active, origin]
    );
  await expect(insert(false, 'native')).rejects.toThrow(/members_user_presence/);
  await expect(insert(true, 'imported')).rejects.toThrow(/members_user_presence/);
  await expect(insert(false, 'elsewhere')).rejects.toThrow(/members_origin/);
});

// Purpose: creating an import makes an unclaimed community and a one-time upload token in
// one step; a replay never returns the token again and a changed request under the same key
// is refused, so a retry can neither leak the token nor silently change the import.
it('creates an import, replays it without the token, and refuses a changed replay', async () => {
  const body = {
    idempotencyKey: 'move-1',
    name: 'Moved',
    limits: { maxActiveMembers: 5, maxStorageBytes: null },
  };
  const first = await expectStatus(
    await h.call('/api/v1/host/imports', { bearer: keyImport, body }),
    201,
    'create'
  );
  expect(first.headers.get('cache-control')).toBe('no-store');
  const created = await first.json();
  expect(created.replayed).toBe(false);
  expect(created.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.import).toMatchObject({
    state: 'awaiting_upload',
    report: null,
    failureCode: null,
  });
  const community = await h.pool.query('SELECT lifecycle,name FROM communities WHERE id=$1', [
    created.import.communityId,
  ]);
  expect(community.rows[0]).toEqual({ lifecycle: 'pending_owner', name: 'Moved' });
  expect(
    await count('SELECT 1 FROM community_limits WHERE community_id=$1 AND max_active_members=5', [
      created.import.communityId,
    ])
  ).toBe(1);
  // No owner claim is issued until the import is ready.
  expect(
    await count('SELECT 1 FROM bootstrap_grants WHERE community_id=$1', [
      created.import.communityId,
    ])
  ).toBe(0);
  expect(
    await count(
      "SELECT 1 FROM host_audit_events WHERE action='import.create' AND community_id=$1 AND actor_kind='api_key'",
      [created.import.communityId]
    )
  ).toBe(1);

  const replay = await expectStatus(
    await h.call('/api/v1/host/imports', { bearer: keyImport, body }),
    200,
    'replay'
  );
  const replayed = await replay.json();
  expect(replayed).toMatchObject({ replayed: true, uploadToken: null });
  expect(replayed.import.importId).toBe(created.import.importId);

  const changed = await h.call('/api/v1/host/imports', {
    bearer: keyImport,
    body: { ...body, name: 'Something else' },
  });
  expect(changed.status).toBe(409);
  expect((await changed.json()).code).toBe('IDEMPOTENCY_CONFLICT');

  // The host list shows the community as being imported, with no count or content.
  const list = await (await h.call('/api/v1/host/communities', { bearer: keyRead })).json();
  expect(list.communities).toContainEqual(
    expect.objectContaining({
      id: created.import.communityId,
      importId: created.import.importId,
      importState: 'awaiting_upload',
    })
  );
  expect(list.communities).toContainEqual(expect.objectContaining({ id: a, importState: null }));
});

// Purpose: import is its own scope. A key without it cannot start, upload to, or cancel an
// import, and a read key can only read one.
it('needs the import scope to change an import', async () => {
  const { importId } = await createImport(h, { bearer: keyImport });
  for (const key of [keyRead, keyWrite]) {
    const create = await h.call('/api/v1/host/imports', {
      bearer: key,
      body: { idempotencyKey: `scope-${key.slice(4, 10)}`, name: 'Nope' },
    });
    expect(create.status).toBe(403);
    expect(
      (await uploadArchive(h, importId, buildArchive(minimalManifest()), { bearer: key })).status
    ).toBe(403);
    expect(
      (await h.call(`/api/v1/host/imports/${importId}/cancel`, { bearer: key, body: {} })).status
    ).toBe(403);
  }
  expect((await readImport(h, importId, keyRead)).state).toBe('awaiting_upload');
  // A malformed or unknown id is the same 404.
  expect((await h.call('/api/v1/host/imports/not-a-uuid', { bearer: keyRead })).status).toBe(404);
  expect((await h.call(`/api/v1/host/imports/${randomUUID()}`, { bearer: keyRead })).status).toBe(
    404
  );
});

// Purpose: a broken upload (wrong digest, wrong length, not a zip, or a dropped connection)
// leaves nothing in storage and does not spend the token, so the same token still uploads
// the right file afterwards. Fails if a mismatch keeps bytes or burns the token.
it('refuses a broken upload without spending the token, then accepts the right file', async () => {
  const { importId, communityId, uploadToken } = await createImport(h, { bearer: keyImport });
  const archive = buildArchive(minimalManifest());

  const wrongDigest = await uploadArchive(h, importId, archive, {
    bearer: uploadToken,
    sha256: sha256('something else'),
  });
  expect(wrongDigest.status).toBe(400);
  expect((await wrongDigest.json()).code).toBe('IMPORT_ARCHIVE_INVALID');

  const notZip = Buffer.from('this is not an archive at all');
  const rejected = await uploadArchive(h, importId, notZip, { bearer: uploadToken });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).code).toBe('IMPORT_ARCHIVE_INVALID');

  await droppedUpload(h, importId, archive, uploadToken, Math.floor(archive.byteLength / 2));

  expect(await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [communityId])).toBe(0);
  expect((await readImport(h, importId, keyRead)).state).toBe('awaiting_upload');

  const accepted = await expectStatus(
    await uploadArchive(h, importId, archive, { bearer: uploadToken }),
    200,
    'upload'
  );
  const body = await accepted.json();
  expect(body).toMatchObject({ state: 'validating', archiveBytes: archive.byteLength });
  const staged = await h.pool.query<{ purpose: string; state: string; checksum: string }>(
    'SELECT purpose,state,checksum FROM managed_blobs WHERE community_id=$1',
    [communityId]
  );
  expect(staged.rows).toEqual([
    { purpose: 'import_staging', state: 'committed', checksum: sha256(archive) },
  ]);
  expect(
    await count(
      "SELECT 1 FROM host_audit_events WHERE action='import.upload' AND community_id=$1",
      [communityId]
    )
  ).toBe(1);
  const usage = await (
    await h.call(`/api/v1/host/communities/${communityId}/usage`, { bearer: keyRead })
  ).json();
  expect(usage.storage).toMatchObject({ importStagingBytes: archive.byteLength, countedBytes: 0 });

  // The token is spent: the same file again is a success (a retry whose answer was lost),
  // a different file is a conflict, and nothing new is stored either way.
  expect((await uploadArchive(h, importId, archive, { bearer: uploadToken })).status).toBe(200);
  const other = buildArchive({ ...minimalManifest(), requesterMemberId: randomUUID() });
  const conflict = await uploadArchive(h, importId, other, { bearer: uploadToken });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  expect(await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [communityId])).toBe(1);
});

// Purpose: the upload token belongs to one import. A made-up token, another import's token,
// or a member's credential is refused, and the token opens no host or content route.
it('accepts the upload token only for its own import upload', async () => {
  const first = await createImport(h, { bearer: keyImport });
  const second = await createImport(h, { bearer: keyImport });
  const archive = buildArchive(minimalManifest());
  expect(
    (await uploadArchive(h, first.importId, archive, { bearer: second.uploadToken })).status
  ).toBe(401);
  expect((await uploadArchive(h, first.importId, archive, { bearer: 'x'.repeat(43) })).status).toBe(
    401
  );
  expect((await h.call('/api/v1/host/communities', { bearer: first.uploadToken })).status).toBe(
    401
  );
  expect(
    (await h.call(`/api/v1/host/imports/${first.importId}`, { bearer: first.uploadToken })).status
  ).toBe(401);
  expect(
    (await h.call(`/api/v1/communities/${a}/channels`, { bearer: first.uploadToken })).status
  ).toBe(401);
  // A host operator's session and an import key may upload instead of the token.
  expect((await uploadArchive(h, first.importId, archive, { cookie: operatorCookie })).status).toBe(
    200
  );
  expect((await uploadArchive(h, second.importId, archive, { bearer: keyImport })).status).toBe(
    200
  );
});

// Purpose: an export over the size limit is refused from its declared length, before the
// server reads the body, and a missing digest is refused the same way.
it('refuses an oversized or undeclared upload before reading it', async () => {
  const { importId, uploadToken } = await createImport(h, { bearer: keyImport });
  // Declared past the limit and sent with no body: the answer comes from the headers alone.
  const response = await rawStatus(importId, uploadToken, 1024 * 1024 * 1024 + 1);
  expect(response).toMatch(/^HTTP\/1\.1 413 /);
  expect(response).toContain('IMPORT_TOO_LARGE');
  const noDigest = await h.call(`/api/v1/imports/${importId}/archive`, {
    method: 'PUT',
    bearer: uploadToken,
    raw: new Uint8Array(buildArchive(minimalManifest())),
  });
  expect(noDigest.status).toBe(400);
  expect((await readImport(h, importId, keyRead)).state).toBe('awaiting_upload');
});

async function rawStatus(importId: string, token: string, length: number): Promise<string> {
  const { port } = new URL(h.baseUrl);
  const socket = connect(Number(port), '127.0.0.1');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      `PUT /api/v1/imports/${importId}/archive HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      `Content-Length: ${length}`,
      `X-Archive-SHA256: ${sha256('x')}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')
  );
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return Buffer.concat(chunks).toString('utf8');
}

// Purpose: an owner claim cannot be issued for a community whose import is not ready, and
// the ordinary abandon route cannot remove it behind the import's back.
it('refuses an owner claim and an abandon while an import is unfinished', async () => {
  const { communityId } = await createImport(h, { bearer: keyImport });
  const reissue = await h.call(`/api/v1/host/communities/${communityId}/owner-claims/reissue`, {
    bearer: keyWrite,
    body: {},
  });
  expect(reissue.status).toBe(409);
  expect(await count('SELECT 1 FROM bootstrap_grants WHERE community_id=$1', [communityId])).toBe(
    0
  );
  const abandon = await h.call(`/api/v1/host/communities/${communityId}`, {
    method: 'DELETE',
    bearer: keyWrite,
  });
  expect(abandon.status).toBe(409);
});

// Purpose: cancelling removes the unclaimed community and every file of the import, and the
// import row stays to say how it ended. Fails if a cancel leaves a blob or the community.
it('cancels an import and removes its community and every file', async () => {
  const waiting = await createImport(h, { bearer: keyImport });
  const uploaded = await createImport(h, { bearer: keyImport });
  await expectStatus(
    await uploadArchive(h, uploaded.importId, buildArchive(minimalManifest()), {
      bearer: uploaded.uploadToken,
    }),
    200,
    'upload'
  );
  for (const target of [waiting, uploaded]) {
    const cancelled = await expectStatus(
      await h.call(`/api/v1/host/imports/${target.importId}/cancel`, {
        bearer: keyImport,
        body: {},
      }),
      200,
      'cancel'
    );
    expect((await cancelled.json()).state).toBe('cancelled');
  }
  await settleImports();
  for (const target of [waiting, uploaded]) {
    expect(await count('SELECT 1 FROM communities WHERE id=$1', [target.communityId])).toBe(0);
    expect(
      await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [target.communityId])
    ).toBe(0);
    const read = await readImport(h, target.importId, keyRead);
    expect(read).toMatchObject({ state: 'cancelled', communityId: null });
    expect(
      await count(
        "SELECT 1 FROM host_audit_events WHERE action='import.cancel' AND community_id=$1",
        [target.communityId]
      )
    ).toBe(1);
  }
  // The upload token of a cancelled import no longer uploads.
  const late = await uploadArchive(h, waiting.importId, buildArchive(minimalManifest()), {
    bearer: waiting.uploadToken,
  });
  expect(late.status).toBe(409);
});

// Purpose: an upload window that closes before a matching file arrives ends the import the
// same way a cancel does, and the token then answers 401 as the published contract says.
it('cancels an import whose upload window closed', async () => {
  const { importId, communityId, uploadToken } = await createImport(h, { bearer: keyImport });
  clock = new Date(Date.now() + 25 * 60 * 60_000);
  try {
    const late = await uploadArchive(h, importId, buildArchive(minimalManifest()), {
      bearer: uploadToken,
    });
    expect(late.status).toBe(401);
    await settleImports();
    expect(await count('SELECT 1 FROM communities WHERE id=$1', [communityId])).toBe(0);
    expect((await readImport(h, importId, keyRead)).state).toBe('cancelled');
    expect(
      await count(
        "SELECT 1 FROM host_audit_events WHERE action='import.cancel' AND actor_kind='system' AND community_id=$1",
        [communityId]
      )
    ).toBe(1);
  } finally {
    clock = new Date();
  }
});

// Purpose: an upload token is a one-time secret. It never appears in a host read, a list,
// the database, or any line the server logged during this whole file.
it('never shows or logs an upload token', async () => {
  const response = await h.call('/api/v1/host/imports', {
    bearer: keyImport,
    body: { idempotencyKey: 'secret-check', name: 'Secret' },
  });
  const { uploadToken, import: created } = await response.json();
  const reads = [
    await (await h.call(`/api/v1/host/imports/${created.importId}`, { bearer: keyRead })).text(),
    await (await h.call('/api/v1/host/communities', { bearer: keyRead })).text(),
  ];
  for (const text of reads) expect(text).not.toContain(uploadToken);
  const stored = await h.pool.query('SELECT row_to_json(i)::text AS row FROM community_imports i');
  for (const row of stored.rows) expect(row.row).not.toContain(uploadToken);
  expect(logged.join('\n')).not.toContain(uploadToken);
});
