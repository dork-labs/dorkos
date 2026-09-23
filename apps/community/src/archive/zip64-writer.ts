import { createDeflateRaw, crc32 } from 'node:zlib';
import { chunksOf, coalesce, throughTransform, type ByteSource } from './streams.js';
import {
  assertArchiveName,
  encodeCentralDirectoryRecord,
  encodeDataDescriptor,
  encodeEndOfCentralDirectory,
  encodeLocalHeader,
  encodeZip64EndRecord,
  encodeZip64Locator,
  localFlags,
  toDosDateTime,
  UINT32_SENTINEL,
  ZipWriterError,
  type ZipEntryRecord,
} from './zip-format.js';

/** One entry to write. Stored entries keep their bytes as-is; deflated entries use raw deflate. */
export interface ZipEntryInput {
  /** Relative forward-slash path; validated with `assertArchiveName`. */
  name: string;
  method: 'stored' | 'deflated';
  source: ByteSource;
  /**
   * The uncompressed size when it is known up front (a stored file's `byte_size`). The written
   * size must equal it, and a size of 4 GiB or more selects the ZIP64 local header and data
   * descriptor. Without it an entry is limited to 4 GiB - 1 byte.
   *
   * A stored entry of known size up to {@link STORED_BUFFER_LIMIT} is read into memory first so
   * its local header can state the CRC-32 and size with no data descriptor after it: a stored
   * entry with a descriptor cannot be read front to back, and macOS `ditto` refuses it.
   */
  size?: number;
  /** Modification time stored in the entry; defaults to the writer's `modifiedAt`. */
  modifiedAt?: Date;
}

/** Options shared by the segment and tail writers. */
export interface ZipWriterOptions {
  /** Default modification time. Pass one for byte-identical output across runs. */
  modifiedAt?: Date;
  /**
   * Test hook: write every entry with a ZIP64 local header and an 8-byte-size data descriptor,
   * so small archives exercise the paths large ones take.
   */
  forceZip64?: boolean;
}

/** What a finished segment holds. */
export interface ZipSegmentSummary {
  byteSize: number;
  /** Structured central-directory rows, offsets relative to the segment start. */
  entries: ZipEntryRecord[];
}

/** A segment being written: consume `bytes` once, then read `summary()`. */
export interface ZipSegmentWriter {
  readonly bytes: AsyncIterable<Uint8Array>;
  summary(): ZipSegmentSummary;
}

/** A finished segment as the tail needs it. */
export interface ZipSegmentLayout {
  byteSize: number;
  entries: readonly ZipEntryRecord[];
}

/** Input to {@link writeZipTail}. */
export interface ZipTailInput {
  /** Every earlier segment, in archive order. */
  segments: readonly ZipSegmentLayout[];
  /** Entries written in the tail before the central directory (`manifest.json` last). */
  entries?: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>;
}

/** What a finished tail holds. */
export interface ZipTailSummary {
  byteSize: number;
  /** The tail's own entries, offsets relative to the tail start. */
  entries: ZipEntryRecord[];
  /** Entries in the whole archive. */
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}

/**
 * A tail being written. Consume either `bytes` or `parts(...)`, once, then read `summary()`.
 */
export interface ZipTailWriter {
  readonly bytes: AsyncIterable<Uint8Array>;
  /**
   * Split the tail into consecutive parts of about `targetBytes`. A part is closed only where a
   * local header, a central directory record, or the ZIP64 end record starts, so every part begins
   * with a ZIP signature; a part may exceed the target by the unit that crosses it. Consume each
   * part fully before asking for the next.
   */
  parts(targetBytes: number): AsyncIterable<AsyncIterable<Uint8Array>>;
  summary(): ZipTailSummary;
}

/**
 * Largest stored entry that is buffered to write a complete local header. Community files are at
 * most 25 MiB, so every attachment and icon takes this path.
 */
export const STORED_BUFFER_LIMIT = 64 * 1024 * 1024;

interface Unit {
  chunk: Uint8Array;
  /** True on the first chunk of a local entry, a central directory record, or the end records. */
  boundary: boolean;
}

interface WriteState {
  offset: number;
  records: ZipEntryRecord[];
  names: Set<string>;
}

/**
 * Write one segment of a ZIP64 archive: whole entries only, so its first bytes are a local file
 * header. The central directory is never written here; the segment's structured entry rows come
 * back from `summary()` and the tail encodes them once every segment's size is final.
 */
