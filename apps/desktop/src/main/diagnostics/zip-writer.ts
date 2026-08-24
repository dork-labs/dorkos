/**
 * A dependency-free ZIP writer for small, already-small archives.
 *
 * Every entry is *stored* (compression method 0) rather than deflated. That is
 * a deliberate trade: the archive exists so a person can attach one file to a
 * support message, and a store-only writer is ~100 lines of well-specified
 * format with no dependency, no native binary and no platform gate — where the
 * obvious alternatives each fail one of those. `zlib` compresses a stream, not
 * a folder, so it cannot produce something Finder or Explorer will open;
 * macOS's `ditto -c -k` can, but only on macOS, and the Windows build needs the
 * same feature. Log tails are the bulk of what goes in here and they are
 * bounded by the caller, so the size a person actually mails is a few hundred
 * kilobytes either way.
 *
 * @module main/diagnostics/zip-writer
 */

/** One file inside the archive. */
export interface ZipEntry {
  /** Path inside the archive. Always forward-slashed, even on Windows. */
  name: string;
  /** The file's bytes. */
  data: Buffer;
}

/** Local file header signature (`PK\x03\x04`). */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** Central directory file header signature (`PK\x01\x02`). */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** End-of-central-directory signature (`PK\x05\x06`). */
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Fixed byte length of a local file header, before the name. */
const LOCAL_HEADER_BYTES = 30;
/** Fixed byte length of a central directory record, before the name. */
const CENTRAL_HEADER_BYTES = 46;
/** Fixed byte length of the end-of-central-directory record. */
const END_RECORD_BYTES = 22;

/** "Version needed to extract" 2.0 — the floor every extractor supports. */
const VERSION_20 = 20;
/** General-purpose bit 11: the file name is UTF-8, not CP437. */
const UTF8_NAME_FLAG = 0x0800;
/** Compression method 0 — stored, no compression. */
const METHOD_STORED = 0;

/** Sizes, offsets and counts past these need ZIP64, which this writer has no answer for. */
const MAX_32_BIT = 0xffffffff;
/** The end-of-central-directory record counts entries in 16 bits. */
const MAX_ENTRY_COUNT = 0xffff;

/** The earliest year a DOS timestamp can express. */
const DOS_EPOCH_YEAR = 1980;
/** The latest year a DOS timestamp can express — the field is 7 bits wide. */
const DOS_MAX_YEAR = DOS_EPOCH_YEAR + 127;

/** CRC-32 (IEEE 802.3) lookup table, built once at module load. */
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of `data`, as the ZIP format defines it.
 *
 * @param data - The bytes to checksum.
 */
function crc32(data: Buffer): number {
  let crc = MAX_32_BIT;
  for (const byte of data) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ MAX_32_BIT) >>> 0;
}

/**
 * Pack a date into the two 16-bit MS-DOS fields every ZIP entry carries.
 *
 * DOS time has two-second resolution and a 7-bit year field counting from
 * 1980, so it can only express 1980–2107. A clock outside that range is
 * clamped at both ends rather than allowed to overflow the field and take the
 * neighbouring month and day bits with it, which makes the whole archive
 * unreadable — a wrong timestamp on a support file costs nothing, and a
 * machine with a badly wrong clock is exactly the kind that needs to file a
 * report.
 *
 * @param when - The modification time to record.
 */
function toDosDateTime(when: Date): { date: number; time: number } {
  const year = Math.min(Math.max(when.getFullYear(), DOS_EPOCH_YEAR), DOS_MAX_YEAR);
  return {
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

/**
 * Build a complete ZIP archive in memory.
 *
 * @param entries - The files to store, in the order they should appear.
 * @param modifiedAt - Modification time stamped on every entry.
 * @returns The archive's bytes, ready to write to disk.
 * @throws If the archive would exceed what ZIP's 32-bit size, offset and count
 *   fields can address. Silently emitting a truncated archive would hand
 *   someone a file that looks saved and cannot be opened, which is worse than
 *   the failure itself.
 */
export function buildZip(entries: ZipEntry[], modifiedAt: Date = new Date()): Buffer {
  if (entries.length > MAX_ENTRY_COUNT) {
    throw new Error(`A ZIP archive cannot hold more than ${MAX_ENTRY_COUNT} entries.`);
  }

  const { date, time } = toDosDateTime(modifiedAt);
  const fileParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.data.length;
    const crc = crc32(entry.data);

    if (size > MAX_32_BIT || offset > MAX_32_BIT) {
      throw new Error(`"${entry.name}" pushes the archive past ZIP's 4 GiB limit.`);
    }

    const localHeader = Buffer.alloc(LOCAL_HEADER_BYTES);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_20, 4);
    localHeader.writeUInt16LE(UTF8_NAME_FLAG, 6);
    localHeader.writeUInt16LE(METHOD_STORED, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(CENTRAL_HEADER_BYTES);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_20, 4);
    centralHeader.writeUInt16LE(VERSION_20, 6);
    centralHeader.writeUInt16LE(UTF8_NAME_FLAG, 8);
    centralHeader.writeUInt16LE(METHOD_STORED, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    // Extra field, file comment, disk number, internal and external attributes
    // are all left at zero: none of them mean anything for a stored entry that
    // no extractor is asked to restore permissions from.
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += LOCAL_HEADER_BYTES + name.length + size;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(END_RECORD_BYTES);
  endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);

  return Buffer.concat([...fileParts, centralDirectory, endRecord]);
}
