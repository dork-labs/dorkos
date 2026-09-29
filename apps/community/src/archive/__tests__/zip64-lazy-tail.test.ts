import { describe, expect, it } from 'vitest';
import { LOCAL_HEADER_BYTES, type ZipEntryRecord } from '../zip-format.js';
import { writeZipTail, type ZipSegmentLayout } from '../zip64-writer.js';

const SEGMENTS = 100;
const PER_SEGMENT = 10_000;

/** Entry rows of one synthetic segment, made as they are read: stored, empty, back to back. */
function* segmentEntries(segment: number): Generator<ZipEntryRecord> {
  let offset = 0;
  for (let index = 0; index < PER_SEGMENT; index++) {
    const name = `files/${segment}-${index}/f`;
    yield {
      name,
      flags: 1 << 11,
      crc32: 0,
      method: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      offset,
      dosTime: 0,
      dosDate: 0x21,
    };
    offset += LOCAL_HEADER_BYTES + Buffer.byteLength(name);
  }
}

function segmentBytes(segment: number): number {
  let total = 0;
  for (const entry of segmentEntries(segment))
    total += LOCAL_HEADER_BYTES + Buffer.byteLength(entry.name);
  return total;
}

describe('a tail over a million entries', () => {
  // Purpose (AC-3 for the central directory): segments that hand over their rows lazily are
  // encoded one segment at a time, so a million-entry archive's tail needs little memory. Fails
  // if the writer gathers every segment's rows (hundreds of MiB for this many) before writing.
  it('writes the central directory without holding every entry', async () => {
    const layouts: ZipSegmentLayout[] = Array.from({ length: SEGMENTS }, (_, segment) => ({
      byteSize: segmentBytes(segment),
      entries: () => segmentEntries(segment),
    }));
    const baseline = process.memoryUsage().heapUsed;
    let peak = 0;
    let written = 0;
    const tail = writeZipTail(
      {
        segments: layouts,
        entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }],
      },
      { modifiedAt: new Date('2026-09-24T00:00:00Z') }
    );
    for await (const chunk of tail.bytes) {
      written += chunk.length;
      peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
    }
    const summary = tail.summary();
    expect(summary.entryCount).toBe(SEGMENTS * PER_SEGMENT + 1);
    expect(written).toBe(summary.byteSize);
    expect(peak).toBeLessThan(96 * 1024 * 1024);
  }, 120_000);

  // Purpose: a lazily read row that does not fit its segment is still refused.
  it('refuses a lazy entry that runs past its segment', async () => {
    const tail = writeZipTail({
      segments: [{ byteSize: 10, entries: () => segmentEntries(0) }],
      entries: [{ name: 'manifest.json', method: 'deflated', source: Buffer.from('{}') }],
    });
    await expect(
      (async () => {
        for await (const chunk of tail.bytes) void chunk;
      })()
    ).rejects.toThrow(/does not fit/);
  });
});
