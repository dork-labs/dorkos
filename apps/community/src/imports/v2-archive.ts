import { createHash } from 'node:crypto';
import {
  CommunityExportManifestV2Schema,
  type CommunityExportManifestV2,
} from '@dorkos/shared/community-wire';
import type { RangeReader } from '../archive/segmented-source.js';
import { collectBytes } from '../archive/streams.js';
import { openZipArchive, type ZipArchive, type ZipEntry } from '../archive/zip-reader.js';
import {
  asImportFailure,
  ImportFailure,
  MAX_MANIFEST_BYTES,
  parseManifestJson,
} from './manifest.js';
import { ndjsonLines } from './ndjson.js';

/** A version 2 manifest's name for each collection, with the folder its files live in. */
export const V2_COLLECTIONS = {
  channels: 'channels',
  members: 'members',
  agents: 'agents',
  channelMembers: 'channel-members',
  agentChannelMembers: 'agent-channel-members',
  auditEvents: 'audit-events',
  entries: 'entries',
  attachments: 'attachments',
} as const;
/** One collection of a version 2 export. */
export type V2Collection = keyof typeof V2_COLLECTIONS;

/** The largest community icon, as the settings route accepts one. */
export const MAX_IMPORT_ICON_BYTES = 2 * 1024 * 1024;
/**
 * The largest one NDJSON file of a version 2 export may inflate to. The exporter writes a data
 * segment's messages (a segment is at most 1 GiB) or at most 64 MiB of one collection per file.
 */
export const MAX_V2_NDJSON_BYTES = 1024 * 1024 * 1024;
/** The most NDJSON files one export may hold: far more than a 1 TiB export in 64 MiB segments. */
export const MAX_V2_NDJSON_FILES = 100_000;
/**
 * The most the data files of one export may inflate to in all: a floor for small exports, plus
 * a multiple of the archive's own size, and never more than an absolute ceiling. The multiple is
 * generous on purpose: agents' repetitive output really compresses 80 to 160 times over (human
 * chat about 8), so only data near deflate's 1032:1 limit, a decompression bomb, passes it.
 */
export const V2_NDJSON_FLOOR_BYTES = 64 * 1024 * 1024;
/** See {@link V2_NDJSON_FLOOR_BYTES}. */
export const V2_NDJSON_RATIO = 256;
/** See {@link V2_NDJSON_FLOOR_BYTES}. */
export const V2_NDJSON_CEILING_BYTES = 128 * 1024 * 1024 * 1024;

/** The most data-file bytes an archive of `archiveBytes` may inflate to. */
export function maxNdjsonBytes(archiveBytes: number): number {
  return Math.min(V2_NDJSON_CEILING_BYTES, V2_NDJSON_FLOOR_BYTES + V2_NDJSON_RATIO * archiveBytes);
}

/** The most entries a version 2 archive may declare, checked before its directory is read. */
export const MAX_V2_ENTRIES = 1_000_000;
/** The source id a restored community icon is recorded under; no attachment may use it. */
export const ICON_SOURCE_ID = '00000000-0000-0000-0000-000000000000';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NDJSON_NAME = new RegExp(`^(${Object.values(V2_COLLECTIONS).join('|')})/[0-9]{6}\\.ndjson$`);
const FILE_NAME = new RegExp(`^files/${UUID}/[^/]+$`);

/** Every name a version 2 export may hold. */
export function isV2EntryName(name: string): boolean {
  return (
    name === 'manifest.json' ||
    name === 'community/icon' ||
    NDJSON_NAME.test(name) ||
    FILE_NAME.test(name)
  );
}

/**
 * A version 2 manifest the importer accepts: an owner export. The schema also describes a
 * takedown's evidence archive, which has no requester and may record any lifecycle; an owner
 * export always names its requester and records an active or archived community.
 */
export type OwnerExportManifestV2 = CommunityExportManifestV2 & {
  scope: 'owner';
  requesterMemberId: string;
  community: CommunityExportManifestV2['community'] & { lifecycle: 'active' | 'archived' };
};

/**
 * A type narrowing, never false at run time: the scope check before the schema and the schema's
 * refines are what enforce it.
 */
