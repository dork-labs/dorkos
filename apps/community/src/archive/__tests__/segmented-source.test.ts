import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileSystemBlobStore, type BlobStore } from '../../storage/index.js';
import { SegmentedBlobSource, type ArchiveBlob } from '../segmented-source.js';
import { chunksOf, collectBytes } from '../streams.js';
import { writeZipSegment, writeZipTail } from '../zip64-writer.js';
import { FIXED_TIME, readWithOurReader, readWithYauzl } from './archive-test-helpers.js';

let directory: string;
let store: FileSystemBlobStore;
const parts = [Buffer.from('abcdefghij'), Buffer.from('K'), Buffer.from('lmnopqrstuvwxyz0123')];
const whole = Buffer.concat(parts);
let blobs: ArchiveBlob[];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'segmented-source-'));
  store = new FileSystemBlobStore(directory);
  blobs = [];
  for (const part of parts) {
    const stored = await store.put({
      source: chunksOf(part),
      displayName: 'part.txt',
      maxBytes: 1024,
    });
    blobs.push({ key: stored.key, byteSize: stored.byteSize });
  }
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SegmentedBlobSource', () => {
  // Purpose: a logical range maps onto the right slice of each blob it touches, including single
  // bytes on either side of every boundary.
  it('reads any range across blob boundaries', async () => {
    const source = new SegmentedBlobSource(store, blobs);
    expect(source.size).toBe(whole.length);
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: whole.length - 1 }),
        fc.nat({ max: whole.length - 1 }),
        async (a, b) => {
          const [start, end] = a <= b ? [a, b] : [b, a];
          expect(await collectBytes(source.read(start, end))).toEqual(
            whole.subarray(start, end + 1)
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  // Purpose: one ranged get per blob touched, never a whole-blob read.
  it('asks each touched blob for exactly its slice', async () => {
    const get = vi.fn(store.get.bind(store));
    const spy: BlobStore = {
      get,
      put: store.put.bind(store),
      delete: store.delete.bind(store),
      listNamespace: store.listNamespace.bind(store),
    };
    const source = new SegmentedBlobSource(spy, blobs);
    await collectBytes(source.read(8, 12));
    expect(get.mock.calls.map(([key, options]) => [key, options?.range])).toEqual([
      [blobs[0].key, { start: 8, end: 9 }],
      [blobs[1].key, { start: 0, end: 0 }],
      [blobs[2].key, { start: 0, end: 1 }],
    ]);
  });

  // Purpose: ranges outside the archive, and a blob that is not the size it was recorded with,
  // fail instead of returning the wrong bytes.
  it('refuses bad ranges and a blob of the wrong size', async () => {
    const source = new SegmentedBlobSource(store, blobs);
    for (const [start, end] of [
      [-1, 3],
      [3, 2],
      [0, whole.length],
      [0.5, 3],
    ]) {
      await expect(collectBytes(source.read(start, end))).rejects.toMatchObject({
        code: 'BLOB_RANGE_NOT_SATISFIABLE',
      });
    }
    const lying = new SegmentedBlobSource(store, [{ ...blobs[0], byteSize: 12 }, blobs[1]]);
    await expect(collectBytes(lying.read(0, 12))).rejects.toMatchObject({
      code: 'BLOB_RANGE_NOT_SATISFIABLE',
    });
    // A store that ignores the range hands back too many bytes; the source notices.
    const ignoresRange: BlobStore = {
      get: (key, options) => store.get(key, { signal: options?.signal }),
      put: store.put.bind(store),
      delete: store.delete.bind(store),
      listNamespace: store.listNamespace.bind(store),
    };
    let handedOut = 0;
    await expect(
      (async () => {
        for await (const chunk of new SegmentedBlobSource(ignoresRange, blobs).read(0, 4)) {
          handedOut += chunk.length;
        }
      })()
    ).rejects.toMatchObject({ code: 'BLOB_RANGE_NOT_SATISFIABLE' });
    expect(handedOut).toBeLessThanOrEqual(5);
    expect(() => new SegmentedBlobSource(store, [{ ...blobs[0], byteSize: 0 }])).toThrow(
      RangeError
    );
  });

  // Purpose: three segments and a tail, each stored as its own export_segment blob, read back as
  // one archive through the source by yauzl and by our reader.
  it('serves a stored segmented archive to both readers', async () => {
    const archiveBlobs: ArchiveBlob[] = [];
    const layouts = [];
    for (let index = 1; index <= 3; index++) {
      const writer = writeZipSegment(
        [
          {
            name: `entries/00000${index}.ndjson`,
            method: 'deflated',
            source: Buffer.from(`{"i":${index}}\n`),
          },
          {
            name: `files/f${index}/x`,
            method: 'stored',
            source: Buffer.alloc(index * 1000, index),
            size: index * 1000,
          },
        ],
        { modifiedAt: FIXED_TIME }
      );
      const stored = await store.put({
        source: writer.bytes,
        displayName: 'segment.zip',
        kind: 'export_segment',
        maxBytes: 1024 * 1024,
      });
      archiveBlobs.push({ key: stored.key, byteSize: stored.byteSize });
      layouts.push(writer.summary());
    }
    const tail = writeZipTail(
      {
        segments: layouts,
        entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }],
      },
      { modifiedAt: FIXED_TIME }
    );
    for await (const part of tail.parts(200)) {
      const stored = await store.put({
        source: part,
        displayName: 'tail.zip',
        kind: 'export_segment',
        maxBytes: 1024 * 1024,
      });
      archiveBlobs.push({ key: stored.key, byteSize: stored.byteSize });
    }
    expect(archiveBlobs.length).toBeGreaterThan(4);
    const source = new SegmentedBlobSource(store, archiveBlobs);
    const yauzlRead = await readWithYauzl(source);
    const ours = await readWithOurReader(source);
    expect(ours.contents).toEqual(yauzlRead.contents);
    expect(yauzlRead.contents.get('files/f3/x')).toEqual(Buffer.alloc(3000, 3));
    expect(yauzlRead.contents.get('manifest.json')?.toString()).toBe('{}');
  });
});
