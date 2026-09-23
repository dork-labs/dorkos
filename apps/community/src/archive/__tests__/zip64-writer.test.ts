import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { collectBytes } from '../streams.js';
import {
  CENTRAL_DIRECTORY_SIGNATURE,
  decodeEntriesIndex,
  encodeEntriesIndex,
  FLAG_DATA_DESCRIPTOR,
  UINT32_SENTINEL,
  ZIP64_EXTRA_ID,
} from '../zip-format.js';
import {
  STORED_BUFFER_LIMIT,
  writeZipSegment,
  writeZipTail,
  type ZipEntryInput,
} from '../zip64-writer.js';
import {
  bufferReader,
  FIXED_TIME,
  readWithOurReader,
  readWithYauzl,
  writeArchive,
} from './archive-test-helpers.js';

const options = { modifiedAt: FIXED_TIME };

function ndjson(segment: number, rows = 200): Buffer {
  return Buffer.from(
    Array.from({ length: rows }, (_, row) => JSON.stringify({ segment, row, text: 'hello' })).join(
      '\n'
    ) + '\n'
  );
}

function segmentEntries(segment: number, fileBytes: Buffer): ZipEntryInput[] {
  return [
    { name: `entries/00000${segment}.ndjson`, method: 'deflated', source: ndjson(segment) },
    {
      name: `attachments/00000${segment}.ndjson`,
      method: 'deflated',
      source: [Buffer.from('{"id":1}\n')],
    },
    {
      name: `files/f${segment}/photo ${segment}.png`,
      method: 'stored',
      source: fileBytes,
      size: fileBytes.length,
    },
  ];
}

/** Walk the central directory of a complete archive and return each record's raw bytes. */
function centralDirectoryRecords(archive: Buffer, offset: number, size: number): Buffer[] {
  const records: Buffer[] = [];
  let at = offset;
  while (at < offset + size) {
    expect(archive.readUInt32LE(at)).toBe(CENTRAL_DIRECTORY_SIGNATURE);
    const length =
      46 +
      archive.readUInt16LE(at + 28) +
      archive.readUInt16LE(at + 30) +
      archive.readUInt16LE(at + 32);
    records.push(archive.subarray(at, at + length));
    at += length;
  }
  expect(at).toBe(offset + size);
  return records;
}

describe('CRC-32', () => {
  // Purpose: the stored CRC is the standard CRC-32, also when an entry arrives in several chunks.
  it('matches the zlib.crc32 check vectors', async () => {
    const writer = writeZipSegment(
      [
        { name: 'digits', method: 'deflated', source: [Buffer.from('1234'), Buffer.from('56789')] },
        {
          name: 'fox',
          method: 'stored',
          source: Buffer.from('The quick brown fox jumps over the lazy dog'),
          size: 43,
        },
        { name: 'empty', method: 'deflated', source: [] },
      ],
      options
    );
    await collectBytes(writer.bytes);
    const [digits, fox, empty] = writer.summary().entries;
    expect(digits.crc32).toBe(0xcbf43926);
    expect(digits.crc32).toBe(crc32('123456789'));
    expect(fox.crc32).toBe(0x414fa339);
    expect(empty.crc32).toBe(0);
    expect(empty.uncompressedSize).toBe(0);
  });
});

