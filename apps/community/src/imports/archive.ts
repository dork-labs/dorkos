import { createHash } from 'node:crypto';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import { SegmentedBlobSource } from '../archive/segmented-source.js';
import { collectBytes } from '../archive/streams.js';
import {
  openZipArchive,
  ZipReaderError,
  type ZipArchive,
  type ZipEntry,
} from '../archive/zip-reader.js';
import type { BlobStore } from '../storage/index.js';
import {
  ImportFailure,
  MAX_IMPORT_ATTACHMENT_BYTES,
  MAX_IMPORT_ATTACHMENTS_BYTES,
  MAX_MANIFEST_BYTES,
  V1_ATTACHMENT_ENTRY,
  parseManifest,
} from './manifest.js';

/** An owner export opened from storage: its manifest and one zip entry per attachment. */
export interface OpenedExport {
  archive: ZipArchive;
  manifest: CommunityExportManifestV1;
  files: Map<string, ZipEntry>;
}

/**
 * Turn a zip reader refusal into the import's redacted failure code. Any other error (a
 * storage read that failed) passes through, for the worker to retry.
 */
export function asImportFailure(error: unknown): unknown {
  if (!(error instanceof ZipReaderError)) return error;
  if (error.code === 'ZIP_TOO_MANY_ENTRIES' || error.code === 'ZIP_TOO_LARGE')
    return new ImportFailure('IMPORT_TOO_LARGE');
  if (error.code === 'ZIP_CRC_MISMATCH') return new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
  return new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

/**
 * Open an uploaded version 1 owner export through its central directory.
 *
 * The archive is attacker-supplied, so everything is bounded before it is read: at most one
 * entry per attachment the format allows plus the manifest, only `manifest.json` (first) and
 * `attachments/<uuid>` names, no entry larger than an attachment may be, and the reader's own
 * refusals (directories, path tricks, duplicates, encryption, overlaps, inflation past the
 * declared size). Every attachment the manifest names must be in the archive at its declared
 * size, and the archive holds nothing else. Nothing is ever written to a path taken from it.
 */
export async function openExport(
  blobStore: BlobStore,
  staging: { key: string; byteSize: number },
  signal?: AbortSignal
): Promise<OpenedExport> {
  try {
    const archive = await openZipArchive(
      new SegmentedBlobSource(blobStore, [{ key: staging.key, byteSize: staging.byteSize }]),
      {
        allowName: (name) => name === 'manifest.json' || V1_ATTACHMENT_ENTRY.test(name),
        maxEntries: 10_001,
        maxEntryBytes: MAX_IMPORT_ATTACHMENT_BYTES,
        maxTotalBytes: MAX_IMPORT_ATTACHMENTS_BYTES + MAX_MANIFEST_BYTES,
        signal,
      }
    );
    let manifestEntry: ZipEntry | undefined;
    const files = new Map<string, ZipEntry>();
    for await (const entry of archive.entries()) {
      if (entry.name === 'manifest.json') {
        if (files.size > 0) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
        manifestEntry = entry;
      } else {
        if (!manifestEntry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
        files.set(entry.name.slice('attachments/'.length), entry);
      }
    }
    if (!manifestEntry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES)
      throw new ImportFailure('IMPORT_TOO_LARGE');
    const manifest = parseManifest(await collectBytes(archive.openEntry(manifestEntry)));
    if (files.size !== manifest.attachments.length)
      throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    for (const attachment of manifest.attachments) {
      const entry = files.get(attachment.id);
      if (!entry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
      if (entry.uncompressedSize !== attachment.byteSize)
        throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
    }
    return { archive, manifest, files };
  } catch (error) {
    throw asImportFailure(error);
  }
}

/**
 * Stream one attachment out of the archive, counting its bytes and hashing them, and refuse it
 * unless it matches the manifest's size and SHA-256 exactly. The bytes a caller receives are
 * trustworthy only once the iteration finishes without an error.
 */
export async function* verifiedFile(
  opened: OpenedExport,
  attachment: CommunityExportManifestV1['attachments'][number]
): AsyncGenerator<Uint8Array> {
  const entry = opened.files.get(attachment.id);
  if (!entry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of opened.archive.openEntry(entry)) {
      bytes += chunk.length;
      if (bytes > attachment.byteSize) throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
      hash.update(chunk);
      yield chunk;
    }
  } catch (error) {
    throw asImportFailure(error);
  }
  if (bytes !== attachment.byteSize || hash.digest('hex') !== attachment.checksum)
    throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
}