function isOwnerManifest(manifest: CommunityExportManifestV2): manifest is OwnerExportManifestV2 {
  return (
    manifest.scope === 'owner' &&
    manifest.requesterMemberId !== null &&
    (manifest.community.lifecycle === 'active' || manifest.community.lifecycle === 'archived')
  );
}

/** An owner export of version 2 opened from storage, checked for shape but not yet read. */
export interface OpenedExportV2 {
  archive: ZipArchive;
  manifest: OwnerExportManifestV2;
  /** Every NDJSON file, by name. The manifest lists exactly these. */
  ndjson: ReadonlyMap<string, ZipEntry>;
  icon: ZipEntry | null;
}

/**
 * Open an uploaded version 2 owner export through its central directory.
 *
 * The archive is attacker-supplied, so its structure is checked before a byte of any entry is
 * inflated: only version 2 names (`manifest.json`, `community/icon`, `<collection>/NNNNNN.ndjson`,
 * `files/<uuid>/<name>`), the zip reader's own refusals (path tricks, duplicates, encryption,
 * overlaps, impossible sizes), each entry within the size its kind may be, at most
 * {@link MAX_V2_NDJSON_FILES} data files, and data files that inflate to no more in all than
 * {@link maxNdjsonBytes} allows for the archive's size. Membership counts cannot exceed channels
 * times members (or agents). The manifest must parse with its strict schema, be an
 * owner export, and list exactly the archive's data files under the right collections, and the
 * archive holds one `files/` entry per attachment it counts and the icon exactly when it names
 * one. Nothing is ever written to a path taken from the archive.
 *
 * Memory holds the data files' entries (bounded above) and nothing per attachment: files are
 * found later by walking the directory a window at a time (see {@link FileCursor}).
 */
export async function openExportV2(
  source: RangeReader,
  limits: { attachmentBytes: number },
  signal?: AbortSignal
): Promise<OpenedExportV2> {
  try {
    const archive = await openZipArchive(source, {
      allowName: isV2EntryName,
      maxEntries: MAX_V2_ENTRIES,
      maxEntryBytes: MAX_V2_NDJSON_BYTES,
      signal,
    });
    let manifestEntry: ZipEntry | undefined;
    let icon: ZipEntry | null = null;
    const ndjson = new Map<string, ZipEntry>();
    let files = 0;
    let ndjsonBytes = 0;
    const ndjsonLimit = maxNdjsonBytes(source.size);
    for await (const entry of archive.entries()) {
      if (entry.name === 'manifest.json') manifestEntry = entry;
      else if (entry.name === 'community/icon') {
        if (entry.uncompressedSize > MAX_IMPORT_ICON_BYTES)
          throw new ImportFailure('IMPORT_TOO_LARGE');
        icon = entry;
      } else if (entry.name.startsWith('files/')) {
        if (entry.uncompressedSize > limits.attachmentBytes)
          throw new ImportFailure('IMPORT_TOO_LARGE');
        files++;
      } else {
        if (ndjson.size >= MAX_V2_NDJSON_FILES) throw new ImportFailure('IMPORT_TOO_LARGE');
        // Declared sizes are binding: the reader refuses an entry that inflates past its own.
        ndjsonBytes += entry.uncompressedSize;
        if (ndjsonBytes > ndjsonLimit) throw new ImportFailure('IMPORT_TOO_LARGE');
        ndjson.set(entry.name, entry);
      }
    }
    if (!manifestEntry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES)
      throw new ImportFailure('IMPORT_TOO_LARGE');
    const raw = parseManifestJson(await collectBytes(archive.openEntry(manifestEntry)));
    const { version, scope } = raw as { version?: unknown; scope?: unknown };
    if (version !== 2)
      throw new ImportFailure(
        Number.isInteger(version) ? 'IMPORT_VERSION_UNSUPPORTED' : 'IMPORT_ARCHIVE_INVALID'
      );
    // Any scope but owner (a personal export, a takedown's evidence archive, or one a later
    // version adds) is refused by name, before the schema, whatever scopes the schema knows.
    if (typeof scope === 'string' && scope !== 'owner')
      throw new ImportFailure('IMPORT_NOT_OWNER_EXPORT');
    const parsed = CommunityExportManifestV2Schema.safeParse(raw);
    if (!parsed.success || !isOwnerManifest(parsed.data))
      throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    const manifest = parsed.data;

    // The manifest lists every data file once, each under its own collection's folder.
    const listed = new Set<string>();
    for (const [key, folder] of Object.entries(V2_COLLECTIONS) as [V2Collection, string][]) {
      for (const name of manifest.files[key]) {
        if (!name.startsWith(`${folder}/`) || !NDJSON_NAME.test(name) || listed.has(name))
          throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
        if (!ndjson.has(name)) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
        listed.add(name);
      }
    }
    if (listed.size !== ndjson.size) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    if (files !== manifest.counts.attachments) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    // A membership pairs one channel with one member or agent, so there cannot be more of them.
    const { counts } = manifest;
    if (
      counts.channelMembers > counts.channels * counts.members ||
      counts.agentChannelMembers > counts.channels * counts.agents
    )
      throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    const declaredIcon = manifest.community.icon;
    if ((declaredIcon === null) !== (icon === null))
      throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    if (declaredIcon && icon) {
      if (declaredIcon.byteSize > MAX_IMPORT_ICON_BYTES)
        throw new ImportFailure('IMPORT_TOO_LARGE');
      if (icon.uncompressedSize !== declaredIcon.byteSize)
        throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
    }
    return { archive, manifest, ndjson, icon };
  } catch (error) {
    throw asImportFailure(error);
  }
}

