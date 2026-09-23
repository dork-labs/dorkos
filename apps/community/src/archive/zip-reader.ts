import { createHash } from 'node:crypto';
import { createInflateRaw, crc32 } from 'node:zlib';
import type { RangeReader } from './segmented-source.js';
import { chunksOf, throughTransform } from './streams.js';
import { corrupt, locateCentralDirectory, readExact, ZipReaderError } from './zip-end-records.js';
import {
  CENTRAL_DIRECTORY_RECORD_BYTES,
  CENTRAL_DIRECTORY_SIGNATURE,
  FLAG_DATA_DESCRIPTOR,
  FLAG_ENCRYPTED,
  FLAG_STRONG_ENCRYPTION,
  FLAG_UTF8,
  archiveNameKey,
  isSafeArchiveName,
  LOCAL_FILE_HEADER_SIGNATURE,
  LOCAL_HEADER_BYTES,
  toSafeNumber,
  UINT16_SENTINEL,
  UINT32_SENTINEL,
  ZIP64_EXTRA_ID,
  type ZipMethod,
} from './zip-format.js';

export { ZipReaderError, type ZipReaderErrorCode } from './zip-end-records.js';

/** One entry as its central directory record describes it. Frozen. */
export interface ZipEntry {
  readonly name: string;
  readonly method: ZipMethod;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** What the caller allows. */
export interface ZipReaderOptions {
  /**
   * Accept or refuse an entry name. It runs after the built-in refusals (directories, absolute
   * paths, `.` and `..` segments, backslashes, control characters, invalid UTF-8), so it only has
   * to state what a valid archive of the caller's kind contains.
   */
  allowName(name: string): boolean;
  /**
   * Most entries the archive may declare, checked before the directory is read. Defaults to
   * {@link DEFAULT_MAX_ENTRIES}; at most {@link MAX_ENTRIES_CEILING}, since the duplicate check
   * keeps one small key per entry.
   */
  maxEntries?: number;
  /** Largest uncompressed size one entry may declare. Unlimited when omitted. */
  maxEntryBytes?: number;
  /** Largest total uncompressed size of every entry. Unlimited when omitted. */
  maxTotalBytes?: number;
  signal?: AbortSignal;
}

/** Entries an archive may declare unless the caller sets `maxEntries`. */
export const DEFAULT_MAX_ENTRIES = 1_000_000;
/** The highest `maxEntries` a caller may set. */
export const MAX_ENTRIES_CEILING = 10_000_000;
/**
 * Raw deflate cannot expand input by more than about 1032 to 1, so a declared size beyond this
 * ratio (plus slack for tiny entries) is a bomb, refused before a byte is inflated.
 */
const MAX_DEFLATE_RATIO = 1032;

/**
 * Open a zip archive (a version 1 export written by fflate, or a segmented ZIP64 export) through
 * its central directory over ranged reads. Only the end records are read here; call
 * {@link ZipArchive.entries} to stream and validate the central directory.
 */
export async function openZipArchive(
  source: RangeReader,
  options: ZipReaderOptions
): Promise<ZipArchive> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES_CEILING) {
    throw new RangeError('maxEntries must be an integer from 1 to MAX_ENTRIES_CEILING');
  }
  const location = await locateCentralDirectory(source, options.signal);
  if (location.entryCount > maxEntries) {
    throw new ZipReaderError('ZIP_TOO_MANY_ENTRIES', 'The archive declares too many entries');
  }
  return new ZipArchive(
    source,
    options,
    location.entryCount,
    location.centralDirectoryOffset,
    location.centralDirectorySize
  );
}

/**
 * An opened archive. Stream the central directory with {@link entries}, then read entries with
 * {@link openEntry}. Global checks (entry count, overlapping entries) finish when the last entry
 * has been yielded, so no entry can be opened before a complete, successful pass.
 */
export class ZipArchive {
  private sortedStarts: Float64Array | null = null;
  private readonly issued = new WeakSet<ZipEntry>();

  constructor(
    private readonly source: RangeReader,
    private readonly options: ZipReaderOptions,
    /** Entries the end records declare. */
    readonly entryCount: number,
    readonly centralDirectoryOffset: number,
    readonly centralDirectorySize: number
  ) {}

