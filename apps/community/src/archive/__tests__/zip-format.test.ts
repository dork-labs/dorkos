import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertArchiveName,
  decodeEntriesIndex,
  encodeCentralDirectoryRecord,
  encodeDataDescriptor,
  encodeEndOfCentralDirectory,
  encodeEntriesIndex,
  encodeLocalHeader,
  encodeZip64EndRecord,
  encodeZip64Locator,
  localFlags,
  toDosDateTime,
  type ZipEntryRecord,
} from '../zip-format.js';

/** Hex fixture written field by field from PKWARE APPNOTE 6.3.10; spaces separate fields. */
function hex(...fields: string[]): Buffer {
  return Buffer.from(fields.join('').replaceAll(' ', ''), 'hex');
}

const name = '61 2e 74 78 74'; // "a.txt"
const time = { dosTime: 0x645c, dosDate: 0x5d37 }; // 2026-09-23 12:34:56 UTC
const helloCrc = 0x3610a686; // CRC-32 of "hello"

describe('local file header (APPNOTE 4.3.7)', () => {
  // Purpose: a streamed entry announces a data descriptor and leaves CRC and sizes at zero.
  it('encodes a streamed entry with a 32-bit data descriptor to follow', () => {
    expect(encodeLocalHeader({ name: 'a.txt', method: 8, ...time, zip64: false })).toEqual(
      hex(
        '504b0304', // signature
        '2d00', // version needed 4.5
        '0808', // flags: bit 3 (descriptor) + bit 11 (UTF-8)
        '0800', // method 8
        '5c64 375d', // DOS time, date
        '00000000 00000000 00000000', // CRC, compressed, uncompressed: in the descriptor
        '0500 0000', // name length, extra length
        name
      )
    );
  });

  // Purpose: a ZIP64 streamed entry sets both 32-bit sizes to the sentinel and carries a ZIP64
  // extra field with zeroed sizes (APPNOTE 4.3.9.2, 4.5.3).
  it('encodes a streamed ZIP64 entry', () => {
    expect(encodeLocalHeader({ name: 'a.txt', method: 8, ...time, zip64: true })).toEqual(
      hex(
        '504b0304 2d00 0808 0800 5c64 375d',
        '00000000 ffffffff ffffffff',
        '0500 1400',
        name,
        '0100 1000', // ZIP64 extra: id 1, 16 bytes
        '0000000000000000 0000000000000000'
      )
    );
  });

  // Purpose: a stored entry of known size states CRC and sizes and sets no descriptor flag.
  it('encodes a stored entry whose CRC and size are known', () => {
    const known = { crc32: helloCrc, compressedSize: 5, uncompressedSize: 5 };
    expect(encodeLocalHeader({ name: 'a.txt', method: 0, ...time, zip64: false, known })).toEqual(
      hex('504b0304 2d00 0008 0000 5c64 375d', '86a61036 05000000 05000000', '0500 0000', name)
    );
    expect(encodeLocalHeader({ name: 'a.txt', method: 0, ...time, zip64: true, known })).toEqual(
      hex(
        '504b0304 2d00 0008 0000 5c64 375d',
        '86a61036 ffffffff ffffffff',
        '0500 1400',
        name,
        '0100 1000 0500000000000000 0500000000000000'
      )
    );
  });

  // Purpose: a known size that does not fit 32 bits cannot be written without ZIP64.
  it('refuses a 4 GiB known size without ZIP64', () => {
    const known = { crc32: 0, compressedSize: 2 ** 32, uncompressedSize: 2 ** 32 };
    expect(() =>
      encodeLocalHeader({ name: 'a.txt', method: 0, ...time, zip64: false, known })
    ).toThrow(expect.objectContaining({ code: 'ZIP_ENTRY_TOO_LARGE' }));
  });
});

