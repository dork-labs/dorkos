import { randomBytes, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { collectBytes } from '../streams.js';
import { openZipArchive, ZipReaderError, type ZipEntry } from '../zip-reader.js';
import { bufferReader, readWithOurReader, writeArchive } from './archive-test-helpers.js';

const V1_NAME = /^(manifest\.json|attachments\/[0-9a-f-]{36})$/;
const allowV1 = (name: string) => V1_NAME.test(name);
const allowAll = () => true;

/** A version 1 export exactly as `routes/exports.ts` writes it: fflate streaming, stored. */
function versionOneArchive(manifest: Uint8Array, files: [string, Uint8Array][]): Buffer {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const manifestEntry = new ZipPassThrough('manifest.json');
  zip.add(manifestEntry);
  manifestEntry.push(manifest, true);
  for (const [id, bytes] of files) {
    const file = new ZipPassThrough(`attachments/${id}`);
    zip.add(file);
    file.push(bytes.subarray(0, 7), false);
    file.push(bytes.subarray(7), true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

async function readAll(archive: Buffer, allowName: (name: string) => boolean = allowAll) {
  return readWithOurReader(bufferReader(archive), () => true, allowName);
}

/** Offsets of each central directory record, found by walking back from the end records. */
function directoryRecordOffsets(archive: Buffer): number[] {
  const end = archive.length - 22;
  let offset = archive.readUInt32LE(end + 16);
  let count = archive.readUInt16LE(end + 10);
  if (archive.readUInt32LE(end - 20) === 0x07064b50) {
    const zip64 = Number(archive.readBigUInt64LE(end - 20 + 8));
    count = Number(archive.readBigUInt64LE(zip64 + 32));
    offset = Number(archive.readBigUInt64LE(zip64 + 48));
  }
  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    offsets.push(offset);
    offset +=
      46 +
      archive.readUInt16LE(offset + 28) +
      archive.readUInt16LE(offset + 30) +
      archive.readUInt16LE(offset + 32);
  }
  return offsets;
}

async function expectRefusal(
  archive: Buffer,
  code: string,
  allowName: (name: string) => boolean = allowAll
) {
  const error = await readAll(archive, allowName).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ZipReaderError);
  expect(error).toMatchObject({ code });
}

describe('version 1 archives', () => {
  // Purpose: the new reader reads what fflate wrote for version 1 exports (stored, streamed with
  // data descriptors, no ZIP64), so import can swap readers without breaking old archives.
  it('reads a real version 1 export', async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, rows: [] }));
    const files: [string, Uint8Array][] = [
      [randomUUID(), randomBytes(10_000)],
      [randomUUID(), randomBytes(8)],
    ];
    const archive = versionOneArchive(manifest, files);
    const read = await readAll(archive, allowV1);
    expect(read.entries.map((entry) => entry.name)).toEqual([
      'manifest.json',
      ...files.map(([id]) => `attachments/${id}`),
    ]);
    expect(read.contents.get('manifest.json')).toEqual(Buffer.from(manifest));
    for (const [id, bytes] of files)
      expect(read.contents.get(`attachments/${id}`)).toEqual(Buffer.from(bytes));
  });

  // Purpose: deflated entries with sizes in the local header (fflate's one-shot writer) read too.
  it('reads a deflated archive with sizes in the local headers', async () => {
    const text = Buffer.from('hello '.repeat(1000));
    const archive = Buffer.from(zipSync({ 'manifest.json': [text, { level: 9 }] }));
    expect((await readAll(archive, allowV1)).contents.get('manifest.json')).toEqual(text);
  });
});