  /**
   * Stream and validate the central directory without holding its records: each entry is checked
   * as it is read (encryption, method, name rules, duplicates by name digest, ZIP64 fields, size
   * limits), and the count and overlap checks run after the last one.
   *
   * Nothing yielded here is trustworthy until the generator completes without an error: a later
   * record can still reveal a duplicate, an overlap, or a count that disagrees with the end
   * records. Callers must finish the pass before acting on any entry; {@link openEntry} enforces
   * this.
   */
  async *entries(): AsyncGenerator<ZipEntry> {
    const digests = new Set<string>();
    let totalBytes = 0;
    // While offsets ascend (every archive we write), overlaps are refused as they appear.
    let ascending = true;
    let previousStart = -1;
    let previousEnd = -1;
    let starts: Float64Array = new Float64Array(Math.min(this.entryCount, 1 << 16) || 1);
    let ends: Float64Array = new Float64Array(starts.length);
    let count = 0;
    let pending: Buffer = Buffer.alloc(0);
    const stream =
      this.centralDirectorySize > 0
        ? this.source.read(
            this.centralDirectoryOffset,
            this.centralDirectoryOffset + this.centralDirectorySize - 1,
            { signal: this.options.signal }
          )
        : [];
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      pending = pending.length > 0 ? Buffer.concat([pending, bytes]) : bytes;
      let at = 0;
      while (pending.length - at >= CENTRAL_DIRECTORY_RECORD_BYTES) {
        if (pending.readUInt32LE(at) !== CENTRAL_DIRECTORY_SIGNATURE) {
          throw corrupt('A central directory record is missing its signature');
        }
        const length =
          CENTRAL_DIRECTORY_RECORD_BYTES +
          pending.readUInt16LE(at + 28) +
          pending.readUInt16LE(at + 30) +
          pending.readUInt16LE(at + 32);
        if (pending.length - at < length) break;
        const { entry, nameLength } = this.parseRecord(pending.subarray(at, at + length));
        at += length;
        if (++count > this.entryCount) throw corrupt('More entries than the end record declares');
        const digest = createHash('sha256')
          .update(archiveNameKey(entry.name))
          .digest('base64')
          .slice(0, 22);
        if (digests.has(digest)) {
          throw new ZipReaderError('ZIP_DUPLICATE_NAME', 'Two entries have the same name');
        }
        digests.add(digest);
        // The smallest span the entry can occupy: its local header, name, and data.
        const end =
          entry.localHeaderOffset + LOCAL_HEADER_BYTES + nameLength + entry.compressedSize;
        if (end > this.centralDirectoryOffset) {
          throw new ZipReaderError('ZIP_OVERLAPPING_ENTRIES', 'An entry runs into the directory');
        }
        if (ascending && entry.localHeaderOffset < previousStart) ascending = false;
        if (ascending && entry.localHeaderOffset < previousEnd) {
          throw new ZipReaderError('ZIP_OVERLAPPING_ENTRIES', 'Two entries overlap');
        }
        previousStart = entry.localHeaderOffset;
        previousEnd = end;
        totalBytes += entry.uncompressedSize;
        if (
          (this.options.maxEntryBytes !== undefined &&
            entry.uncompressedSize > this.options.maxEntryBytes) ||
          (this.options.maxTotalBytes !== undefined && totalBytes > this.options.maxTotalBytes)
        ) {
          throw new ZipReaderError('ZIP_TOO_LARGE', 'The archive is larger than allowed');
        }
        if (count > starts.length) {
          starts = grow(starts);
          ends = grow(ends);
        }
        starts[count - 1] = entry.localHeaderOffset;
        ends[count - 1] = end;
        this.issued.add(entry);
        yield entry;
      }
      pending = at > 0 ? Buffer.from(pending.subarray(at)) : pending;
    }
    if (pending.length > 0 || count !== this.entryCount) {
      throw corrupt('The central directory does not match its end record');
    }
    this.sortedStarts = checkOverlaps(starts.subarray(0, count), ends.subarray(0, count));
  }

  /**
   * Stream an entry's uncompressed bytes. The local header must agree with the central directory
   * (name, method, and any sizes it states), the data must end before the next entry starts, and
   * inflating past the declared size fails at once. The CRC-32 and exact length are checked at the
   * end, so bytes are trustworthy only once the iteration finishes without an error.
   */
  async *openEntry(entry: ZipEntry): AsyncGenerator<Uint8Array> {
    const sortedStarts = this.sortedStarts;
    if (!sortedStarts || !this.issued.has(entry)) {
      throw new Error('Open only entries from a completed pass over entries()');
    }
    const signal = this.options.signal;
    const offset = entry.localHeaderOffset;
    const index = lowerBound(sortedStarts, offset);
    const nextStart =
      index + 1 < sortedStarts.length ? sortedStarts[index + 1] : this.centralDirectoryOffset;
    const header = await readExact(this.source, offset, LOCAL_HEADER_BYTES, signal);
    if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw mismatch('A local header is missing its signature');
    }
    const flags = header.readUInt16LE(6);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipReaderError('ZIP_ENCRYPTED', 'Encrypted entries are not supported');
    }
    if (header.readUInt16LE(8) !== entry.method) {
      throw mismatch('A local header disagrees with the directory about the method');
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataStart = offset + LOCAL_HEADER_BYTES + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > nextStart) {
      throw new ZipReaderError('ZIP_OVERLAPPING_ENTRIES', 'An entry overlaps the next one');
    }
    const variable =
      nameLength + extraLength > 0
        ? await readExact(
            this.source,
            offset + LOCAL_HEADER_BYTES,
            nameLength + extraLength,
            signal
          )
        : Buffer.alloc(0);
    if (!variable.subarray(0, nameLength).equals(Buffer.from(entry.name, 'utf8'))) {
      throw mismatch('A local header disagrees with the directory about the name');
    }
    const local = resolveZip64(
      variable.subarray(nameLength),
      [header.readUInt32LE(22), header.readUInt32LE(18)],
      () => mismatch('A local header needs a ZIP64 field that is missing')
    );
    const deferred = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    const agrees = (stated: number, actual: number) =>
      stated === actual || (deferred && stated === 0);
    if (
      !agrees(header.readUInt32LE(14), entry.crc32) ||
      !agrees(local[0], entry.uncompressedSize) ||
      !agrees(local[1], entry.compressedSize)
    ) {
      throw mismatch('A local header disagrees with the directory about the sizes');
    }
    if (entry.method === 8 && entry.compressedSize === 0) {
      throw new ZipReaderError('ZIP_SIZE_MISMATCH', 'A deflated entry has no data');
    }

    const raw: AsyncIterable<Uint8Array> =
      entry.compressedSize > 0
        ? this.source.read(dataStart, dataEnd - 1, { signal })
        : chunksOf(new Uint8Array(0));
    const inflate = entry.method === 8 ? createInflateRaw() : null;
    const output = inflate ? throughTransform(raw, inflate) : raw;
    let produced = 0;
    let crc = 0;
    try {
      for await (const chunk of output) {
        produced += chunk.length;
        if (produced > entry.uncompressedSize) {
          throw new ZipReaderError('ZIP_SIZE_MISMATCH', 'An entry is larger than it declares');
        }
        crc = crc32(chunk, crc);
        yield chunk;
      }
    } catch (error) {
      if (isZlibError(error)) throw corrupt('An entry does not inflate');
      throw error;
    }
    if (produced !== entry.uncompressedSize) {
      throw new ZipReaderError('ZIP_SIZE_MISMATCH', 'An entry is smaller than it declares');
    }
    // The deflate stream must end exactly where the entry's compressed bytes end.
    if (inflate && inflate.bytesWritten !== entry.compressedSize) {
      throw corrupt('An entry has bytes after its deflate stream');
    }
    if (crc >>> 0 !== entry.crc32) {
      throw new ZipReaderError('ZIP_CRC_MISMATCH', 'An entry does not match its checksum');
    }
  }

  private parseRecord(record: Buffer): { entry: ZipEntry; nameLength: number } {
    const flags = record.readUInt16LE(8);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipReaderError('ZIP_ENCRYPTED', 'Encrypted entries are not supported');
    }
    const method = record.readUInt16LE(10);
    if (method !== 0 && method !== 8) {
      throw new ZipReaderError('ZIP_METHOD_UNSUPPORTED', 'Only stored and deflated entries');
    }
    const nameLength = record.readUInt16LE(28);
    const extraLength = record.readUInt16LE(30);
    const nameBytes = record.subarray(
      CENTRAL_DIRECTORY_RECORD_BYTES,
      CENTRAL_DIRECTORY_RECORD_BYTES + nameLength
    );
    const name = decodeName(nameBytes, flags);
    if (name.endsWith('/')) {
      throw new ZipReaderError('ZIP_DIRECTORY_ENTRY', 'Directory entries are not accepted');
    }
    if (!isSafeArchiveName(name) || !this.options.allowName(name)) {
      throw new ZipReaderError('ZIP_NAME_REJECTED', 'An entry name is not allowed');
    }
    const extra = record.subarray(
      CENTRAL_DIRECTORY_RECORD_BYTES + nameLength,
      CENTRAL_DIRECTORY_RECORD_BYTES + nameLength + extraLength
    );
    const [uncompressedSize, compressedSize, localHeaderOffset, diskStart] = resolveZip64(
      extra,
      [
        record.readUInt32LE(24),
        record.readUInt32LE(20),
        record.readUInt32LE(42),
        record.readUInt16LE(34),
      ],
      () => corrupt('A directory record needs a ZIP64 field that is missing')
    );
    if (diskStart !== 0) {
      throw new ZipReaderError('ZIP_UNSUPPORTED', 'Multi-disk archives are not supported');
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new ZipReaderError('ZIP_SIZE_MISMATCH', 'A stored entry has two different sizes');
    }
    if (method === 8 && uncompressedSize > compressedSize * MAX_DEFLATE_RATIO + 1024) {
      throw new ZipReaderError('ZIP_SIZE_MISMATCH', 'A deflated entry declares an impossible size');
    }
    const entry: ZipEntry = Object.freeze({
      name,
      method,
      crc32: record.readUInt32LE(16),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    return { entry, nameLength };
  }
}

