/**
 * How v0.117.0, the last release before export format 3, reads an archive's version: its
 * `readManifestVersion` from `apps/community/src/imports/archive.ts`, copied verbatim (renamed
 * here) with only the import paths changed. Every helper it calls is unchanged since that
 * release. It lets a test hand a format 3 archive to the importer an older host runs.
 */
import type { RangeReader } from '../../archive/segmented-source.js';
import { collectBytes } from '../../archive/streams.js';
import { openZipArchive, type ZipEntry } from '../../archive/zip-reader.js';
import {
  asImportFailure,
  ImportFailure,
  MAX_MANIFEST_BYTES,
  V1_ATTACHMENT_ENTRY,
  parseManifestJson,
} from '../../imports/manifest.js';
import { isV2EntryName, MAX_V2_ENTRIES } from '../../imports/v2-archive.js';

/**
 * The `version` of an archive's `manifest.json`, read under the names either version allows
 * and nothing else, so each version's own rules then apply in full.
 *
 * `1` and `2` are the versions this host reads. Any other integer fails as
 * `IMPORT_VERSION_UNSUPPORTED`; an archive with no readable manifest, or a version that is not
 * an integer, as `IMPORT_ARCHIVE_INVALID`.
 */
export async function readManifestVersionV0117(
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