/**
 * The lines of one collection's files, in manifest order, from line `skip` of file `fromFile`
 * on, with the file index and line number of each. A file is read (inflated) as it is consumed.
 */
export async function* collectionLines(
  opened: OpenedExportV2,
  key: V2Collection,
  maxLineBytes: number,
  from: { file: number; line: number } = { file: 0, line: 0 }
): AsyncGenerator<{ file: number; line: number; bytes: Buffer }> {
  const names = opened.manifest.files[key];
  for (let file = from.file; file < names.length; file++) {
    const entry = opened.ndjson.get(names[file]);
    if (!entry) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
    let line = 0;
    try {
      for await (const bytes of ndjsonLines(opened.archive.openEntry(entry), maxLineBytes)) {
        line++;
        if (file === from.file && line <= from.line) continue;
        yield { file, line, bytes };
      }
    } catch (error) {
      throw asImportFailure(error);
    }
    if (file === from.file && line < from.line) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  }
}

/** How many central directory records one window reads. */
const WINDOW_RECORDS = 1_000;

/**
 * The archive's `files/` entries in directory order, a window of records at a time, so a
 * directory of any length is walked in bounded memory and no storage read stays open across the
 * slow work done per file. An exporter writes each data segment's files in the order its
 * attachments file lists them, so the n-th attachment row names the n-th file.
 */
export class FileCursor {
  private window: ZipEntry[] = [];
  private index = 0;
  private next: number | null = 0;

  constructor(private readonly archive: ZipArchive) {}

  /** The next `files/` entry, or null when there is none. */
  async take(): Promise<ZipEntry | null> {
    while (true) {
      while (this.index < this.window.length) {
        const entry = this.window[this.index++];
        if (entry.name.startsWith('files/')) return entry;
      }
      if (this.next === null) return null;
      try {
        const read = await this.archive.directoryWindow(this.next, WINDOW_RECORDS);
        this.window = read.entries;
        this.next = read.next;
      } catch (error) {
        throw asImportFailure(error);
      }
      this.index = 0;
    }
  }
}

/**
 * Stream one entry, counting and hashing it, and refuse it unless it is exactly `byteSize`
 * bytes with SHA-256 `checksum`. The bytes a caller receives are trustworthy only once the
 * iteration finishes without an error.
 */
export async function* verifiedEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  expected: { byteSize: number; checksum: string }
): AsyncGenerator<Uint8Array> {
  if (entry.uncompressedSize !== expected.byteSize)
    throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of archive.openEntry(entry)) {
      bytes += chunk.length;
      if (bytes > expected.byteSize) throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
      hash.update(chunk);
      yield chunk;
    }
  } catch (error) {
    throw asImportFailure(error);
  }
  if (bytes !== expected.byteSize || hash.digest('hex') !== expected.checksum)
    throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
}
