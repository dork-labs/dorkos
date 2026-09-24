import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { strFromU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import { runHostKeyCommand } from '../host-keys.js';
import type { HostApiKeyScope } from '../host/authority.js';
import { expectStatus, type TenancyHarness } from './tenancy-test-harness.js';

/** SHA-256 of some bytes, as lowercase hex. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Issue a host API key with the given scopes through the offline command. */
export async function issueKey(h: TenancyHarness, scopes: HostApiKeyScope[]): Promise<string> {
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: scopes.join(' '),
    scopes,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return issued.secret;
}

/**
 * Write a version 1 export archive exactly as the version 1 exporter does: `manifest.json`
 * first, then each file under its archive path, every entry stored without compression
 * unless `deflate` compresses the files.
 * `entries` overrides the default layout, for archives that break the rules on purpose.
 */
export function buildArchive(
  manifest: unknown,
  files: ReadonlyMap<string, Uint8Array> = new Map(),
  entries?: readonly [string, Uint8Array][],
  options: { deflate?: boolean } = {}
): Buffer {
  const layout: [string, Uint8Array][] = entries
    ? [...entries]
    : [
        ['manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8')],
        ...[...files].map(([id, bytes]): [string, Uint8Array] => [`attachments/${id}`, bytes]),
      ];
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of layout) {
    const file =
      options.deflate && name !== 'manifest.json' ? new ZipDeflate(name) : new ZipPassThrough(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

/** Read an archive's manifest and files, as a test inspects a real export. */
export function readArchive(archive: Uint8Array): {
  manifest: CommunityExportManifestV1;
  files: Map<string, Uint8Array>;
} {
  const entries = unzipSync(archive);
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('attachments/')) files.set(name.slice('attachments/'.length), bytes);
  }
  return { manifest: JSON.parse(strFromU8(entries['manifest.json'])), files };
}

/** A minimal owner export: one owner, nothing else. */
export function minimalManifest(): CommunityExportManifestV1 {
  const owner = '00000000-0000-4000-8000-000000000001';
  return {
    version: 1,
    scope: 'owner',
    requesterMemberId: owner,
    community: {
      id: '00000000-0000-4000-8000-0000000000c0',
      lifecycle: 'active',
      lifecycleVersion: 2,
      settingsVersion: 1,
    },
    auditEvents: [],
    channels: [],
    members: [
      {
        id: owner,
        display_name: 'Ada Owner',
        handle: 'ada',
        role: 'owner',
        active: true,
        created_at: '2026-01-02T03:04:05.000Z',
        removed_at: null,
        email: 'ada@example.test',
      },
    ],
    agents: [],
    entries: [],
    attachments: [],
  };
}

/** Create an import as `auth` and return its id, community, and one-time upload token. */
export async function createImport(
  h: TenancyHarness,
  auth: { bearer?: string; cookie?: string },
  body: Record<string, unknown> = {}
): Promise<{ importId: string; communityId: string; uploadToken: string }> {
  const response = await expectStatus(
    await h.call('/api/v1/host/imports', {
      ...auth,
      body: { idempotencyKey: `import-${randomUUID()}`, name: 'Moved in', ...body },
    }),
    201,
    'create import'
  );
  const created = await response.json();
  return {
    importId: created.import.importId,
    communityId: created.import.communityId,
    uploadToken: created.uploadToken,
  };
}

/** Upload an archive with the given credential and declared digest. */
export function uploadArchive(
  h: TenancyHarness,
  importId: string,
  archive: Uint8Array,
  options: { bearer?: string; cookie?: string; sha256?: string } = {}
): Promise<Response> {
  return h.call(`/api/v1/imports/${importId}/archive`, {
    method: 'PUT',
    bearer: options.bearer,
    cookie: options.cookie,
    headers: {
      'content-type': 'application/zip',
      'x-archive-sha256': options.sha256 ?? sha256(archive),
    },
    raw: new Uint8Array(archive),
  });
}

/**
 * Send an upload's headers and only the first `sentBytes` of its body, then drop the
 * connection, as a person whose network fails part-way does.
 */
export async function droppedUpload(
  h: TenancyHarness,
  importId: string,
  archive: Uint8Array,
  token: string,
  sentBytes: number
): Promise<void> {
  const { port } = new URL(h.baseUrl);
  const socket = connect(Number(port), '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    [
      `PUT /api/v1/imports/${importId}/archive HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      'Content-Type: application/zip',
      `Content-Length: ${archive.byteLength}`,
      `X-Archive-SHA256: ${sha256(archive)}`,
      '',
      '',
    ].join('\r\n')
  );
  socket.write(archive.subarray(0, sentBytes));
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Read one import as the host sees it. */
export async function readImport(h: TenancyHarness, importId: string, bearer: string) {
  const response = await expectStatus(
    await h.call(`/api/v1/host/imports/${importId}`, { bearer }),
    200,
    'read import'
  );
  return response.json();
}

/** Make a real owner export of a community and download its archive. */
export async function ownerExport(
  h: TenancyHarness,
  communityId: string,
  ownerCookie: string,
  password: string
): Promise<Buffer> {
  const base = `/api/v1/communities/${communityId}`;
  const exported = await expectStatus(
    await h.call(`${base}/owner/export`, { cookie: ownerCookie, body: { password } }),
    201,
    'owner export'
  );
  const { archiveId } = await exported.json();
  const download = await expectStatus(
    await h.call(`${base}/exports/${archiveId}`, { cookie: ownerCookie }),
    200,
    'download export'
  );
  return Buffer.from(await download.arrayBuffer());
}

/**
 * Send an upload over a raw connection in `pieces` parts, `delayMs` apart, and return the raw
 * HTTP response. `holdOpen` stops after the first part and leaves the connection open (the
 * returned `close` ends it), to keep an upload in flight while a test does something else.
 */
export async function slowUpload(
  h: TenancyHarness,
  importId: string,
  archive: Uint8Array,
  token: string,
  options: { pieces: number; delayMs: number; holdOpen?: boolean }
): Promise<{ response: Promise<string>; close: () => void }> {
  const { port } = new URL(h.baseUrl);
  const socket = connect(Number(port), '127.0.0.1');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => undefined);
  const closed = new Promise<string>((resolve) =>
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
  );
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      `PUT /api/v1/imports/${importId}/archive HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      'Content-Type: application/zip',
      `Content-Length: ${archive.byteLength}`,
      `X-Archive-SHA256: ${sha256(archive)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')
  );
  const size = Math.ceil(archive.byteLength / options.pieces);
  const send = async () => {
    for (let at = 0; at < archive.byteLength; at += size) {
      socket.write(archive.subarray(at, at + size));
      if (options.holdOpen) return;
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  };
  await send();
  return { response: closed, close: () => socket.destroy() };
}