describe('refusals', () => {
  const base = () =>
    versionOneArchive(new TextEncoder().encode('{"version":1}'), [
      [randomUUID(), randomBytes(300)],
      [randomUUID(), randomBytes(200)],
    ]);

  // Purpose: an encrypted entry is refused whether the directory or only the local header says so.
  it('refuses encrypted entries', async () => {
    const archive = base();
    const [first] = directoryRecordOffsets(archive);
    archive.writeUInt16LE(archive.readUInt16LE(first + 8) | 1, first + 8);
    await expectRefusal(archive, 'ZIP_ENCRYPTED');
    const local = base();
    local.writeUInt16LE(local.readUInt16LE(6) | 1, 6);
    await expectRefusal(local, 'ZIP_ENCRYPTED');
  });

  // Purpose: only stored and deflated entries are read.
  it('refuses method 12', async () => {
    const archive = base();
    const [first] = directoryRecordOffsets(archive);
    archive.writeUInt16LE(12, first + 10);
    await expectRefusal(archive, 'ZIP_METHOD_UNSUPPORTED');
  });

  // Purpose: a path trick is refused by the built-in rules; a name the caller's pattern forbids
  // is refused by the pattern; a directory entry is refused outright.
  it('refuses ../x, names outside the pattern, and directories', async () => {
    const traversal = Buffer.from(zipSync({ '../x': new Uint8Array([1]) }));
    await expectRefusal(traversal, 'ZIP_NAME_REJECTED');
    const other = Buffer.from(zipSync({ 'other.txt': new Uint8Array([1]) }));
    await expectRefusal(other, 'ZIP_NAME_REJECTED', allowV1);
    expect((await readAll(other)).entries).toHaveLength(1);
    const directory = Buffer.from(zipSync({ 'dir/': new Uint8Array(0) }));
    await expectRefusal(directory, 'ZIP_DIRECTORY_ENTRY');
  });

  // Purpose: two entries with one name never both reach an importer.
  it('refuses a duplicate name', async () => {
    const id = randomUUID();
    const archive = versionOneArchive(new Uint8Array([1]), [
      [id, randomBytes(10)],
      [id, randomBytes(10)],
    ]);
    await expectRefusal(archive, 'ZIP_DUPLICATE_NAME', allowV1);
  });

  // Purpose: the local header must name the same file as the central directory.
  it('refuses a local header whose name disagrees with the directory', async () => {
    const archive = base();
    archive[30] = 'M'.charCodeAt(0); // "manifest.json" -> "Manifest.json" in the first local header
    await expectRefusal(archive, 'ZIP_HEADER_MISMATCH');
  });

  // Purpose: two directory records pointing at one entry (the overlap behind quine zips and
  // bomb tricks) are refused, and so is an entry whose data runs into the next.
  it('refuses overlapping entries', async () => {
    const archive = base();
    const [first, second] = directoryRecordOffsets(archive);
    archive.writeUInt32LE(archive.readUInt32LE(first + 42), second + 42);
    await expectRefusal(archive, 'ZIP_OVERLAPPING_ENTRIES');
    // Refused by the directory pass itself, before any entry could be opened.
    const opened = await openZipArchive(bufferReader(archive), { allowName: allowAll });
    await expect(
      (async () => {
        for await (const entry of opened.entries()) void entry;
      })()
    ).rejects.toMatchObject({ code: 'ZIP_OVERLAPPING_ENTRIES' });
    const long = base();
    const [, record] = directoryRecordOffsets(long);
    long.writeUInt32LE(long.readUInt32LE(record + 20) + 40, record + 20);
    long.writeUInt32LE(long.readUInt32LE(record + 24) + 40, record + 24);
    await expectRefusal(long, 'ZIP_OVERLAPPING_ENTRIES');
  });

  // Purpose: a deflate bomb stops as soon as it inflates past its declared size, having handed
  // out no more than that size.
  it('refuses an entry that inflates past its declared size, without inflating it all', async () => {
    const written = await writeArchive(
      [[{ name: 'bomb', method: 'deflated', source: Buffer.alloc(8 * 1024 * 1024) }]],
      []
    );
    const archive = written.archive;
    const [record] = directoryRecordOffsets(archive);
    archive.writeBigUInt64LE(1000n, record + 46 + 4 + 4); // ZIP64 extra: uncompressed size
    const opened = await openZipArchive(bufferReader(archive), { allowName: allowAll });
    const entries: ZipEntry[] = [];
    for await (const entry of opened.entries()) entries.push(entry);
    let handedOut = 0;
    const error = await (async () => {
      for await (const chunk of opened.openEntry(entries[0])) handedOut += chunk.length;
    })().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ZIP_SIZE_MISMATCH' });
    expect(handedOut).toBeLessThanOrEqual(1000);
  });

  // Purpose: a changed byte or a wrong checksum is caught at the end of the entry.
  it('refuses a checksum mismatch and a short entry', async () => {
    const archive = base();
    const [, second] = directoryRecordOffsets(archive);
    archive.writeUInt32LE((archive.readUInt32LE(second + 16) ^ 1) >>> 0, second + 16);
    await expectRefusal(archive, 'ZIP_CRC_MISMATCH');
    const written = await writeArchive(
      [[{ name: 'a', method: 'deflated', source: Buffer.from('hello') }]],
      []
    );
    const [record] = directoryRecordOffsets(written.archive);
    written.archive.writeBigUInt64LE(9n, record + 46 + 1 + 4);
    await expectRefusal(written.archive, 'ZIP_SIZE_MISMATCH');
  });

  // Purpose: end records that disagree with the directory, or no end record at all, are refused.
  it('refuses broken end records and non-archives', async () => {
    const written = await writeArchive(
      [[{ name: 'a', method: 'deflated', source: Buffer.from('x') }]],
      []
    );
    const counted = Buffer.from(written.archive);
    const zip64 = Number(counted.readBigUInt64LE(counted.length - 22 - 20 + 8));
    counted.writeBigUInt64LE(2n, zip64 + 24);
    counted.writeBigUInt64LE(2n, zip64 + 32);
    await expectRefusal(counted, 'ZIP_CORRUPT');
    await expectRefusal(randomBytes(5000), 'ZIP_NOT_AN_ARCHIVE');
    await expectRefusal(Buffer.alloc(10), 'ZIP_NOT_AN_ARCHIVE');
    await expectRefusal(
      written.archive.subarray(0, written.archive.length - 1),
      'ZIP_NOT_AN_ARCHIVE'
    );
    await expectRefusal(written.archive.subarray(1), 'ZIP_CORRUPT');
  });

  // Purpose: entries can be opened only after the whole directory passed its global checks, and
  // only entries this archive handed out.
  it('opens only entries from a completed pass', async () => {
    const written = await writeArchive(
      [[{ name: 'a', method: 'deflated', source: Buffer.from('x') }]],
      []
    );
    const archive = await openZipArchive(bufferReader(written.archive), { allowName: allowAll });
    const iterator = archive.entries();
    const first = await iterator.next();
    const entry = first.value as ZipEntry;
    await expect(collectBytes(archive.openEntry(entry))).rejects.toThrow('completed pass');
    await iterator.next();
    expect(await collectBytes(archive.openEntry(entry))).toEqual(Buffer.from('x'));
    await expect(
      collectBytes(archive.openEntry({ ...entry, uncompressedSize: 10 ** 9 }))
    ).rejects.toThrow('completed pass');
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('limits and hardening', () => {
  const twoEntries = () =>
    writeArchive(
      [
        [
          { name: 'a.ndjson', method: 'deflated', source: Buffer.from('{"a":1}\n'.repeat(100)) },
          { name: 'b.bin', method: 'stored', source: Buffer.alloc(50, 1), size: 50 },
        ],
      ],
      []
    );

  // Purpose: the declared count is checked before any directory byte is read, so a huge count
  // cannot exhaust memory in the duplicate check.
  it('refuses an archive that declares more entries than allowed', async () => {
    const { archive } = await twoEntries();
    await expect(
      openZipArchive(bufferReader(archive), { allowName: allowAll, maxEntries: 1 })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_MANY_ENTRIES' });
    await expect(
      openZipArchive(bufferReader(archive), { allowName: allowAll, maxEntries: 2 })
    ).resolves.toBeDefined();
    for (const maxEntries of [0, 10_000_001, 1.5]) {
      await expect(
        openZipArchive(bufferReader(archive), { allowName: allowAll, maxEntries })
      ).rejects.toThrow(RangeError);
    }
  });

  // Purpose: a declared size deflate cannot produce is refused in the directory pass, and the
  // caller's per-entry and total limits hold.
  it('refuses impossible ratios and sizes past the limits', async () => {
    const { archive } = await twoEntries();
    const [first] = directoryRecordOffsets(archive);
    const compressed = Number(archive.readBigUInt64LE(first + 46 + 8 + 12));
    const bomb = Buffer.from(archive);
    bomb.writeBigUInt64LE(BigInt(compressed * 1032 + 1025), first + 46 + 8 + 4);
    // Refused while reading the directory, before a byte is inflated.
    const opened = await openZipArchive(bufferReader(bomb), { allowName: allowAll });
    await expect(
      (async () => {
        for await (const entry of opened.entries()) void entry;
      })()
    ).rejects.toMatchObject({ code: 'ZIP_SIZE_MISMATCH' });
    const limited = async (options: { maxEntryBytes?: number; maxTotalBytes?: number }) => {
      const opened = await openZipArchive(bufferReader(archive), {
        allowName: allowAll,
        ...options,
      });
      for await (const entry of opened.entries()) void entry;
    };
    await expect(limited({ maxEntryBytes: 799 })).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
    await expect(limited({ maxTotalBytes: 849 })).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
    await expect(limited({ maxEntryBytes: 800, maxTotalBytes: 850 })).resolves.toBeUndefined();
  });

  // Purpose: when offsets ascend, a repeated offset is refused at the record that repeats it,
  // before the rest of the directory is read.
  it('refuses a repeated offset as soon as it appears', async () => {
    const archive = versionOneArchive(new Uint8Array([1]), [
      [randomUUID(), randomBytes(10)],
      [randomUUID(), randomBytes(10)],
      [randomUUID(), randomBytes(10)],
    ]);
    const [first, second] = directoryRecordOffsets(archive);
    archive.writeUInt32LE(archive.readUInt32LE(first + 42), second + 42);
    const opened = await openZipArchive(bufferReader(archive), { allowName: allowAll });
    let yielded = 0;
    const error = await (async () => {
      for await (const entry of opened.entries()) {
        void entry;
        yielded++;
      }
    })().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ZIP_OVERLAPPING_ENTRIES' });
    expect(yielded).toBe(1);
  });

  // Purpose: bytes smuggled after the end of a deflate stream (inside the declared compressed
  // size) are refused even though the inflated bytes and checksum are right.
  it('refuses bytes after the deflate stream', async () => {
    const { archive } = await twoEntries();
    const [first] = directoryRecordOffsets(archive);
    const at = first + 46 + 8 + 12;
    archive.writeBigUInt64LE(archive.readBigUInt64LE(at) + 4n, at);
    await expectRefusal(archive, 'ZIP_CORRUPT');
  });

  // Purpose: the classic end record may only repeat the ZIP64 values or hold the sentinel, and
  // the ZIP64 record must end at its locator.
  it('refuses end records that disagree', async () => {
    const { archive } = await twoEntries();
    const count = Buffer.from(archive);
    count.writeUInt16LE(7, count.length - 22 + 10);
    await expectRefusal(count, 'ZIP_CORRUPT');
    const length = Buffer.from(archive);
    const zip64 = Number(length.readBigUInt64LE(length.length - 22 - 20 + 8));
    length.writeBigUInt64LE(52n, zip64 + 4);
    await expectRefusal(length, 'ZIP_CORRUPT');
    const sentinel = Buffer.from(archive);
    sentinel.writeUInt16LE(0xffff, sentinel.length - 22 + 10);
    sentinel.writeUInt16LE(0xffff, sentinel.length - 22 + 8);
    expect((await readAll(sentinel)).entries).toHaveLength(2);
  });

  // Purpose: names that differ only in case or Unicode normalization land on one file on
  // common file systems, so they count as duplicates.
  it('refuses names that collide by case or normalization', async () => {
    await expectRefusal(
      Buffer.from(zipSync({ 'A.txt': new Uint8Array([1]), 'a.txt': new Uint8Array([2]) })),
      'ZIP_DUPLICATE_NAME'
    );
    await expectRefusal(
      Buffer.from(zipSync({ 'caf\u00e9': new Uint8Array([1]), 'cafe\u0301': new Uint8Array([2]) })),
      'ZIP_DUPLICATE_NAME'
    );
    await expectRefusal(
      Buffer.from(zipSync({ 'a\u202egnp.exe': new Uint8Array([1]) })),
      'ZIP_NAME_REJECTED'
    );
    await expectRefusal(
      Buffer.from(zipSync({ 'c:evil': new Uint8Array([1]) })),
      'ZIP_NAME_REJECTED'
    );
  });
});

describe('fuzz: damaged archives', () => {
  // Purpose: any single damaged byte or truncation either reads back exactly the original
  // contents or is refused with a ZipReaderError; it never crashes differently or returns other
  // bytes.
  it('refuses cleanly or reads the original bytes', async () => {
    const original = await writeArchive(
      [
        [
          {
            name: 'entries/000001.ndjson',
            method: 'deflated',
            source: Buffer.from('{"a":1}\n'.repeat(50)),
          },
          { name: 'files/x/f', method: 'stored', source: randomBytes(64), size: 64 },
        ],
      ],
      [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{"version":2}') }]
    );
    const expected = (await readAll(original.archive)).contents;
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: original.archive.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        fc.boolean(),
        async (position, delta, truncate) => {
          const damaged = truncate
            ? original.archive.subarray(0, position)
            : Buffer.from(original.archive);
          if (!truncate) damaged[position] = (damaged[position] + delta) & 0xff;
          try {
            const read = await readAll(damaged);
            expect(read.contents).toEqual(expected);
          } catch (error) {
            expect(error).toBeInstanceOf(ZipReaderError);
          }
        }
      ),
      { numRuns: 400 }
    );
  });
});
