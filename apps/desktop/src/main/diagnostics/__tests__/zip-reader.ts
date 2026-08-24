/**
 * A ZIP *reader* for tests, written independently of `zip-writer.ts`.
 *
 * The point of reading an archive back is to catch a writer that emits bytes no
 * extractor will accept, so this deliberately takes the route a real extractor
 * takes rather than the route the writer took: it starts at the
 * end-of-central-directory record, walks the central directory, and finds each
 * file's bytes through the local-header offset recorded there. A writer whose
 * central directory disagrees with its local headers — the failure mode that
 * produces an archive Finder refuses to open — fails here, where re-reading the
 * writer's own local headers in order would not notice.
 *
 * Stored (uncompressed) entries only, which is all `buildZip` produces.
 */

/** End-of-central-directory signature (`PK\x05\x06`). */
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
/** Central directory file header signature (`PK\x01\x02`). */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** Local file header signature (`PK\x03\x04`). */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Byte length of the end-of-central-directory record with no archive comment. */
const END_RECORD_BYTES = 22;
/** Byte length of a central directory record, before the name. */
const CENTRAL_HEADER_BYTES = 46;
/** Byte length of a local file header, before the name. */
const LOCAL_HEADER_BYTES = 30;

/**
 * Read every entry out of a stored ZIP archive.
 *
 * @param archive - The archive's bytes.
 * @returns Each entry's in-archive path mapped to its contents, in central
 *   directory order.
 * @throws If any signature is wrong or a declared size does not match — i.e. if
 *   the archive is not one an extractor would accept.
 */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const endOffset = archive.length - END_RECORD_BYTES;
  if (endOffset < 0 || archive.readUInt32LE(endOffset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error('No end-of-central-directory record: this is not a readable ZIP archive.');
  }

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const files = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index++) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`Central directory entry ${index} has a bad signature.`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    if (method !== 0) throw new Error(`Entry ${index} is compressed (method ${method}).`);

    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength); // prettier-ignore

    if (archive.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`"${name}" points at ${localOffset}, which is not a local file header.`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    if (dataStart + size > archive.length) {
      throw new Error(`"${name}" claims ${size} bytes, which runs past the end of the archive.`);
    }

    files.set(name, archive.subarray(dataStart, dataStart + size));
    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }

  return files;
}