describe('segmented archive', () => {
  for (const forceZip64 of [false, true]) {
    // Purpose: AC-2's shape. Three segments written independently plus a tail open in an
    // independent reader with every byte intact, and every central directory record carries the
    // ZIP64 extra field with sentinels in the 32-bit fields.
    it(`opens three segments and a tail in yauzl and our reader${forceZip64 ? ' (forced ZIP64)' : ''}`, async () => {
      const files = [randomBytes(3000), randomBytes(70_000), randomBytes(1)];
      const written = await writeArchive(
        files.map((file, index) => segmentEntries(index + 1, file)),
        [
          { name: 'members.ndjson', method: 'deflated', source: Buffer.from('{"id":"m"}\n') },
          { name: 'community/icon', method: 'stored', source: files[2], size: 1 },
          { name: 'manifest.json', method: 'deflated', source: Buffer.from('{"version":2}') },
        ],
        { modifiedAt: FIXED_TIME, forceZip64 }
      );
      expect(written.segments.map((segment) => segment.readUInt32LE(0))).toEqual([
        0x04034b50, 0x04034b50, 0x04034b50,
      ]);

      const expected = new Map<string, Buffer>();
      files.forEach((file, index) => {
        expected.set(`entries/00000${index + 1}.ndjson`, ndjson(index + 1));
        expected.set(`attachments/00000${index + 1}.ndjson`, Buffer.from('{"id":1}\n'));
        expected.set(`files/f${index + 1}/photo ${index + 1}.png`, file);
      });
      expected.set('members.ndjson', Buffer.from('{"id":"m"}\n'));
      expected.set('community/icon', files[2]);
      expected.set('manifest.json', Buffer.from('{"version":2}'));

      const yauzlRead = await readWithYauzl(bufferReader(written.archive));
      expect(yauzlRead.entries.map((entry) => entry.name)).toEqual([...expected.keys()]);
      expect(yauzlRead.contents).toEqual(expected);
      const ours = await readWithOurReader(bufferReader(written.archive));
      expect(ours.contents).toEqual(expected);
      expect(ours.entries.map((entry) => entry.offset)).toEqual(
        yauzlRead.entries.map((entry) => entry.offset)
      );
      expect(ours.entries.at(-1)?.name).toBe('manifest.json');

      const records = centralDirectoryRecords(
        written.archive,
        written.archive.length - 98 - sumRecordBytes(expected),
        sumRecordBytes(expected)
      );
      expect(records).toHaveLength(expected.size);
      for (const record of records) {
        const nameLength = record.readUInt16LE(28);
        const extra = record.subarray(46 + nameLength);
        expect(record.readUInt32LE(20)).toBe(UINT32_SENTINEL);
        expect(record.readUInt32LE(24)).toBe(UINT32_SENTINEL);
        expect(record.readUInt32LE(42)).toBe(UINT32_SENTINEL);
        expect(extra.readUInt16LE(0)).toBe(ZIP64_EXTRA_ID);
        expect(extra.readUInt16LE(2)).toBe(24);
      }
    });
  }

  // Purpose: rebuilding one segment (which changes its size) only needs a new tail; rewriting
  // only the tail also opens. The untouched segments are byte-identical.
  it('reopens after the middle segment is rewritten with a different size, and after a tail-only rewrite', async () => {
    const groups = [1, 2, 3].map((index) =>
      segmentEntries(index, Buffer.alloc(500 * index, index))
    );
    const original = await writeArchive(groups, [
      { name: 'manifest.json', method: 'deflated', source: Buffer.from('{"v":1}') },
    ]);

    const rewritten = writeZipSegment(
      [
        {
          name: 'entries/000002.ndjson',
          method: 'deflated',
          source: Buffer.from('{"removed":true}\n'),
        },
        { name: 'attachments/000002.ndjson', method: 'deflated', source: Buffer.from('') },
      ],
      options
    );
    const middle = await collectBytes(rewritten.bytes);
    expect(middle.length).not.toBe(original.segments[1].length);
    // The rows survive storage as an index and come back unchanged.
    const layouts = [original.layouts[0], rewritten.summary(), original.layouts[2]].map(
      (layout) => ({
        byteSize: layout.byteSize,
        entries: decodeEntriesIndex(encodeEntriesIndex(layout.entries)),
      })
    );
    const tail = writeZipTail(
      {
        segments: layouts,
        entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{"v":2}') }],
      },
      options
    );
    const archive = Buffer.concat([
      original.segments[0],
      middle,
      original.segments[2],
      await collectBytes(tail.bytes),
    ]);
    const read = await readWithYauzl(bufferReader(archive));
    expect(read.contents.get('entries/000002.ndjson')?.toString()).toBe('{"removed":true}\n');
    expect(read.contents.has('files/f2/photo 2.png')).toBe(false);
    expect(read.contents.get('files/f3/photo 3.png')).toEqual(Buffer.alloc(1500, 3));
    expect(read.contents.get('manifest.json')?.toString()).toBe('{"v":2}');
    expect((await readWithOurReader(bufferReader(archive))).contents).toEqual(read.contents);

    const tailOnly = writeZipTail(
      {
        segments: original.layouts,
        entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{"v":3}') }],
      },
      options
    );
    const second = Buffer.concat([...original.segments, await collectBytes(tailOnly.bytes)]);
    const reread = await readWithYauzl(bufferReader(second));
    expect(reread.contents.get('manifest.json')?.toString()).toBe('{"v":3}');
    expect(reread.contents.get('files/f2/photo 2.png')).toEqual(Buffer.alloc(1000, 2));
  });

  // Purpose: the same inputs give the same bytes, which a restarted job relies on.
  it('is byte-identical across runs with the same inputs', async () => {
    const make = () =>
      writeArchive(
        [segmentEntries(1, Buffer.alloc(10, 1))],
        [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }]
      );
    expect((await make()).archive).toEqual((await make()).archive);
  });

  // Purpose: stored entries of known size are readable front to back (no descriptor); streamed
  // entries use one.
  it('writes stored entries of known size without a data descriptor', async () => {
    const writer = writeZipSegment(
      [
        { name: 'known', method: 'stored', source: Buffer.from('abc'), size: 3 },
        { name: 'unknown', method: 'stored', source: [Buffer.from('abc')] },
        { name: 'deflated', method: 'deflated', source: Buffer.from('abc') },
      ],
      options
    );
    const bytes = await collectBytes(writer.bytes);
    const [known, unknown, deflated] = writer.summary().entries;
    expect(known.flags & FLAG_DATA_DESCRIPTOR).toBe(0);
    expect(unknown.flags & FLAG_DATA_DESCRIPTOR).not.toBe(0);
    expect(deflated.flags & FLAG_DATA_DESCRIPTOR).not.toBe(0);
    expect(bytes.readUInt32LE(14)).toBe(crc32('abc'));
    expect(bytes.readUInt32LE(18)).toBe(3);
    // Header, name, data, and no descriptor before the next header.
    expect(unknown.offset).toBe(30 + 'known'.length + 3);
    expect(bytes.readUInt32LE(unknown.offset)).toBe(0x04034b50);
    expect(STORED_BUFFER_LIMIT).toBeGreaterThanOrEqual(25 * 1024 * 1024);
  });
});