describe('data descriptor (APPNOTE 4.3.9)', () => {
  // Purpose: both descriptor widths, signature first.
  it('encodes 4-byte and 8-byte sizes', () => {
    expect(
      encodeDataDescriptor({
        crc32: helloCrc,
        compressedSize: 7,
        uncompressedSize: 5,
        zip64: false,
      })
    ).toEqual(hex('504b0708 86a61036 07000000 05000000'));
    expect(
      encodeDataDescriptor({
        crc32: helloCrc,
        compressedSize: 2 ** 32 + 7,
        uncompressedSize: 2 ** 32 + 5,
        zip64: true,
      })
    ).toEqual(hex('504b0708 86a61036 0700000001000000 0500000001000000'));
  });

  // Purpose: a 32-bit descriptor never silently truncates a size.
  it('refuses a size that needs 8 bytes in a 32-bit descriptor', () => {
    expect(() =>
      encodeDataDescriptor({ crc32: 0, compressedSize: 1, uncompressedSize: 2 ** 32, zip64: false })
    ).toThrow(expect.objectContaining({ code: 'ZIP_ENTRY_TOO_LARGE' }));
  });
});

describe('central directory record (APPNOTE 4.3.12, 4.5.3)', () => {
  const record: ZipEntryRecord = {
    name: 'a.txt',
    flags: localFlags(false),
    crc32: helloCrc,
    method: 8,
    compressedSize: 7,
    uncompressedSize: 5,
    offset: 0,
    ...time,
  };

  // Purpose: the one record shape: sentinels in all three 32-bit fields, the ZIP64 extra field
  // with the real values, even when every value is small.
  it('always carries the ZIP64 extra field, whatever the values', () => {
    expect(encodeCentralDirectoryRecord(record, 0x1_0000_0005)).toEqual(
      hex(
        '504b0102',
        '2d03', // made by: Unix, 4.5
        '2d00', // needed: 4.5
        '0808 0800 5c64 375d 86a61036',
        'ffffffff ffffffff', // compressed, uncompressed: in the extra field
        '0500 1c00 0000', // name, extra (28), comment lengths
        '0000 0000', // disk start, internal attributes
        '0000a481', // external attributes: regular file 0644
        'ffffffff', // local header offset: in the extra field
        name,
        '0100 1800', // ZIP64 extra: id 1, 24 bytes
        '0500000000000000', // uncompressed
        '0700000000000000', // compressed
        '0500000001000000' // offset 0x1_0000_0005
      )
    );
    const small = encodeCentralDirectoryRecord({ ...record, flags: localFlags(true) }, 9);
    expect(small.readUInt32LE(20)).toBe(0xffffffff);
    expect(small.readUInt32LE(24)).toBe(0xffffffff);
    expect(small.readUInt32LE(42)).toBe(0xffffffff);
    expect(small.readUInt16LE(8)).toBe(0x0800);
    expect(small.readBigUInt64LE(46 + 5 + 20)).toBe(9n);
  });
});

describe('end records (APPNOTE 4.3.14 to 4.3.16)', () => {
  const totals = {
    entryCount: 70_000,
    centralDirectorySize: 0x1234,
    centralDirectoryOffset: 5 * 2 ** 30,
  };

  // Purpose: the ZIP64 end record and locator hold 64-bit values; the classic record holds the
  // sentinel for each value that does not fit.
  it('encodes the ZIP64 end record, locator, and classic end record', () => {
    expect(encodeZip64EndRecord(totals)).toEqual(
      hex(
        '504b0606',
        '2c00000000000000', // size of the rest of the record: 44
        '2d03 2d00',
        '00000000 00000000', // disks
        '7011010000000000 7011010000000000', // entries on this disk, total: 70,000
        '3412000000000000', // directory size
        '0000004001000000' // directory offset: 5 GiB
      )
    );
    expect(encodeZip64Locator(5 * 2 ** 30 + 0x1234)).toEqual(
      hex('504b0607 00000000 3412004001000000 01000000')
    );
    expect(encodeEndOfCentralDirectory(totals)).toEqual(
      hex('504b0506 0000 0000 ffff ffff 34120000 ffffffff 0000')
    );
    expect(
      encodeEndOfCentralDirectory({
        entryCount: 3,
        centralDirectorySize: 10,
        centralDirectoryOffset: 20,
      })
    ).toEqual(hex('504b0506 0000 0000 0300 0300 0a000000 14000000 0000'));
  });
});

