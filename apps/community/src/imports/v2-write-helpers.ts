import type { PoolClient } from 'pg';
import { ImportFailure } from './manifest.js';
import type { V2Collection } from './v2-archive.js';
import type { V2Row } from './v2-rows.js';

/** Refuse an archive a check finds tampered with. */
export function invalid(condition: boolean): void {
  if (condition) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

/** Insert one batch of a step's rows in the caller's transaction. */
export type BatchWriter<K extends V2Collection> = (
  client: PoolClient,
  rows: V2Row[K][],
  scope: RestoreScope
) => Promise<void>;

/** What every batch writer needs: the community, the ID derivation, and the export. */
export interface RestoreScope {
  communityId: string;
  importId: string;
  derive: (sourceId: string) => string;
  ownerSourceId: string;
  /** This host's key for a banned email; see `ImportLimits.banEmailKey`. */
  banEmailKey?: (email: string) => string;
}

/** Refuse unless an `ON CONFLICT DO NOTHING` insert wrote every row: a duplicate in the export. */
export function wroteAll(result: { rowCount: number | null }, expected: number): void {
  invalid((result.rowCount ?? 0) !== expected);
}

/** Insert one batch as JSON rows, `$1`, into community `$2`. */
export const insertRows = (client: PoolClient, sql: string, rows: unknown[], communityId: string) =>
  client.query(sql, [JSON.stringify(rows), communityId]);

/**
 * Refuse unless every id in `ids` (derived) is a row of `table` in this import's community: a
 * membership that names a channel, member, or agent the export does not hold is tampering.
 */
export async function allRestored(
  client: PoolClient,
  table: 'channels' | 'members' | 'agents' | 'entries',
  ids: readonly string[],
  communityId: string
): Promise<void> {
  const distinct = [...new Set(ids)];
  if (!distinct.length) return;
  const found = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE community_id=$1 AND id=ANY($2::uuid[])`,
    [communityId, distinct]
  );
  invalid(found.rows[0].n !== distinct.length);
}
