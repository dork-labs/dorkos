import type { Pool } from 'pg';
import { expect } from 'vitest';
import {
  CommunityExportManifestV2Schema,
  type CommunityExportManifestV2,
} from '@dorkos/shared/community-wire';
import { bufferReader, readWithOurReader } from '../archive/__tests__/archive-test-helpers.js';
import { runNextExport, type ExportWorkerOptions } from '../exports/worker.js';
import type { BlobStore } from '../storage/index.js';

/** The worker settings tests use unless they need small segments. */
export const EXPORT_SETTINGS = {
  segmentBytes: 256 * 1024 * 1024,
  ttlHours: 24,
  maxHours: 24,
} as const;

/** Run every due export job until none is left; returns the ids in the order they ran. */
export async function drainExports(
  pool: Pool,
  blobStore: BlobStore,
  options: Partial<ExportWorkerOptions> = {}
): Promise<string[]> {
  const ran: string[] = [];
  for (let round = 0; round < 50; round++) {
    const id = await runNextExport({ pool, blobStore, settings: EXPORT_SETTINGS, ...options });
    if (!id) return ran;
    ran.push(id);
  }
  throw new Error('Export jobs did not settle');
}

/** A downloaded version 2 archive, read through the Community's own zip reader. */
export interface OpenedArchive {
  manifest: CommunityExportManifestV2;
  /** Every entry's bytes, by name. */
  files: Map<string, Buffer>;
  /** Entry names in archive order. */
  names: string[];
  /** Every NDJSON row the manifest lists for one collection, parsed. */
  rows<T = Record<string, unknown>>(key: keyof CommunityExportManifestV2['files']): T[];
}

/** Open a whole archive held in memory and parse its manifest. */
export async function openArchive(bytes: Buffer): Promise<OpenedArchive> {
  const { entries, contents } = await readWithOurReader(bufferReader(bytes));
  const manifestBytes = contents.get('manifest.json');
  expect(manifestBytes, 'manifest.json is in the archive').toBeDefined();
  const manifest = CommunityExportManifestV2Schema.parse(
    JSON.parse(manifestBytes!.toString('utf8'))
  );
  return {
    manifest,
    files: contents,
    names: entries.map((entry) => entry.name),
    rows<T>(key: keyof CommunityExportManifestV2['files']) {
      return manifest.files[key].flatMap((name) =>
        contents
          .get(name)!
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      );
    },
  };
}

/** Make every ready archive of one member expire now, so their next request starts a new export. */
export async function expireReadyExports(pool: Pool, memberId: string): Promise<void> {
  await pool.query(
    `UPDATE export_archives SET expires_at=now()-interval '1 second'
     WHERE requester_member_id=$1 AND state='ready' AND expires_at>now()`,
    [memberId]
  );
}