function sumRecordBytes(entries: Map<string, Buffer>): number {
  let total = 0;
  for (const name of entries.keys()) total += 46 + Buffer.byteLength(name) + 28;
  return total;
}

describe('refusals', () => {
  // Purpose: a declared size is a promise the bytes must keep, in both directions.
  it('refuses an entry whose bytes do not match its declared size', async () => {
    for (const size of [2, 4]) {
      for (const method of ['stored', 'deflated'] as const) {
        const writer = writeZipSegment(
          [{ name: 'x', method, source: Buffer.from('abc'), size }],
          options
        );
        await expect(collectBytes(writer.bytes)).rejects.toMatchObject({
          code: 'ZIP_SIZE_MISMATCH',
        });
      }
    }
  });

  // Purpose: names are unique across the whole archive, not just within one segment.
  it('refuses duplicate and unsafe names', async () => {
    const duplicate = writeZipSegment(
      [
        { name: 'a', method: 'deflated', source: Buffer.from('1') },
        { name: 'a', method: 'deflated', source: Buffer.from('2') },
      ],
      options
    );
    await expect(collectBytes(duplicate.bytes)).rejects.toMatchObject({
      code: 'ZIP_DUPLICATE_NAME',
    });
    const first = writeZipSegment(
      [{ name: 'a', method: 'deflated', source: Buffer.from('1') }],
      options
    );
    await collectBytes(first.bytes);
    expect(() => writeZipTail({ segments: [first.summary(), first.summary()] }, options)).toThrow(
      expect.objectContaining({ code: 'ZIP_DUPLICATE_NAME' })
    );
    const tail = writeZipTail(
      {
        segments: [first.summary()],
        entries: [{ name: 'a', method: 'deflated', source: Buffer.from('') }],
      },
      options
    );
    await expect(collectBytes(tail.bytes)).rejects.toMatchObject({ code: 'ZIP_DUPLICATE_NAME' });
    const unsafe = writeZipSegment(
      [{ name: '../evil', method: 'deflated', source: Buffer.from('') }],
      options
    );
    await expect(collectBytes(unsafe.bytes)).rejects.toMatchObject({ code: 'ZIP_NAME_INVALID' });
  });

  // Purpose: an empty segment, a bad layout, or a failing source never produce an archive.
  it('refuses empty segments, impossible layouts, and propagates source errors', async () => {
    await expect(collectBytes(writeZipSegment([], options).bytes)).rejects.toMatchObject({
      code: 'ZIP_SEGMENT_INVALID',
    });
    const entry = {
      name: 'a',
      flags: 0x0800,
      crc32: 0,
      method: 0 as const,
      compressedSize: 0,
      uncompressedSize: 0,
      offset: 10,
      dosTime: 0,
      dosDate: 0,
    };
    expect(() => writeZipTail({ segments: [{ byteSize: 10, entries: [entry] }] })).toThrow(
      expect.objectContaining({ code: 'ZIP_SEGMENT_INVALID' })
    );
    expect(() => writeZipTail({ segments: [{ byteSize: 0, entries: [] }] })).toThrow(
      expect.objectContaining({ code: 'ZIP_SEGMENT_INVALID' })
    );
    await expect(collectBytes(writeZipTail({ segments: [] }).bytes)).rejects.toMatchObject({
      code: 'ZIP_SEGMENT_INVALID',
    });
    async function* failing() {
      yield Buffer.from('partial');
      throw new Error('blob vanished');
    }
    for (const method of ['stored', 'deflated'] as const) {
      const writer = writeZipSegment([{ name: 'x', method, source: failing() }], options);
      await expect(collectBytes(writer.bytes)).rejects.toThrow('blob vanished');
      expect(() => writer.summary()).toThrow('not been written');
    }
  });

  // Purpose: a writer is single-use, so no caller can store half of a segment twice.
  it('is consumed once', async () => {
    const writer = writeZipSegment(
      [{ name: 'a', method: 'deflated', source: Buffer.from('') }],
      options
    );
    await collectBytes(writer.bytes);
    expect(() => writer.bytes[Symbol.asyncIterator]()).toThrow('consumed once');
    const tail = writeZipTail({ segments: [writer.summary()] }, options);
    await collectBytes(tail.bytes);
    expect(() => tail.parts(10)).toThrow('consumed once');
  });
});