export function writeZipSegment(
  entries: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>,
  options: ZipWriterOptions = {}
): ZipSegmentWriter {
  const state: WriteState = { offset: 0, records: [], names: new Set() };
  const defaults = resolveOptions(options);
  let finished = false;
  const bytes = once(async function* () {
    // Large chunks (stored file bytes) pass through untouched; headers and descriptors coalesce.
    yield* coalesce(chunks(writeEntries(entries, state, defaults)));
    if (state.records.length === 0) {
      throw new ZipWriterError('ZIP_SEGMENT_INVALID', 'A segment holds at least one entry');
    }
    finished = true;
  });
  return {
    bytes,
    summary() {
      if (!finished) throw new Error('The segment has not been written yet');
      return { byteSize: state.offset, entries: [...state.records] };
    },
  };
}

/**
 * Write the tail of a segmented ZIP64 archive: its own entries, then the central directory
 * encoded from every segment's rows with absolute offsets (segment start + relative offset), then
 * the ZIP64 end record, its locator, and the classic end record. Rewriting one segment only means
 * writing the tail again with that segment's new layout.
 */
export function writeZipTail(input: ZipTailInput, options: ZipWriterOptions = {}): ZipTailWriter {
  const defaults = resolveOptions(options);
  const names = new Set<string>();
  let tailStart = 0;
  for (const segment of input.segments) {
    if (!Number.isSafeInteger(segment.byteSize) || segment.byteSize < 1) {
      throw new ZipWriterError('ZIP_SEGMENT_INVALID', 'Segment size is invalid');
    }
    for (const entry of segment.entries) {
      assertArchiveName(entry.name);
      if (names.has(entry.name)) {
        throw new ZipWriterError('ZIP_DUPLICATE_NAME', 'Archive entry names must be unique');
      }
      names.add(entry.name);
      if (
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        entry.offset >= segment.byteSize
      ) {
        throw new ZipWriterError('ZIP_SEGMENT_INVALID', 'Entry offset is outside its segment');
      }
    }
    tailStart += segment.byteSize;
  }
  if (!Number.isSafeInteger(tailStart)) {
    throw new ZipWriterError('ZIP_SEGMENT_INVALID', 'Archive is too large');
  }
  const state: WriteState = { offset: 0, records: [], names };
  let summary: ZipTailSummary | undefined;

  async function* units(): AsyncGenerator<Unit> {
    yield* writeEntries(input.entries ?? [], state, defaults);
    const centralDirectoryOffset = tailStart + state.offset;
    let centralDirectorySize = 0;
    let entryCount = 0;
    let segmentStart = 0;
    const layouts: ZipSegmentLayout[] = [
      ...input.segments,
      { byteSize: state.offset, entries: state.records },
    ];
    for (const layout of layouts) {
      for (const entry of layout.entries) {
        const record = encodeCentralDirectoryRecord(entry, segmentStart + entry.offset);
        centralDirectorySize += record.length;
        entryCount++;
        yield { chunk: record, boundary: true };
      }
      segmentStart += layout.byteSize;
    }
    if (entryCount === 0) {
      throw new ZipWriterError('ZIP_SEGMENT_INVALID', 'An archive holds at least one entry');
    }
    const totals = { entryCount, centralDirectorySize, centralDirectoryOffset };
    const zip64EndOffset = centralDirectoryOffset + centralDirectorySize;
    const end = Buffer.concat([
      encodeZip64EndRecord(totals),
      encodeZip64Locator(zip64EndOffset),
      encodeEndOfCentralDirectory(totals),
    ]);
    yield { chunk: end, boundary: true };
    summary = {
      byteSize: state.offset + centralDirectorySize + end.length,
      entries: [...state.records],
      entryCount,
      centralDirectoryOffset,
      centralDirectorySize,
    };
  }

  let used = false;
  const claim = () => {
    if (used) throw new Error('A tail writer is consumed once');
    used = true;
  };
  return {
    bytes: {
      [Symbol.asyncIterator]() {
        claim();
        return coalesce(chunks(units()), 64 * 1024)[Symbol.asyncIterator]();
      },
    },
    parts(targetBytes: number) {
      if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) {
        throw new RangeError('Part size must be a positive integer');
      }
      claim();
      return splitAtBoundaries(units(), targetBytes);
    },
    summary() {
      if (!summary) throw new Error('The tail has not been written yet');
      return summary;
    },
  };
}