describe('MS-DOS time', () => {
  // Purpose: UTC fields, two-second resolution, clamped to the representable range.
  it('encodes and clamps', () => {
    expect(toDosDateTime(new Date('2026-09-23T12:34:56Z'))).toEqual(time);
    expect(toDosDateTime(new Date('1970-01-01T00:00:00Z'))).toEqual({ dosTime: 0, dosDate: 0x21 });
    expect(toDosDateTime(new Date('2200-01-01T00:00:00Z'))).toEqual({
      dosTime: 0xbf7d,
      dosDate: 0xff9f,
    });
    expect(() => toDosDateTime(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('entry names', () => {
  // Purpose: the writer never emits a name a reader could resolve outside its folder.
  it('refuses unsafe names', () => {
    for (const bad of [
      '',
      '/abs',
      'a/../b',
      '..',
      'a//b',
      'dir/',
      'a\\b',
      'a\u0000b',
      './a',
      '\ud800x',
    ]) {
      expect(() => assertArchiveName(bad)).toThrow(
        expect.objectContaining({ code: 'ZIP_NAME_INVALID' })
      );
    }
    for (const good of [
      'manifest.json',
      'files/1/photo é.png',
      'entries/000001.ndjson',
      '..a/b.',
    ]) {
      expect(() => assertArchiveName(good)).not.toThrow();
    }
  });
});

describe('entries index', () => {
  const recordArbitrary = fc.record({
    name: fc.string({ minLength: 1, maxLength: 40, unit: 'grapheme' }),
    flags: fc.constantFrom(localFlags(true), localFlags(false)),
    crc32: fc.nat({ max: 0xffffffff }),
    method: fc.constantFrom(0 as const, 8 as const),
    compressedSize: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
    uncompressedSize: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
    offset: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
    dosTime: fc.nat({ max: 0xffff }),
    dosDate: fc.nat({ max: 0xffff }),
  });

  // Purpose: the stored rows round-trip exactly, including 64-bit sizes and offsets.
  it('round-trips any list of records', () => {
    fc.assert(
      fc.property(fc.array(recordArbitrary, { maxLength: 20 }), (records) => {
        expect(decodeEntriesIndex(encodeEntriesIndex(records))).toEqual(records);
      })
    );
  });

  // Purpose: a truncated, padded, or foreign index is refused rather than misread.
  it('refuses a damaged index', () => {
    const records: ZipEntryRecord[] = [
      {
        name: 'a',
        flags: localFlags(true),
        crc32: 1,
        method: 0,
        compressedSize: 1,
        uncompressedSize: 1,
        offset: 0,
        ...time,
      },
    ];
    const index = encodeEntriesIndex(records);
    const refusals = [
      index.subarray(0, index.length - 1),
      Buffer.concat([index, Buffer.from([0])]),
      Buffer.concat([Buffer.from('ZIX2'), index.subarray(4)]),
      (() => {
        const copy = Buffer.from(index);
        copy.writeUInt8(12, 8 + 2 + 1 + 6); // method 12
        return copy;
      })(),
      (() => {
        const copy = Buffer.from(index);
        copy.writeBigUInt64LE(2n ** 60n, 8 + 2 + 1 + 11); // compressed size past 2^53
        return copy;
      })(),
    ];
    for (const damaged of refusals) {
      expect(() => decodeEntriesIndex(damaged)).toThrow(
        expect.objectContaining({ code: 'ZIP_INDEX_INVALID' })
      );
    }
  });
});
