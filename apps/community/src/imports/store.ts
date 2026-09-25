import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminImportFailureCodeSchema,
  CommunityAdminImportReportSchema,
  CommunityAdminImportSchema,
  CommunityAdminImportStateSchema,
} from '@dorkos/shared/community-admin-wire';
import type { HostAuditActor } from '../host/authority.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** The largest export one upload accepts. */
export const MAX_IMPORT_ARCHIVE_BYTES = 1024 * 1024 * 1024;
/** How long the upload token works after an import is created. */
export const IMPORT_UPLOAD_WINDOW_MS = 24 * 60 * 60_000;
/** How long a checked import waits at `validated` for the host to commit it. */
export const IMPORT_COMMIT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** How long one upload's lease lasts between renewals. */
export const IMPORT_UPLOAD_LEASE_MS = 2 * 60_000;
/** Temporary folders an import writes; swept at startup when a crash left one behind. */
export const IMPORT_TEMP_PREFIXES = ['community-import-', 'community-import-file-'] as const;
/** How long a claimed import job stays one worker's before another replica may take it. */
export const IMPORT_LEASE_MS = 5 * 60_000;
/** Settled imports whose community is gone are deleted this long after they settled. */
export const IMPORT_RETENTION = "interval '30 days'";

/** Where an import stands. */
export type ImportState = z.infer<typeof CommunityAdminImportStateSchema>;
/** A redacted reason an import failed. */
export type ImportFailureCode = z.infer<typeof CommunityAdminImportFailureCodeSchema>;
/** A counts-only report of what an export holds. */
export type ImportReport = z.infer<typeof CommunityAdminImportReportSchema>;

/** One `community_imports` row, as the routes and the worker read it. */
export interface ImportRow {
  id: string;
  community_id: string | null;
  idempotency_key: string;
  payload_hash: string;
  state: ImportState;
  auto_commit: boolean;
  upload_token_hash: string;
  upload_expires_at: Date;
  archive_sha256: string | null;
  archive_bytes: string | null;
  archive_received_at: Date | null;
  upload_lease_until: Date | null;
  upload_lease_token: string | null;
  staging_blob_key: string | null;
  manifest_version: number | null;
  report: ImportReport | null;
  failure_code: ImportFailureCode | null;
  attempts: number;
  next_attempt_at: Date;
  lease_token: string | null;
  settled_at: Date | null;
  created_by_user_id: string | null;
  created_by_api_key_id: string | null;
  validated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The host's view of one import: state, counts, and sizes; never the token or a name. */
export function projectImport(row: ImportRow): z.infer<typeof CommunityAdminImportSchema> {
  return {
    importId: row.id,
    communityId: row.community_id,
    state: row.state,
    report: row.report,
    failureCode: row.failure_code,
    autoCommit: row.auto_commit,
    archiveBytes: row.archive_bytes === null ? null : Number(row.archive_bytes),
    uploadExpiresAt: row.upload_expires_at.toISOString(),
    maxArchiveBytes: MAX_IMPORT_ARCHIVE_BYTES,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Read one import, optionally locking it. */
export async function loadImport(
  db: Queryable,
  importId: string,
  lock: '' | 'FOR SHARE' | 'FOR UPDATE' = ''
): Promise<ImportRow | undefined> {
  const result = await db.query<ImportRow>(`SELECT * FROM community_imports WHERE id=$1 ${lock}`, [
    importId,
  ]);
  return result.rows[0];
}

/**
 * The host actor an import's creator was, for audit rows about work the creator delegated: an
 * upload made with the upload token acts on the creator's behalf.
 */
export function importCreator(
  row: Pick<ImportRow, 'created_by_user_id' | 'created_by_api_key_id'>
): HostAuditActor {
  if (row.created_by_user_id) return { kind: 'person', userId: row.created_by_user_id };
  if (row.created_by_api_key_id) return { kind: 'api_key', keyId: row.created_by_api_key_id };
  // The creator's account was deleted since; the upload token still speaks for the import.
  return { kind: 'system' };
}