async function* writeEntries(
  entries: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>,
  state: WriteState,
  options: Required<ZipWriterOptions>
): AsyncGenerator<Unit> {
  for await (const entry of entries) {
    assertArchiveName(entry.name);
    if (state.names.has(entry.name)) {
      throw new ZipWriterError('ZIP_DUPLICATE_NAME', 'Archive entry names must be unique');
    }
    state.names.add(entry.name);
    if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
      throw new RangeError('Entry size must be a non-negative integer');
    }
    const method = entry.method === 'stored' ? 0 : 8;
    const zip64 = options.forceZip64 || (entry.size !== undefined && entry.size >= UINT32_SENTINEL);
    const { dosTime, dosDate } = toDosDateTime(entry.modifiedAt ?? options.modifiedAt);
    const offset = state.offset;
    const record = { name: entry.name, method, offset, dosTime, dosDate } as const;

    if (method === 0 && entry.size !== undefined && entry.size <= STORED_BUFFER_LIMIT) {
      const data = await readDeclared(entry.source, entry.size);
      const known = {
        crc32: crc32(data) >>> 0,
        compressedSize: data.length,
        uncompressedSize: data.length,
      };
      const header = encodeLocalHeader({ ...record, zip64, known });
      state.offset += header.length + data.length;
      yield { chunk: header, boundary: true };
      if (data.length > 0) yield { chunk: data, boundary: false };
      state.records.push({ ...record, ...known, flags: localFlags(true) });
      continue;
    }

    const header = encodeLocalHeader({ ...record, zip64 });
    state.offset += header.length;
    yield { chunk: header, boundary: true };

    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const input = (async function* () {
      for await (const chunk of chunksOf(entry.source)) {
        crc = crc32(chunk, crc);
        uncompressedSize += chunk.length;
        if (entry.size !== undefined && uncompressedSize > entry.size) {
          throw new ZipWriterError('ZIP_SIZE_MISMATCH', 'Entry is longer than its declared size');
        }
        yield chunk;
      }
    })();
    const output = method === 0 ? input : throughTransform(input, createDeflateRaw());
    for await (const chunk of output) {
      if (chunk.length === 0) continue;
      compressedSize += chunk.length;
      state.offset += chunk.length;
      yield { chunk, boundary: false };
    }
    if (entry.size !== undefined && uncompressedSize !== entry.size) {
      throw new ZipWriterError('ZIP_SIZE_MISMATCH', 'Entry is shorter than its declared size');
    }
    const descriptor = encodeDataDescriptor({
      crc32: crc,
      compressedSize,
      uncompressedSize,
      zip64,
    });
    state.offset += descriptor.length;
    yield { chunk: descriptor, boundary: false };
    state.records.push({
      ...record,
      flags: localFlags(false),
      crc32: crc >>> 0,
      compressedSize,
      uncompressedSize,
    });
  }
}

async function readDeclared(source: ByteSource, size: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunksOf(source)) {
    total += chunk.length;
    if (total > size) {
      throw new ZipWriterError('ZIP_SIZE_MISMATCH', 'Entry is longer than its declared size');
    }
    chunks.push(chunk);
  }
  if (total !== size) {
    throw new ZipWriterError('ZIP_SIZE_MISMATCH', 'Entry is shorter than its declared size');
  }
  return Buffer.concat(chunks, total);
}

async function* splitAtBoundaries(
  units: AsyncGenerator<Unit>,
  targetBytes: number
): AsyncGenerator<AsyncIterable<Uint8Array>> {
  let next = await units.next();
  while (!next.done) {
    let partBytes = 0;
    let drained = false;
    const part = async function* () {
      while (!next.done) {
        const unit: Unit = next.value;
        if (unit.boundary && partBytes >= targetBytes) break;
        partBytes += unit.chunk.length;
        yield unit.chunk;
        next = await units.next();
      }
      drained = true;
    };
    yield coalesce(part());
    if (!drained) throw new Error('Consume each tail part fully before the next');
  }
}

async function* chunks(units: AsyncIterable<Unit>): AsyncGenerator<Uint8Array> {
  for await (const unit of units) yield unit.chunk;
}

function once(factory: () => AsyncGenerator<Uint8Array>): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) throw new Error('A segment writer is consumed once');
      used = true;
      return factory();
    },
  };
}

function resolveOptions(options: ZipWriterOptions): Required<ZipWriterOptions> {
  return {
    modifiedAt: options.modifiedAt ?? new Date(),
    forceZip64: options.forceZip64 ?? false,
  };
}
