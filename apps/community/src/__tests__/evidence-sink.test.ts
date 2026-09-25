/**
 * The write-only evidence sinks (specs/community-host-takedown, AC-4, AC-5, AC-14) and the
 * evidence record builder.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommunityEvidenceRecordV1Schema } from '@dorkos/shared/community-admin-wire';
import { COMMUNITY_TAKEDOWN_CATEGORY_SENTENCES } from '@dorkos/shared/community-wire';
import {
  buildEvidenceRecord,
  COMMUNITY_SERVER_VERSION,
  EVIDENCE_IP_NOTE,
  serializeEvidenceRecord,
} from '../takedown/evidence/record.js';
import {
  evidenceAttemptFolder,
  EvidenceSinkError,
  FileSystemEvidenceSink,
  S3EvidenceSink,
  sweepEvidenceStagingFolders,
} from '../takedown/evidence/sink.js';

const id = '0f8c6a44-7a3e-4f3b-9c55-0d2c1b6f8a11';
const bytes = Buffer.from('evidence bytes');
const expected = {
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteSize: bytes.length,
};
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evidence-sink-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof EvidenceSinkError ? error.code : String(error);
  }
}

describe('the filesystem evidence sink', () => {
  // Purpose: fails if the sink replaces a file (a rename would), keeps a temporary file, or
  // accepts bytes that do not match what primary storage recorded.
  it('writes once, refuses to overwrite, and refuses bytes that do not match', async () => {
    const sink = new FileSystemEvidenceSink(root);
    const path = `${evidenceAttemptFolder(id, 1)}record.json`;
    expect(path).toBe(`takedowns/${id}/attempt-1/record.json`);
    await sink.put(path, [bytes], expected);
    const target = join(root, 'takedowns', id, 'attempt-1', 'record.json');
    expect(await readFile(target)).toEqual(bytes);
    expect(
      await codeOf(sink.put(path, [Buffer.from('other')], { sha256: 'a'.repeat(64), byteSize: 5 }))
    ).toBe('EVIDENCE_CHECKSUM_MISMATCH');
    const other = Buffer.from('other bytes!!!');
    expect(
      await codeOf(
        sink.put(path, [other], {
          sha256: createHash('sha256').update(other).digest('hex'),
          byteSize: other.length,
        })
      )
    ).toBe('EVIDENCE_EXISTS');
    expect(await readFile(target)).toEqual(bytes);
    const tooLong = Buffer.concat([bytes, Buffer.from('!')]);
    expect(
      await codeOf(sink.put(`${evidenceAttemptFolder(id, 2)}record.json`, [tooLong], expected))
    ).toBe('EVIDENCE_CHECKSUM_MISMATCH');
    expect(await readdir(join(root, 'takedowns', id, 'attempt-2'))).toEqual([]);
    expect(await readdir(join(root, 'takedowns', id, 'attempt-1'))).toEqual(['record.json']);
  });

  // Purpose: fails if a path the server did not build could reach the store.
  it('accepts only the paths the server builds', async () => {
    const sink = new FileSystemEvidenceSink(root);
    for (const path of [
      '../escape',
      `takedowns/${id}/attempt-1/../../x`,
      `takedowns/${id}/attempt-0/record.json`,
      `takedowns/${id}/attempt-1/files/not-an-id`,
      `takedowns/NOT-${id}/attempt-1/record.json`,
      `/takedowns/${id}/attempt-1/record.json`,
    ])
      expect(await codeOf(sink.put(path, [bytes], expected)), path).toBe('EVIDENCE_INVALID_PATH');
    await sink.put(`takedowns/${id}/attempt-1/files/${id}`, [bytes], expected);
    await sink.put(`takedowns/${id}/attempt-1/icon`, [bytes], expected);
  });

  // Purpose (AC-14): fails if the startup sweep deletes anything but its own old temporary files.
  it('sweeps only its own temporary files older than an hour', async () => {
    const sink = new FileSystemEvidenceSink(root);
    const folder = join(root, 'takedowns', id, 'attempt-1');
    await mkdir(folder, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const files = {
      staleTemp: `.tmp-${'a'.repeat(32)}`,
      freshTemp: `.tmp-${'b'.repeat(32)}`,
      oldRecord: 'record.json',
      lookalike: '.tmp-not-ours',
    };
    for (const name of Object.values(files)) await writeFile(join(folder, name), 'x');
    for (const name of [files.staleTemp, files.oldRecord, files.lookalike])
      await utimes(join(folder, name), old, old);
    expect(await sink.sweepTemporaryFiles()).toBe(1);
    expect((await readdir(folder)).sort()).toEqual(
      [files.freshTemp, files.lookalike, files.oldRecord].sort()
    );
  });
});

describe('the S3 evidence sink', () => {
  function stub(fail?: Error) {
    const calls: { name: string; input: Record<string, unknown>; body: Buffer }[] = [];
    return {
      calls,
      client: {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of command.input.Body as AsyncIterable<Buffer>) chunks.push(chunk);
          calls.push({
            name: command.constructor.name,
            input: command.input,
            body: Buffer.concat(chunks),
          });
          if (fail) throw fail;
          return {};
        },
      },
    };
  }

  async function stagingFolders() {
    return (await readdir(tmpdir())).filter((name) => name.startsWith('community-evidence-'));
  }

  // Purpose (AC-5): fails if the sink sends anything but a conditional, checksummed PutObject,
  // or leaves its local staging copy behind.
  it('sends one conditional PutObject with the checksum, under the prefix, and cleans up', async () => {
    const { calls, client } = stub();
    const before = await stagingFolders();
    const sink = new S3EvidenceSink({
      bucket: 'evidence',
      region: 'auto',
      prefix: 'host-a/',
      client: client as never,
    });
    await sink.put(`takedowns/${id}/attempt-1/record.json`, [bytes], expected);
    expect(calls).toEqual([
      {
        name: 'PutObjectCommand',
        input: expect.objectContaining({
          Bucket: 'evidence',
          Key: `host-a/takedowns/${id}/attempt-1/record.json`,
          ContentLength: bytes.length,
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          IfNoneMatch: '*',
        }),
        body: bytes,
      },
    ]);
    expect((await stagingFolders()).filter((name) => !before.includes(name))).toEqual([]);
  });

  // Purpose: fails if an existing object is reported as anything but a refusal to overwrite.
  it('reports a refused overwrite as EVIDENCE_EXISTS', async () => {
    const failure = Object.assign(new Error('precondition'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
    const { client } = stub(failure);
    const before = await stagingFolders();
    const sink = new S3EvidenceSink({
      bucket: 'evidence',
      region: 'auto',
      client: client as never,
    });
    expect(await codeOf(sink.put(`takedowns/${id}/attempt-1/record.json`, [bytes], expected))).toBe(
      'EVIDENCE_EXISTS'
    );
    expect((await stagingFolders()).filter((name) => !before.includes(name))).toEqual([]);
  });
});

// Purpose: fails if a staging folder a crashed S3 write left behind stays in the temporary folder
// for good, or if the sweep touches anything that is not its own old staging folder.
it('sweeps only the S3 sink’s own staging folders older than an hour', async () => {
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  const names = {
    stale: 'community-evidence-Ab12Cd',
    fresh: 'community-evidence-Ef34Gh',
    other: 'community-s3-Ij56Kl',
    lookalike: 'community-evidence-too-long',
  };
  for (const name of Object.values(names)) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'object'), 'x');
  }
  for (const name of [names.stale, names.other, names.lookalike])
    await utimes(join(root, name), old, old);
  expect(await sweepEvidenceStagingFolders(Date.now(), root)).toBe(1);
  expect((await readdir(root)).sort()).toEqual([names.fresh, names.lookalike, names.other].sort());
});

describe('the evidence record', () => {
  const content = {
    community: { id, name: 'Acme', lifecycle: 'active' as const },
    channel: { id, name: 'general' },
    entry: null,
    author: null,
    account: null,
    files: [],
    icon: null,
  };
  const takedown = {
    id,
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    actor: { kind: 'api_key' as const, keyId: id, scopes: ['communities:takedown' as const] },
    category: 'legal_order' as const,
    reference: 'CASE-1',
    notify: true,
  };

  // Purpose: fails if the record gains or loses a field, or the actor's key scopes leak into it.
  it('holds exactly the documented fields', () => {
    const record = buildEvidenceRecord({ takedown, publicUrl: 'https://c.example', content });
    expect(Object.keys(record).sort()).toEqual(
      [
        'version',
        'takedown',
        'server',
        'community',
        'channel',
        'entry',
        'author',
        'account',
        'files',
        'icon',
        'notes',
      ].sort()
    );
    expect(record.takedown.actor).toEqual({ kind: 'api_key', id, name: null });
    expect(record.server).toEqual({
      publicUrl: 'https://c.example',
      version: COMMUNITY_SERVER_VERSION,
    });
    expect(record.notes).toEqual([EVIDENCE_IP_NOTE]);
    expect(() =>
      buildEvidenceRecord({
        takedown,
        publicUrl: 'https://c.example',
        content: { ...content, extra: 'x' } as typeof content,
      })
    ).toThrow();
    const serialized = serializeEvidenceRecord(record);
    expect(CommunityEvidenceRecordV1Schema.parse(JSON.parse(serialized.toString()))).toEqual(
      record
    );
    expect(serialized.toString().endsWith('\n')).toBe(true);
  });

  it('says each reason in one plain sentence', () => {
    expect(COMMUNITY_TAKEDOWN_CATEGORY_SENTENCES).toEqual({
      child_safety: 'It was removed to protect children.',
      illegal_content: 'It was reported to the host as illegal.',
      legal_order: 'The host received a legal order to remove it.',
      terms_violation: "It broke the host's terms.",
    });
  });
});

it('names the attempt folder from the takedown and attempt number', () => {
  expect(evidenceAttemptFolder(randomUUID(), 7)).toMatch(/^takedowns\/[0-9a-f-]{36}\/attempt-7\/$/);
});
