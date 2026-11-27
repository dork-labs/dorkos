/**
 * When each connected account was first made: the fixed key the owner's
 * account lists page on, newest first (DOR-4982). Renaming, pausing or
 * signing in again never moves it.
 *
 * @module services/connectors/owner-lists/connection-ages
 */
import { connections, inArray, type Db } from '@dorkos/db';

/**
 * When each of these connections was first made (ISO 8601), by id. An id with
 * no row is left out.
 *
 * @param db - The DorkOS database.
 * @param connectionIds - The connections asked about.
 */
export function connectionCreatedAt(db: Db, connectionIds: readonly string[]): Map<string, string> {
  if (connectionIds.length === 0) return new Map();
  const rows = db
    .select({ id: connections.id, createdAt: connections.createdAt })
    .from(connections)
    .where(inArray(connections.id, [...connectionIds]))
    .all();
  return new Map(rows.map((row) => [row.id, row.createdAt]));
}
