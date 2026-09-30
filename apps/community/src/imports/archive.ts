import { createHash } from 'node:crypto';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import type { RangeReader } from '../archive/segmented-source.js';
import { collectBytes } from '../archive/streams.js';
import { openZipArchive, type ZipArchive, type ZipEntry } from '../archive/zip-reader.js';
import {
  asImportFailure,
  ImportFailure,
  MAX_IMPORT_ATTACHMENT_BYTES,
  MAX_IMPORT_ATTACHMENTS_BYTES,
  MAX_MANIFEST_BYTES,
  V1_ATTACHMENT_ENTRY,
  parseManifest,
  parseManifestJson,
} from './manifest.js';
import { isV2EntryName, MAX_V2_ENTRIES } from './v2-archive.js';

/** An owner export opened from storage: its manifest and one zip entry per attachment. */
export interface OpenedExport {
  archive: ZipArchive;
  manifest: CommunityExportManifestV1;
  files: Map<string, ZipEntry>;
}

/**
 * The `version` of an archive's `manifest.json`, read under the names either version allows
 * and nothing else, so each version's own rules then apply in full.
 *
 * `1` and `2` are the versions this host reads. Any other integer fails as
 * `IMPORT_VERSION_UNSUPPORTED`; an archive with no readable manifest, or a version that is not
 * an integer, as `IMPORT_ARCHIVE_INVALID`.
 */
export async function readManifestVersion(
  source: RangeReader,
  signal?: AbortSignal
): Promise<1 | 2> {
  try {
    const archive = await openZipArchive(source, {
      allowName: (name) =>
        name === 'manifest.json' || V1_ATTACHMENT_ENTRY.test(name) || isV2EntryName(name),
      maxEntries: MAX_V2_ENTRIES,
      signal,
    });
    let manifestEntry: ZipEntry | undefined;
    for await (const entry of archive.entries()) {
      if (entry.name === 'manifest.json') manifestEntry = entry;
    }
    if (!manifestEntry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES)
      throw new ImportFailure('IMPORT_TOO_LARGE');
    const { version } = parseManifestJson(await collectBytes(archive.openEntry(manifestEntry)));
    if (version === 1 || version === 2) return version;
    throw new ImportFailure(
      Number.isInteger(version) ? 'IMPORT_VERSION_UNSUPPORTED' : 'IMPORT_ARCHIVE_INVALID'
    );
  } catch (error) {
    throw asImportFailure(error);
  }
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
 * Call {@link readManifestVersion} first: this applies the version 1 rules only.
 */
export async function openExport(source: RangeReader, signal?: AbortSignal): Promise<OpenedExport> {
  try {
    const archive = await openZipArchive(source, {
      allowName: (name) => name === 'manifest.json' || V1_ATTACHMENT_ENTRY.test(name),
      maxEntries: 10_001,
      maxEntryBytes: MAX_IMPORT_ATTACHMENT_BYTES,
      maxTotalBytes: MAX_IMPORT_ATTACHMENTS_BYTES + MAX_MANIFEST_BYTES,
      signal,
    });
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