describe('tail parts', () => {
  // Purpose: a tail split into several blobs starts every part with a ZIP signature (so the
  // export_segment kind accepts it) and concatenates to exactly the unsplit tail.
  it('splits only where a record starts', async () => {
    const segment = writeZipSegment(
      Array.from({ length: 300 }, (_, index) => ({
        name: `files/${index}/f`,
        method: 'stored' as const,
        source: Buffer.from([index % 256]),
        size: 1,
      })),
      options
    );
    await collectBytes(segment.bytes);
    const input = {
      segments: [segment.summary()],
      entries: [
        { name: 'members.ndjson', method: 'deflated' as const, source: randomBytes(9000) },
        { name: 'manifest.json', method: 'deflated' as const, source: Buffer.from('{}') },
      ],
    };
    const whole = await collectBytes(writeZipTail(input, options).bytes);
    const split = writeZipTail(input, options);
    const parts: Buffer[] = [];
    for await (const part of split.parts(2000)) parts.push(await collectBytes(part));
    expect(parts.length).toBeGreaterThan(4);
    expect(Buffer.concat(parts)).toEqual(whole);
    for (const part of parts) {
      expect([0x04034b50, 0x02014b50, 0x06064b50]).toContain(part.readUInt32LE(0));
    }
    const last = parts.at(-1)!;
    expect(last.readUInt32LE(last.length - 22)).toBe(0x06054b50);
    expect(split.summary().byteSize).toBe(whole.length);
    expect(split.summary().entryCount).toBe(302);

    const lazy = writeZipTail(input, options);
    const iterator = lazy.parts(2000)[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow('Consume each tail part fully');
  });
});

describe('property: any entries round-trip', () => {
  const entryArbitrary = fc.record({
    method: fc.constantFrom('stored' as const, 'deflated' as const),
    data: fc.uint8Array({ maxLength: 3000 }),
    repeat: fc.integer({ min: 1, max: 40 }),
    chunk: fc.integer({ min: 1, max: 5000 }),
    declare: fc.boolean(),
  });

  // Purpose: whatever the sizes, methods, chunking and segment split, yauzl and our reader both
  // return exactly the bytes written.
  it('reads back every entry with yauzl and our reader', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(entryArbitrary, { minLength: 1, maxLength: 5 }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.boolean(),
        async (groups, forceZip64) => {
          const expected = new Map<string, Buffer>();
          let counter = 0;
          const inputs = groups.map((group) =>
            group.map((entry): ZipEntryInput => {
              const name = `e/${counter++}.bin`;
              const bytes = Buffer.concat(Array.from({ length: entry.repeat }, () => entry.data));
              expected.set(name, bytes);
              const chunks: Buffer[] = [];
              for (let at = 0; at < bytes.length; at += entry.chunk)
                chunks.push(bytes.subarray(at, at + entry.chunk));
              return {
                name,
                method: entry.method,
                source: chunks,
                size: entry.declare ? bytes.length : undefined,
              };
            })
          );
          const written = await writeArchive(
            inputs,
            [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }],
            { modifiedAt: FIXED_TIME, forceZip64 }
          );
          expected.set('manifest.json', Buffer.from('{}'));
          expect((await readWithYauzl(bufferReader(written.archive))).contents).toEqual(expected);
          expect((await readWithOurReader(bufferReader(written.archive))).contents).toEqual(
            expected
          );
        }
      ),
      { numRuns: 40 }
    );
  });
});
