/**
 * ZIP record layouts shared by the segment writer and the central-directory reader.
 *
 * Field order and sizes follow PKWARE APPNOTE.TXT 6.3.10 (sections 4.3.7, 4.3.9, 4.3.12,
 * 4.3.14 to 4.3.16 and 4.5.3). Every multi-byte field is little-endian.
 */

/** `PK\x03\x04`: local file header. */
export const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
/** `PK\x07\x08`: data descriptor. */
export const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
/** `PK\x01\x02`: central directory file header. */
export const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
/** `PK\x06\x06`: ZIP64 end of central directory record. */
export const ZIP64_END_SIGNATURE = 0x06064b50;
/** `PK\x06\x07`: ZIP64 end of central directory locator. */
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** `PK\x05\x06`: classic end of central directory record. */
export const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Header id of the ZIP64 extended information extra field. */
export const ZIP64_EXTRA_ID = 0x0001;
/** A 32-bit field holding this value defers to the ZIP64 extra field. */
export const UINT32_SENTINEL = 0xffffffff;
/** A 16-bit field holding this value defers to the ZIP64 end record. */
export const UINT16_SENTINEL = 0xffff;

/** General-purpose flag bit 0: the entry is encrypted. */
export const FLAG_ENCRYPTED = 1 << 0;
/** General-purpose flag bit 3: CRC-32 and sizes follow the data in a data descriptor. */
export const FLAG_DATA_DESCRIPTOR = 1 << 3;
/** General-purpose flag bit 6: strong encryption. */
export const FLAG_STRONG_ENCRYPTION = 1 << 6;
/** General-purpose flag bit 11: the name is UTF-8. */
export const FLAG_UTF8 = 1 << 11;

/** Version needed to extract: 4.5, the first version with ZIP64. */
export const VERSION_NEEDED = 45;
/** Version made by: host 3 (Unix) in the high byte, so external attributes carry a file mode. */
export const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** External attributes of a regular file with mode 0644 (`S_IFREG | 0644` in the high 16 bits). */
export const REGULAR_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

/** Fixed part of a local file header. */
export const LOCAL_HEADER_BYTES = 30;
/** Fixed part of a central directory record. */
export const CENTRAL_DIRECTORY_RECORD_BYTES = 46;
/** A complete ZIP64 end of central directory record (no extensible data). */
export const ZIP64_END_BYTES = 56;
/** A complete ZIP64 end of central directory locator. */
export const ZIP64_LOCATOR_BYTES = 20;
/** A classic end of central directory record without a comment. */
export const END_OF_CENTRAL_DIRECTORY_BYTES = 22;

/** Compression methods this archive format writes and reads. */
export type ZipMethod = 0 | 8;

/**
 * One entry of a written segment, kept as structured data so the central directory can be encoded
 * later with absolute offsets. Offsets are relative to the start of the segment that holds the
 * entry.
 */
