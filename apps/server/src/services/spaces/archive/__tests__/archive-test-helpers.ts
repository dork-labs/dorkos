import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { RangeReader } from '../segmented-source.js';
import { collectBytes } from '../streams.js';
import { openZipArchive } from '../zip-reader.js';
import {
  writeZipSegment,
  writeZipTail,
  type ZipEntryInput,
  type ZipSegmentSummary,
  type ZipWriterOptions,
} from '../zip64-writer.js';

/** Fixed entry time so archives are byte-identical across runs. */
export const FIXED_TIME = new Date('2026-09-23T12:34:56Z');

/** Random access over an in-memory archive. */
export function bufferReader(buffer: Buffer): RangeReader {
  return {
    size: buffer.length,
    async *read(start, end) {
      if (start < 0 || end >= buffer.length || end < start) throw new RangeError('bad range');
      // Serve in small chunks so record parsing crosses chunk boundaries.
      for (let at = start; at <= end; at += 4099) {
        yield buffer.subarray(at, Math.min(end + 1, at + 4099));
      }
    },
  };
}

/** One recorded write of a sparse archive: `bytes` at logical `offset`. */
export interface SparsePiece {
  offset: number;
  bytes: Uint8Array;
}

/**
 * Consume a byte stream without storing it: each chunk is kept by reference, so a synthetic source
 * that yields the same buffer thousands of times costs one buffer of memory.
 */
export async function recordSparse(
  source: AsyncIterable<Uint8Array>,
  pieces: SparsePiece[],
  start: number
): Promise<number> {
  let offset = start;
  for await (const chunk of source) {
    pieces.push({ offset, bytes: chunk });
    offset += chunk.length;
  }
  return offset;
}

/** Random access over recorded pieces (contiguous, in order). */
export function sparseReader(pieces: readonly SparsePiece[], size: number): RangeReader {
  const starts = pieces.map((piece) => piece.offset);
  const indexAt = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  return {
    size,
    async *read(start, end) {
      if (start < 0 || end >= size || end < start) throw new RangeError('bad range');
      for (let index = indexAt(start); index < pieces.length; index++) {
        const piece = pieces[index];
        if (piece.offset > end) break;
        const from = Math.max(start, piece.offset) - piece.offset;
        const to = Math.min(end + 1, piece.offset + piece.bytes.length) - piece.offset;
        if (to > from) yield piece.bytes.subarray(from, to);
      }
    },
  };
}

/** A written multi-segment archive. */
export interface WrittenArchive {
  segments: Buffer[];
  layouts: ZipSegmentSummary[];
  tail: Buffer;
  archive: Buffer;
}

/** Write each group of entries as its own segment, then a tail, and concatenate them. */
export async function writeArchive(
  groups: ZipEntryInput[][],
  tailEntries: ZipEntryInput[],
  options: ZipWriterOptions = { modifiedAt: FIXED_TIME }
): Promise<WrittenArchive> {
  const segments: Buffer[] = [];
  const layouts: ZipSegmentSummary[] = [];
  for (const group of groups) {
    const writer = writeZipSegment(group, options);
    segments.push(await collectBytes(writer.bytes));
    layouts.push(writer.summary());
  }
  const tailWriter = writeZipTail({ segments: layouts, entries: tailEntries }, options);
  const tail = await collectBytes(tailWriter.bytes);
  return { segments, layouts, tail, archive: Buffer.concat([...segments, tail]) };
}

/** What yauzl reports for one entry. */
export interface YauzlEntry {
  name: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
}

class RangeAdapter extends yauzl.RandomAccessReader {
  constructor(private readonly source: RangeReader) {
    super();
  }

  _readStreamForRange(start: number, end: number) {
    if (end <= start) return Readable.from([]);
    return Readable.from(this.source.read(start, end - 1));
  }
}

function openWithYauzl(source: RangeReader): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new RangeAdapter(source),
      source.size,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? reject(error) : resolve(zip))
    );
  });
}

/**
 * Read an archive with yauzl, an independent ZIP64 implementation: list every entry and read the
 * bytes of those `wanted` selects.
 */
export async function readWithYauzl(
  source: RangeReader,
  wanted: (name: string) => boolean = () => true
): Promise<{ entries: YauzlEntry[]; contents: Map<string, Buffer> }> {
  const zip = await openWithYauzl(source);
  const entries: YauzlEntry[] = [];
  const contents = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push({
        name: entry.fileName,
        offset: entry.relativeOffsetOfLocalHeader,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
      });
      if (!wanted(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        collectBytes(stream).then((bytes) => {
          contents.set(entry.fileName, bytes);
          zip.readEntry();
        }, reject);
      });
    });
    zip.readEntry();
  });
  zip.close();
  return { entries, contents };
}

/** Read an archive with our reader: every entry, and the bytes of those `wanted` selects. */
export async function readWithOurReader(
  source: RangeReader,
  wanted: (name: string) => boolean = () => true,
  allowName: (name: string) => boolean = () => true
): Promise<{ entries: { name: string; offset: number }[]; contents: Map<string, Buffer> }> {
  const archive = await openZipArchive(source, { allowName });
  const all = [];
  for await (const entry of archive.entries()) all.push(entry);
  const contents = new Map<string, Buffer>();
  for (const entry of all) {
    if (wanted(entry.name)) contents.set(entry.name, await collectBytes(archive.openEntry(entry)));
  }
  return {
    entries: all.map((entry) => ({ name: entry.name, offset: entry.localHeaderOffset })),
    contents,
  };
}