/**
 * Replace sentinel values with the ZIP64 extra field's 8-byte values, which appear in APPNOTE
 * order (uncompressed size, compressed size, local header offset, then a 4-byte disk number) and
 * only for the fields that hold the sentinel. The disk number, when present, is the fourth input.
 */
function resolveZip64(extra: Buffer, fields: number[], missing: () => ZipReaderError): number[] {
  const sentinels = fields.map((value, index) =>
    index === 3 ? value === UINT16_SENTINEL : value === UINT32_SENTINEL
  );
  if (!sentinels.some(Boolean)) return fields;
  let data: Buffer | undefined;
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    if (at + 4 + size > extra.length) throw corrupt('An extra field is truncated');
    if (id === ZIP64_EXTRA_ID) {
      data = extra.subarray(at + 4, at + 4 + size);
      break;
    }
    at += 4 + size;
  }
  if (!data) throw missing();
  const resolved = [...fields];
  let at = 0;
  for (let index = 0; index < fields.length; index++) {
    if (!sentinels[index]) continue;
    const width = index === 3 ? 4 : 8;
    if (at + width > data.length) throw missing();
    const value = width === 8 ? toSafeNumber(data.readBigUInt64LE(at)) : data.readUInt32LE(at);
    if (value === null) throw corrupt('A ZIP64 value is out of range');
    resolved[index] = value;
    at += width;
  }
  return resolved;
}