export interface ZipEntryRecord {
  /** Entry name exactly as written (UTF-8). */
  name: string;
  /** General-purpose flags, the same in the local header and the central directory record. */
  flags: number;
  crc32: number;
  method: ZipMethod;
  compressedSize: number;
  uncompressedSize: number;
  /** Local header offset relative to the start of its segment. */
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** Error raised when the writer is asked for something the format cannot hold. */
export class ZipWriterError extends Error {
  constructor(
    readonly code:
      | 'ZIP_NAME_INVALID'
      | 'ZIP_DUPLICATE_NAME'
      | 'ZIP_ENTRY_TOO_LARGE'
      | 'ZIP_SIZE_MISMATCH'
      | 'ZIP_INDEX_INVALID'
      | 'ZIP_SEGMENT_INVALID',
    message: string
  ) {
    super(message);
    this.name = 'ZipWriterError';
  }
}

/**
 * Throw unless `name` is a relative, forward-slash path with no empty, `.` or `..` segment, no
 * backslash or control character, and at most 65,535 UTF-8 bytes. Directory entries (a trailing
 * slash) are never written.
 */
export function assertArchiveName(name: string): void {
  if (!isSafeArchiveName(name)) {
    throw new ZipWriterError('ZIP_NAME_INVALID', 'Archive entry name is not a safe relative path');
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when `name` passes {@link assertArchiveName}. Readers apply the same baseline. */
export function isSafeArchiveName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name, 'utf8') > 0xffff) return false;
  if (LONE_SURROGATE.test(name)) return false;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c /* backslash */) return false;
  }
  return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * MS-DOS time and date for a UTC instant, clamped to the range the format can express
 * (1980-01-01 to 2107-12-31). Seconds are stored in two-second steps.
 */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError('Invalid entry time');
  const year = date.getUTCFullYear();
  if (year < 1980) return { dosTime: 0, dosDate: (1 << 5) | 1 };
  if (year > 2107) {
    return {
      dosTime: (23 << 11) | (59 << 5) | 29,
      dosDate: (127 << 9) | (12 << 5) | 31,
    };
  }
  return {
    dosTime: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * Local file header (flag bit 11, UTF-8 name).
 *
 * Without `known`, the entry is streamed: flag bit 3 is set, CRC-32 and sizes are zero here and
 * follow in the data descriptor. With `known`, the header states them and no descriptor follows;
 * stored entries are written this way because a stored entry with a descriptor cannot be read
 * front to back (macOS `ditto` and Archive Utility refuse it).
 *
 * With `zip64`, the two 32-bit size fields are `0xFFFFFFFF` and a ZIP64 extra field follows the
 * name, holding the known sizes or, for a streamed entry, zeros that announce an 8-byte-size data
 * descriptor (APPNOTE 4.3.9.2).
 */
export function encodeLocalHeader(input: {
  name: string;
  method: ZipMethod;
  dosTime: number;
  dosDate: number;
  zip64: boolean;
  known?: { crc32: number; compressedSize: number; uncompressedSize: number };
}): Buffer {
  const name = Buffer.from(input.name, 'utf8');
  const extraLength = input.zip64 ? 20 : 0;
  const known = input.known;
  if (
    known &&
    !input.zip64 &&
    (known.compressedSize >= UINT32_SENTINEL || known.uncompressedSize >= UINT32_SENTINEL)
  ) {
    throw new ZipWriterError('ZIP_ENTRY_TOO_LARGE', 'Entry needs a ZIP64 local header');
  }
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + name.length + extraLength);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(localFlags(Boolean(known)), 6);
  header.writeUInt16LE(input.method, 8);
  header.writeUInt16LE(input.dosTime, 10);
  header.writeUInt16LE(input.dosDate, 12);
  header.writeUInt32LE(known ? known.crc32 >>> 0 : 0, 14);
  header.writeUInt32LE(input.zip64 ? UINT32_SENTINEL : (known?.compressedSize ?? 0), 18);
  header.writeUInt32LE(input.zip64 ? UINT32_SENTINEL : (known?.uncompressedSize ?? 0), 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extraLength, 28);
  name.copy(header, LOCAL_HEADER_BYTES);
  if (input.zip64) {
    const extra = LOCAL_HEADER_BYTES + name.length;
    header.writeUInt16LE(ZIP64_EXTRA_ID, extra);
    header.writeUInt16LE(16, extra + 2);
    header.writeBigUInt64LE(BigInt(known?.uncompressedSize ?? 0), extra + 4);
    header.writeBigUInt64LE(BigInt(known?.compressedSize ?? 0), extra + 12);
  }
  return header;
}

/** General-purpose flags of an entry whose CRC-32 and sizes are, or are not, known up front. */
export function localFlags(known: boolean): number {
  return known ? FLAG_UTF8 : FLAG_DATA_DESCRIPTOR | FLAG_UTF8;
}

