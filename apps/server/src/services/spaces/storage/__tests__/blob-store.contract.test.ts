import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileSystemBlobStore, S3BlobStore, downloadHeaders, type BlobStore } from '../index.js';

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4096, 1)]);

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function contract(
  name: string,
  create: () => Promise<{ store: BlobStore; reopen: () => BlobStore; clean: () => Promise<void> }>
) {
  describe(name, () => {
    let fixture: Awaited<ReturnType<typeof create>>;
    beforeAll(async () => {
      fixture = await create();
    });
    afterAll(async () => fixture?.clean());

    it('streams, persists, and deletes an opaque-key object across store restart', async () => {
      const stored = await fixture.store.put({
        source: Readable.from([png.subarray(0, 11), png.subarray(11)]),
        displayName: '../../photo\r\n.png',
        maxBytes: png.length,
      });
      expect(stored.key).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.key).not.toContain('photo');
      expect(stored.displayName).not.toMatch(/[\\/\r\n]/);
      expect(stored.contentType).toBe('image/png');
      expect(stored.byteSize).toBe(png.length);
      expect(stored.sha256).toBe(createHash('sha256').update(png).digest('hex'));
      expect(await readAll((await fixture.reopen().get(stored.key)).body)).toEqual(png);
      await fixture.store.delete(stored.key);
      await expect(fixture.store.get(stored.key)).rejects.toThrow();
    });

    it('publishes bytes under an already reserved opaque key', async () => {
      const key = 'd'.repeat(64);
      const stored = await fixture.store.put({
        key,
        source: Readable.from([png]),
        displayName: 'reserved.png',
        maxBytes: png.length,
      });
      expect(stored.key).toBe(key);
      expect(await readAll((await fixture.reopen().get(key)).body)).toEqual(png);
      expect(await fixture.store.listNamespace()).toEqual({
        keys: [key],
        temporaryKeys: [],
        unexpectedEntries: 0,
      });
      await fixture.store.delete(key);
    });

    it('rejects an over-limit stream, active content, and invalid keys without persisting them', async () => {
      await expect(
        fixture.store.put({ source: Readable.from([png]), displayName: 'big.png', maxBytes: 10 })
      ).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
      await expect(
        fixture.store.put({
          source: Readable.from([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')]),
          displayName: 'x.svg',
          maxBytes: 100,
        })
      ).rejects.toMatchObject({ code: 'BLOB_TYPE_REJECTED' });
      await expect(fixture.store.get('../escape')).rejects.toMatchObject({
        code: 'BLOB_INVALID_KEY',
      });
      await expect(fixture.store.delete('../escape')).rejects.toMatchObject({
        code: 'BLOB_INVALID_KEY',
      });
      await expect(fixture.store.get('0'.repeat(64))).rejects.toMatchObject({
        code: 'BLOB_NOT_FOUND',
      });
      await expect(fixture.store.delete('0'.repeat(64))).resolves.toBeUndefined();
    });

    it('cleans up a cancelled put and produces safe download headers', async () => {
      const abort = new AbortController();
      async function* chunks() {
        yield png.subarray(0, 11);
        abort.abort();
        yield png.subarray(11);
      }
      await expect(
        fixture.store.put({
          source: chunks(),
          displayName: 'x.png',
          maxBytes: png.length,
          signal: abort.signal,
        })
      ).rejects.toMatchObject({ code: 'BLOB_ABORTED' });
      const headers = downloadHeaders({ displayName: 'a\r\nb.svg', contentType: 'image/png' });
      expect(headers['content-disposition']).toContain('attachment;');
      expect(headers['content-disposition']).not.toMatch(/[\r\n]/);
      expect(headers['x-content-type-options']).toBe('nosniff');
    });

    it('cancels a put while its source is waiting for another chunk', async () => {
      const abort = new AbortController();
      async function* stalled() {
        yield png.subarray(0, 11);
        await new Promise<void>(() => {});
      }
      const pending = fixture.store.put({
        source: stalled(),
        displayName: 'stalled.png',
        maxBytes: png.length,
        signal: abort.signal,
      });
      setTimeout(() => abort.abort(), 10);
      await expect(pending).rejects.toMatchObject({ code: 'BLOB_ABORTED' });
    }, 1000);

    it('aborts a read and a delete without losing the committed object', async () => {
      const bytes = Buffer.concat([png, Buffer.alloc(256 * 1024, 1)]);
      const stored = await fixture.store.put({
        source: Readable.from([bytes]),
        displayName: 'large.png',
        maxBytes: bytes.length,
      });
      const readAbort = new AbortController();
      const first = await fixture.store.get(stored.key, { signal: readAbort.signal });
      const closed = new Promise<void>((resolve) => {
        first.body.once('error', () => {});
        first.body.once('close', resolve);
      });
      first.body.once('data', () => readAbort.abort());
      first.body.resume();
      await closed;
      expect(await readAll((await fixture.store.get(stored.key)).body)).toEqual(bytes);
      const deleteAbort = new AbortController();
      deleteAbort.abort();
      await expect(
        fixture.store.delete(stored.key, { signal: deleteAbort.signal })
      ).rejects.toMatchObject({ code: 'BLOB_ABORTED' });
      expect(await readAll((await fixture.store.get(stored.key)).body)).toEqual(bytes);
      await fixture.store.delete(stored.key);
    });

    it('accepts ZIP only for bounded generated exports', async () => {
      const archive = Buffer.from('504b030414000000', 'hex');
      await expect(
        fixture.store.put({ source: Readable.from([archive]), displayName: 'x.zip', maxBytes: 64 })
      ).rejects.toMatchObject({ code: 'BLOB_TYPE_REJECTED' });
      const stored = await fixture.store.put({
        source: Readable.from([archive]),
        displayName: 'export.zip',
        kind: 'export',
        maxBytes: 64,
      });
      expect(stored.contentType).toBe('application/zip');
      expect(await readAll((await fixture.store.get(stored.key)).body)).toEqual(archive);
      await fixture.store.delete(stored.key);
      await expect(
        fixture.store.put({
          source: Readable.from([archive]),
          displayName: 'x.zip',
          kind: 'export',
          maxBytes: 1024 * 1024 * 1024 + 1,
        })
      ).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
    });

    it('reads the first byte, the last byte, a middle slice, and the whole object by range', async () => {
      const bytes = Buffer.concat([
        png,
        Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251)),
      ]);
      const stored = await fixture.store.put({
        source: Readable.from([bytes]),
        displayName: 'ranged.png',
        maxBytes: bytes.length,
      });
      try {
        const last = bytes.length - 1;
        for (const [start, end] of [
          [0, 0],
          [last, last],
          [4097, 51_234],
          [0, last],
        ]) {
          const read = await fixture.reopen().get(stored.key, { range: { start, end } });
          expect(read.byteSize).toBe(end - start + 1);
          expect(await readAll(read.body)).toEqual(bytes.subarray(start, end + 1));
        }
        for (const range of [
          { start: 0, end: bytes.length },
          { start: bytes.length, end: bytes.length + 5 },
          { start: 5, end: 4 },
          { start: -1, end: 4 },
        ]) {
          await expect(fixture.store.get(stored.key, { range })).rejects.toMatchObject({
            code: 'BLOB_RANGE_NOT_SATISFIABLE',
          });
        }
        await expect(
          fixture.store.get('0'.repeat(64), { range: { start: 0, end: 0 } })
        ).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
      } finally {
        await fixture.store.delete(stored.key);
      }
    });

    it('accepts an export segment that starts any ZIP record a segment can start with', async () => {
      for (const signature of ['504b0304', '504b0102', '504b0606']) {
        const segment = Buffer.concat([Buffer.from(signature, 'hex'), Buffer.alloc(60, 7)]);
        const stored = await fixture.store.put({
          source: Readable.from([segment]),
          displayName: 'segment.zip',
          kind: 'export_segment',
          maxBytes: 1024,
        });
        expect(stored.contentType).toBe('application/zip');
        await fixture.store.delete(stored.key);
      }
      for (const body of [
        Buffer.from('504b050600000000', 'hex'),
        Buffer.from('plain text is not a segment'),
        png,
      ]) {
        await expect(
          fixture.store.put({
            source: Readable.from([body]),
            displayName: 'segment.zip',
            kind: 'export_segment',
            maxBytes: 8192,
          })
        ).rejects.toMatchObject({ code: 'BLOB_TYPE_REJECTED' });
      }
      await expect(
        fixture.store.put({
          source: Readable.from([Buffer.from('504b0304', 'hex')]),
          displayName: 'segment.zip',
          kind: 'export_segment',
          maxBytes: 1024 * 1024 * 1024 + 1,
        })
      ).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
    });

    it('refuses spoofed active and invalid UTF-8 content', async () => {
      for (const body of [
        Buffer.from('  <!doctype html><script>alert(1)</script>'),
        Buffer.from('89504e470d0a1a0a', 'hex').subarray(0, 5),
        Buffer.from([0xff, 0xfe, 0xfd]),
      ]) {
        await expect(
          fixture.store.put({
            source: Readable.from([body]),
            displayName: 'pretend.png',
            maxBytes: 1024,
          })
        ).rejects.toMatchObject({ code: 'BLOB_TYPE_REJECTED' });
      }
    });

    it('checks every text chunk for controls and a delayed active prefix', async () => {
      const invalid = [
        Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0])]),
        Buffer.concat([Buffer.alloc(4096, 0x20), Buffer.from('<script>alert(1)</script>')]),
      ];
      for (const body of invalid) {
        await expect(
          fixture.store.put({
            source: Readable.from([body.subarray(0, 4096), body.subarray(4096)]),
            displayName: 'spoofed.txt',
            maxBytes: body.length,
          })
        ).rejects.toMatchObject({ code: 'BLOB_TYPE_REJECTED' });
      }
    });

    it('turns a malformed Unicode name into safe round-trip download headers', async () => {
      for (const displayName of ['\ud800-é.png', `${'a'.repeat(179)}😀.png`]) {
        const stored = await fixture.store.put({
          source: Readable.from([png]),
          displayName,
          maxBytes: png.length,
        });
        try {
          const disposition = downloadHeaders(stored)['content-disposition'];
          expect(disposition).not.toMatch(/[\r\n]/);
          expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(
            stored.displayName
          );
        } finally {
          await fixture.store.delete(stored.key);
        }
      }
    });
  });
}

