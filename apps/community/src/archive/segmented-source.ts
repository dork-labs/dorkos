import type { BlobKey } from '../storage/blob-store.js';
import type { BlobStore } from '../storage/index.js';
import { BlobStoreError } from '../storage/index.js';

/**
 * Random access to a logical byte sequence. `read` streams the inclusive range `[start, end]`;
 * the zip reader and the download route are written against this, not against blobs.
 */
export interface RangeReader {
  readonly size: number;
  read(start: number, end: number, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
}

/** One stored piece of a segmented archive. */
export interface ArchiveBlob {
  key: BlobKey;
  byteSize: number;
}

/**
 * One logical archive over consecutive blobs (an export's segments, or an import's uploaded
 * parts). A read touching several blobs makes one ranged `get` per blob, in order, and fails if a
 * blob answers with a different number of bytes than its recorded size implies.
 */
export class SegmentedBlobSource implements RangeReader {
  readonly size: number;
  private readonly blobs: readonly ArchiveBlob[];
  /** `starts[i]` is the logical offset of `blobs[i]`'s first byte. */
  private readonly starts: number[];

  constructor(
    private readonly store: BlobStore,
    blobs: readonly ArchiveBlob[]
  ) {
    let size = 0;
    const starts: number[] = [];
    for (const blob of blobs) {
      if (!Number.isSafeInteger(blob.byteSize) || blob.byteSize < 1) {
        throw new RangeError('Every archive blob has a positive size');
      }
      starts.push(size);
      size += blob.byteSize;
    }
    if (!Number.isSafeInteger(size)) throw new RangeError('Archive is too large');
    this.blobs = [...blobs];
    this.starts = starts;
    this.size = size;
  }

  /** Stream the inclusive logical range `[start, end]`. */
  async *read(
    start: number,
    end: number,
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<Uint8Array> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= this.size
    ) {
      throw new BlobStoreError('BLOB_RANGE_NOT_SATISFIABLE', 'Range is outside the archive');
    }
    for (let index = this.blobIndexAt(start); index < this.blobs.length; index++) {
      const blobStart = this.starts[index];
      if (blobStart > end) break;
      const blob = this.blobs[index];
      const localStart = Math.max(start, blobStart) - blobStart;
      const localEnd = Math.min(end, blobStart + blob.byteSize - 1) - blobStart;
      const expected = localEnd - localStart + 1;
      const read = await this.store.get(blob.key, {
        signal: options.signal,
        range: { start: localStart, end: localEnd },
      });
      let received = 0;
      try {
        for await (const chunk of read.body as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          if (received > expected) throw shortOrLong();
          yield chunk;
        }
      } finally {
        read.body.destroy();
      }
      if (received !== expected) throw shortOrLong();
    }
  }

  private blobIndexAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }
}

function shortOrLong() {
  return new BlobStoreError(
    'BLOB_RANGE_NOT_SATISFIABLE',
    'A stored archive piece is not the size it was recorded with'
  );
}