/** Data descriptor with its optional signature; 8-byte sizes when `zip64`. */
export function encodeDataDescriptor(input: {
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  zip64: boolean;
}): Buffer {
  if (input.zip64) {
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
    descriptor.writeUInt32LE(input.crc32 >>> 0, 4);
    descriptor.writeBigUInt64LE(BigInt(input.compressedSize), 8);
    descriptor.writeBigUInt64LE(BigInt(input.uncompressedSize), 16);
    return descriptor;
  }
  if (input.compressedSize >= UINT32_SENTINEL || input.uncompressedSize >= UINT32_SENTINEL) {
    throw new ZipWriterError('ZIP_ENTRY_TOO_LARGE', 'Entry needs a ZIP64 data descriptor');
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(input.crc32 >>> 0, 4);
  descriptor.writeUInt32LE(input.compressedSize, 8);
  descriptor.writeUInt32LE(input.uncompressedSize, 12);
  return descriptor;
}

/**
 * Central directory record. It ALWAYS carries the ZIP64 extended information extra field with the
 * uncompressed size, compressed size and local header offset, and sets the three 32-bit fields to
 * `0xFFFFFFFF` whatever the values, so every record has one shape.
 */
export function encodeCentralDirectoryRecord(
  record: ZipEntryRecord,
  absoluteOffset: number
): Buffer {
  const name = Buffer.from(record.name, 'utf8');
  const extraLength = 28;
  const buffer = Buffer.alloc(CENTRAL_DIRECTORY_RECORD_BYTES + name.length + extraLength);
  buffer.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  buffer.writeUInt16LE(VERSION_MADE_BY, 4);
  buffer.writeUInt16LE(VERSION_NEEDED, 6);
  buffer.writeUInt16LE(record.flags, 8);
  buffer.writeUInt16LE(record.method, 10);
  buffer.writeUInt16LE(record.dosTime, 12);
  buffer.writeUInt16LE(record.dosDate, 14);
  buffer.writeUInt32LE(record.crc32 >>> 0, 16);
  buffer.writeUInt32LE(UINT32_SENTINEL, 20);
  buffer.writeUInt32LE(UINT32_SENTINEL, 24);
  buffer.writeUInt16LE(name.length, 28);
  buffer.writeUInt16LE(extraLength, 30);
  buffer.writeUInt16LE(0, 32); // comment length
  buffer.writeUInt16LE(0, 34); // disk number start
  buffer.writeUInt16LE(0, 36); // internal attributes
  buffer.writeUInt32LE(REGULAR_FILE_ATTRIBUTES, 38);
  buffer.writeUInt32LE(UINT32_SENTINEL, 42);
  name.copy(buffer, CENTRAL_DIRECTORY_RECORD_BYTES);
  const extra = CENTRAL_DIRECTORY_RECORD_BYTES + name.length;
  buffer.writeUInt16LE(ZIP64_EXTRA_ID, extra);
  buffer.writeUInt16LE(24, extra + 2);
  buffer.writeBigUInt64LE(BigInt(record.uncompressedSize), extra + 4);
  buffer.writeBigUInt64LE(BigInt(record.compressedSize), extra + 12);
  buffer.writeBigUInt64LE(BigInt(absoluteOffset), extra + 20);
  return buffer;
}

/** Totals the three end records describe. */
export interface CentralDirectoryTotals {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}

/** ZIP64 end of central directory record (APPNOTE 4.3.14), with no extensible data. */
export function encodeZip64EndRecord(totals: CentralDirectoryTotals): Buffer {
  const buffer = Buffer.alloc(ZIP64_END_BYTES);
  buffer.writeUInt32LE(ZIP64_END_SIGNATURE, 0);
  buffer.writeBigUInt64LE(BigInt(ZIP64_END_BYTES - 12), 4);
  buffer.writeUInt16LE(VERSION_MADE_BY, 12);
  buffer.writeUInt16LE(VERSION_NEEDED, 14);
  buffer.writeUInt32LE(0, 16); // this disk
  buffer.writeUInt32LE(0, 20); // disk with the central directory
  buffer.writeBigUInt64LE(BigInt(totals.entryCount), 24);
  buffer.writeBigUInt64LE(BigInt(totals.entryCount), 32);
  buffer.writeBigUInt64LE(BigInt(totals.centralDirectorySize), 40);
  buffer.writeBigUInt64LE(BigInt(totals.centralDirectoryOffset), 48);
  return buffer;
}

/** ZIP64 end of central directory locator (APPNOTE 4.3.15). */
export function encodeZip64Locator(zip64EndOffset: number): Buffer {
  const buffer = Buffer.alloc(ZIP64_LOCATOR_BYTES);
  buffer.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
  buffer.writeUInt32LE(0, 4);
  buffer.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
  buffer.writeUInt32LE(1, 16);
  return buffer;
}

/**
 * Classic end of central directory record (APPNOTE 4.3.16). A value that does not fit its field
 * holds the sentinel, and readers take the real one from the ZIP64 end record that always precedes
 * it.
 */
export function encodeEndOfCentralDirectory(totals: CentralDirectoryTotals): Buffer {
  const buffer = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_BYTES);
  const count = Math.min(totals.entryCount, UINT16_SENTINEL);
  buffer.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(Math.min(totals.centralDirectorySize, UINT32_SENTINEL), 12);
  buffer.writeUInt32LE(Math.min(totals.centralDirectoryOffset, UINT32_SENTINEL), 16);
  buffer.writeUInt16LE(0, 20);
  return buffer;
}

