import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { FileSystemBlobStore } from '../../storage/index.js';
import { SegmentedBlobSource, type ArchiveBlob } from '../segmented-source.js';
import { collectBytes } from '../streams.js';
import { openZipArchive, type ZipEntry } from '../zip-reader.js';
import { writeZipSegment, writeZipTail, type ZipEntryInput } from '../zip64-writer.js';
import {
  FIXED_TIME,
  readWithOurReader,
  readWithYauzl,
  recordSparse,
  sparseReader,
  type SparsePiece,
} from './archive-test-helpers.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The same buffer yielded `count` times: gigabytes of input for one buffer of memory. */
async function* repeated(buffer: Buffer, count: number) {
  for (let index = 0; index < count; index++) yield buffer;
}

describe('ZIP64 limits without storage', () => {
  // Purpose: AC-2's synthetic leg. More than 65,535 entries and entry offsets above 4 GiB, written
  // to a null sink (chunks recorded by reference, never stored), read back by yauzl and by our
  // reader with the right offsets. Fails if any 32-bit field overflows.
  it('writes 70,002 entries with offsets past 4 GiB that yauzl and our reader both resolve', async () => {
    const pieces: SparsePiece[] = [];
    const block = Buffer.alloc(MiB, 0x5a);
    const bigSize = 4 * GiB + 64 * MiB;

    const first = writeZipSegment(
      [
        {
          name: 'files/big/blob',
          method: 'stored',
          source: repeated(block, bigSize / MiB),
          size: bigSize,
        },
      ],
      { modifiedAt: FIXED_TIME }
    );
    let offset = await recordSparse(first.bytes, pieces, 0);
    const firstLayout = first.summary();
    expect(firstLayout.byteSize).toBeGreaterThan(2 ** 32);
    expect(pieces.length).toBeLessThan(5000); // recorded by reference, not copied

    const smallCount = 70_000;
    const small = (index: number): ZipEntryInput => ({
      name: `files/n${index}/f`,
      method: 'stored',
      source: Buffer.from([index % 251]),
      size: 1,
    });
    const second = writeZipSegment(
      (function* () {
        for (let index = 0; index < smallCount; index++) yield small(index);
      })(),
      { modifiedAt: FIXED_TIME }
    );
    offset = await recordSparse(second.bytes, pieces, offset);
    const secondLayout = second.summary();

    const tail = writeZipTail(
      {
        segments: [firstLayout, secondLayout],
        entries: [
          { name: 'manifest.json', method: 'deflated', source: Buffer.from('{"version":2}') },
        ],
      },
      { modifiedAt: FIXED_TIME }
    );
    const size = await recordSparse(tail.bytes, pieces, offset);
    const summary = tail.summary();
    expect(summary.entryCount).toBe(smallCount + 2);
    expect(summary.centralDirectoryOffset).toBeGreaterThan(2 ** 32);

    // The classic end record holds sentinels; the ZIP64 end record holds the truth.
    const reader = sparseReader(pieces, size);
    const end = await collectBytes(reader.read(size - 22, size - 1));
    expect(end.readUInt16LE(10)).toBe(0xffff);
    expect(end.readUInt32LE(16)).toBe(0xffffffff);

    const expectedOffset = (index: number) =>
      firstLayout.byteSize + secondLayout.entries[index].offset;
    const sampled = new Set(['files/n0/f', 'files/n65535/f', 'files/n69999/f', 'manifest.json']);

    const yauzlRead = await readWithYauzl(reader, (name) => sampled.has(name));
    expect(yauzlRead.entries).toHaveLength(smallCount + 2);
    expect(yauzlRead.entries[0]).toMatchObject({
      name: 'files/big/blob',
      offset: 0,
      uncompressedSize: bigSize,
    });
    for (const index of [0, 65_535, 69_999]) {
      expect(yauzlRead.entries[index + 1]).toMatchObject({
        name: `files/n${index}/f`,
        offset: expectedOffset(index),
      });
      expect(yauzlRead.contents.get(`files/n${index}/f`)).toEqual(Buffer.from([index % 251]));
    }
    expect(expectedOffset(0)).toBeGreaterThan(2 ** 32);
    expect(yauzlRead.contents.get('manifest.json')?.toString()).toBe('{"version":2}');

    const ours = await readWithOurReader(reader, (name) => sampled.has(name));
    expect(ours.entries.map((entry) => entry.offset)).toEqual(
      yauzlRead.entries.map((entry) => entry.offset)
    );
    expect(ours.contents).toEqual(yauzlRead.contents);
  }, 120_000);
});

const big = env.COMMUNITY_EXPORT_BIG_TEST === '1';
if (!big) console.warn('[zip64-large] skipping the 5 GiB archive: set COMMUNITY_EXPORT_BIG_TEST=1');

describe.skipIf(!big)('a real 5 GiB archive (COMMUNITY_EXPORT_BIG_TEST=1)', () => {
  // Purpose: the whole path on real storage: six segments of about 900 MiB each stored through
  // the filesystem blob store as export segments, read back through a segmented source by yauzl
  // and by our reader, which checks every entry's CRC-32 and size.
  it('writes, stores, and re-reads every byte', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zip64-big-'));
    try {
      const store = new FileSystemBlobStore(directory);
      const blocks = Array.from({ length: 6 }, () => randomBytes(MiB));
      const blobs: ArchiveBlob[] = [];
      const layouts = [];
      const digests = new Map<string, string>();
      for (let segment = 0; segment < 6; segment++) {
        const entries: ZipEntryInput[] = [0, 1, 2].map((file) => ({
          name: `files/s${segment}/f${file}`,
          method: 'stored',
          source: repeated(blocks[(segment + file) % 6], 300),
          size: 300 * MiB,
        }));
        for (const entry of entries) {
          const hash = createHash('sha256');
          for (let index = 0; index < 300; index++)
            hash.update(blocks[(segment + Number(entry.name.at(-1))) % 6]);
          digests.set(entry.name, hash.digest('hex'));
        }
        const writer = writeZipSegment(entries, { modifiedAt: FIXED_TIME });
        const stored = await store.put({
          source: writer.bytes,
          displayName: 'segment.zip',
          kind: 'export_segment',
          maxBytes: GiB,
        });
        blobs.push({ key: stored.key, byteSize: stored.byteSize });
        layouts.push(writer.summary());
      }
      const tail = writeZipTail(
        {
          segments: layouts,
          entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }],
        },
        { modifiedAt: FIXED_TIME }
      );
      const storedTail = await store.put({
        source: tail.bytes,
        displayName: 'tail.zip',
        kind: 'export_segment',
        maxBytes: GiB,
      });
      blobs.push({ key: storedTail.key, byteSize: storedTail.byteSize });
      const source = new SegmentedBlobSource(store, blobs);
      expect(source.size).toBeGreaterThan(5 * GiB);

      const yauzlRead = await readWithYauzl(source, (name) => name === 'files/s5/f2');
      expect(yauzlRead.entries.at(-2)?.offset).toBeGreaterThan(4 * GiB);
      expect(
        createHash('sha256').update(yauzlRead.contents.get('files/s5/f2')!).digest('hex')
      ).toBe(digests.get('files/s5/f2'));

      const archive = await openZipArchive(source, { allowName: () => true });
      const entries: ZipEntry[] = [];
      for await (const entry of archive.entries()) entries.push(entry);
      for (const entry of entries) {
        const hash = createHash('sha256');
        for await (const chunk of archive.openEntry(entry)) hash.update(chunk);
        if (entry.name !== 'manifest.json')
          expect(hash.digest('hex')).toBe(digests.get(entry.name));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 1_800_000);
});