function decodeName(bytes: Buffer, flags: number): string {
  if (flags & FLAG_UTF8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ZipReaderError('ZIP_NAME_REJECTED', 'An entry name is not valid UTF-8');
    }
  }
  // Without the UTF-8 flag the name is CP437; only its ASCII subset reads the same everywhere.
  if (bytes.some((byte) => byte >= 0x80)) {
    throw new ZipReaderError('ZIP_NAME_REJECTED', 'An entry name is not ASCII or UTF-8');
  }
  return bytes.toString('latin1');
}

function checkOverlaps(
  starts: Float64Array<ArrayBufferLike>,
  ends: Float64Array<ArrayBufferLike>
): Float64Array {
  let ascending = true;
  for (let index = 1; index < starts.length; index++) {
    if (starts[index] < starts[index - 1]) {
      ascending = false;
      break;
    }
  }
  let sortedStarts = starts;
  let sortedEnds = ends;
  if (!ascending) {
    const order = Array.from(starts.keys()).sort((a, b) => starts[a] - starts[b]);
    sortedStarts = Float64Array.from(order, (index) => starts[index]);
    sortedEnds = Float64Array.from(order, (index) => ends[index]);
  }
  for (let index = 1; index < sortedStarts.length; index++) {
    if (sortedEnds[index - 1] > sortedStarts[index]) {
      throw new ZipReaderError('ZIP_OVERLAPPING_ENTRIES', 'Two entries overlap');
    }
  }
  return Float64Array.from(sortedStarts);
}

function lowerBound(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function grow(array: Float64Array): Float64Array {
  const next = new Float64Array(array.length * 2);
  next.set(array);
  return next;
}

function isZlibError(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof ZipReaderError) &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('Z_')
  );
}

function mismatch(message: string) {
  return new ZipReaderError('ZIP_HEADER_MISMATCH', message);
}