const INDEX_MAGIC = Buffer.from('ZIX1', 'ascii');
const INDEX_ENTRY_FIXED_BYTES = 2 + 2 + 4 + 1 + 2 + 2 + 8 + 8 + 8;

/**
 * Encode a segment's entry records as a compact binary list (`export_segments.entries_index`):
 * the magic `ZIX1`, a 32-bit count, then per entry the name length and UTF-8 name, flags, CRC-32,
 * method, DOS time and date, compressed size, uncompressed size and relative offset.
 */
export function encodeEntriesIndex(entries: readonly ZipEntryRecord[]): Buffer {
  const names = entries.map((entry) => Buffer.from(entry.name, 'utf8'));
  const total =
    INDEX_MAGIC.length +
    4 +
    names.reduce((sum, name) => sum + INDEX_ENTRY_FIXED_BYTES + name.length, 0);
  const buffer = Buffer.alloc(total);
  INDEX_MAGIC.copy(buffer, 0);
  buffer.writeUInt32LE(entries.length, 4);
  let at = 8;
  entries.forEach((entry, index) => {
    const name = names[index];
    if (name.length > 0xffff) throw new ZipWriterError('ZIP_NAME_INVALID', 'Name too long');
    buffer.writeUInt16LE(name.length, at);
    name.copy(buffer, at + 2);
    at += 2 + name.length;
    buffer.writeUInt16LE(entry.flags, at);
    buffer.writeUInt32LE(entry.crc32 >>> 0, at + 2);
    buffer.writeUInt8(entry.method, at + 6);
    buffer.writeUInt16LE(entry.dosTime, at + 7);
    buffer.writeUInt16LE(entry.dosDate, at + 9);
    buffer.writeBigUInt64LE(BigInt(entry.compressedSize), at + 11);
    buffer.writeBigUInt64LE(BigInt(entry.uncompressedSize), at + 19);
    buffer.writeBigUInt64LE(BigInt(entry.offset), at + 27);
    at += INDEX_ENTRY_FIXED_BYTES - 2;
  });
  return buffer;
}

/** Decode {@link encodeEntriesIndex} output, refusing anything truncated, padded or malformed. */
export function decodeEntriesIndex(buffer: Uint8Array): ZipEntryRecord[] {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const invalid = () => new ZipWriterError('ZIP_INDEX_INVALID', 'Segment entry index is invalid');
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(INDEX_MAGIC)) throw invalid();
  const count = bytes.readUInt32LE(4);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ZipEntryRecord[] = [];
  let at = 8;
  for (let index = 0; index < count; index++) {
    if (at + 2 > bytes.length) throw invalid();
    const nameLength = bytes.readUInt16LE(at);
    at += 2;
    if (at + nameLength + INDEX_ENTRY_FIXED_BYTES - 2 > bytes.length) throw invalid();
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(at, at + nameLength));
    } catch {
      throw invalid();
    }
    at += nameLength;
    const flags = bytes.readUInt16LE(at);
    const method = bytes.readUInt8(at + 6);
    if (method !== 0 && method !== 8) throw invalid();
    if (flags !== localFlags(true) && flags !== localFlags(false)) throw invalid();
    const compressedSize = toSafeNumber(bytes.readBigUInt64LE(at + 11));
    const uncompressedSize = toSafeNumber(bytes.readBigUInt64LE(at + 19));
    const offset = toSafeNumber(bytes.readBigUInt64LE(at + 27));
    if (compressedSize === null || uncompressedSize === null || offset === null) throw invalid();
    entries.push({
      name,
      flags,
      crc32: bytes.readUInt32LE(at + 2),
      method,
      dosTime: bytes.readUInt16LE(at + 7),
      dosDate: bytes.readUInt16LE(at + 9),
      compressedSize,
      uncompressedSize,
      offset,
    });
    at += INDEX_ENTRY_FIXED_BYTES - 2;
  }
  if (at !== bytes.length) throw invalid();
  return entries;
}

/** A 64-bit field as a number, or null when it is beyond `Number.MAX_SAFE_INTEGER`. */
export function toSafeNumber(value: bigint): number | null {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}
