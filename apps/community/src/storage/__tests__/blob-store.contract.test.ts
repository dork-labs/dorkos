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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  });
}

contract('filesystem blob store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'community-blobs-'));
  return {
    store: new FileSystemBlobStore(directory),
    reopen: () => new FileSystemBlobStore(directory),
    clean: async () => {
      expect(await readdir(directory)).toEqual([]);
      await rm(directory, { recursive: true, force: true });
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