describe('S3 ranged reads', () => {
  function storeAnswering(answer: () => Promise<unknown>) {
    const store = new S3BlobStore({ bucket: 'test', region: 'us-east-1' });
    const send = vi.fn(answer);
    Object.defineProperty(store, 'client', { value: { send } });
    return { store, send };
  }

  it('sends an inclusive Range and reports the range length', async () => {
    const { store, send } = storeAnswering(async () => ({
      Body: Readable.from([Buffer.from('cdef')]),
      ContentRange: 'bytes 2-5/100',
      ContentLength: 4,
    }));
    const read = await store.get('a'.repeat(64), { range: { start: 2, end: 5 } });
    expect(read.byteSize).toBe(4);
    expect(await readAll(read.body)).toEqual(Buffer.from('cdef'));
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({
      input: { Bucket: 'test', Key: 'a'.repeat(64), Range: 'bytes=2-5' },
    });
  });

  it('refuses a shortened or missing Content-Range and destroys the body', async () => {
    for (const answer of [
      { ContentRange: 'bytes 2-3/4', ContentLength: 2 },
      { ContentRange: undefined, ContentLength: 100 },
      { ContentRange: 'bytes 2-5/100', ContentLength: 3 },
    ]) {
      const body = Readable.from([Buffer.from('cd')]);
      const { store } = storeAnswering(async () => ({ Body: body, ...answer }));
      await expect(
        store.get('a'.repeat(64), { range: { start: 2, end: 5 } })
      ).rejects.toMatchObject({ code: 'BLOB_RANGE_NOT_SATISFIABLE' });
      expect(body.destroyed).toBe(true);
    }
  });

  it('maps InvalidRange and refuses a malformed range before any request', async () => {
    const invalid = Object.assign(new Error('The requested range is not satisfiable'), {
      name: 'InvalidRange',
    });
    const { store, send } = storeAnswering(async () => {
      throw invalid;
    });
    await expect(
      store.get('a'.repeat(64), { range: { start: 100, end: 200 } })
    ).rejects.toMatchObject({ code: 'BLOB_RANGE_NOT_SATISFIABLE' });
    const statusOnly = Object.assign(new Error('Unknown'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 416 },
    });
    const byStatus = storeAnswering(async () => {
      throw statusOnly;
    });
    await expect(
      byStatus.store.get('a'.repeat(64), { range: { start: 100, end: 200 } })
    ).rejects.toMatchObject({ code: 'BLOB_RANGE_NOT_SATISFIABLE' });
    send.mockClear();
    await expect(store.get('a'.repeat(64), { range: { start: 3, end: 2 } })).rejects.toMatchObject({
      code: 'BLOB_RANGE_NOT_SATISFIABLE',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('S3 namespace pagination', () => {
  it('exhausts every page before returning one sorted snapshot', async () => {
    const store = new S3BlobStore({ bucket: 'test', region: 'us-east-1' });
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const send = vi.fn(async (command: ListObjectsV2Command) => {
      if (command.input.ContinuationToken === undefined) {
        return {
          IsTruncated: true,
          NextContinuationToken: 'page-2',
          Contents: [{ Key: second }],
        };
      }
      return { IsTruncated: false, Contents: [{ Key: first }] };
    });
    Object.defineProperty(store, 'client', { value: { send } });

    await expect(store.listNamespace()).resolves.toEqual({
      keys: [first, second],
      temporaryKeys: [],
      unexpectedEntries: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns no partial snapshot when a later page fails', async () => {
    const store = new S3BlobStore({ bucket: 'test', region: 'us-east-1' });
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextContinuationToken: 'page-2',
        Contents: [{ Key: 'a'.repeat(64) }],
      })
      .mockRejectedValueOnce(new Error('provider page failed'));
    Object.defineProperty(store, 'client', { value: { send } });

    await expect(store.listNamespace()).rejects.toMatchObject({ code: 'BLOB_LIST_INCOMPLETE' });
  });
});

contract('filesystem blob store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'community-blobs-'));
  return {
    store: new FileSystemBlobStore(directory),
    reopen: () => new FileSystemBlobStore(directory),
    clean: async () => {
      try {
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
});

const s3Endpoint = env.COMMUNITY_TEST_S3_ENDPOINT;
if (s3Endpoint) {
  contract('S3-compatible blob store', async () => {
    const bucket = `community-${randomBytes(10).toString('hex')}`;
    const options = {
      endpoint: s3Endpoint,
      region: 'us-east-1',
      bucket,
      accessKeyId: env.COMMUNITY_TEST_S3_ACCESS_KEY ?? 'community-test',
      secretAccessKey: env.COMMUNITY_TEST_S3_SECRET_KEY ?? 'community-test-secret',
    };
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return {
      store: new S3BlobStore(options),
      reopen: () => new S3BlobStore(options),
      clean: async () => {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        expect(objects.Contents ?? []).toEqual([]);
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      },
    };
  });
}
