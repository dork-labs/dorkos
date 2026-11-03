/**
 * One stored notification's kind and raw payload, read back by id: what a
 * notice's own action reads to act on exactly what it named (an Undo,
 * DOR-3703). Kept out of `notification-store.ts`, which delegates here.
 *
 * @module services/notifications/stored-payload
 */
import { eq, notifications, type Db } from '@dorkos/db';

/** A stored notification's kind and its raw payload (`null` when it had none). */
export interface StoredPayload {
  /** The notification kind. */
  kind: string;
  /** The `notify()` payload as stored, parsed. */
  payload: unknown;
}

/**
 * Read one notification's kind and payload, or `null` when there is none.
 *
 * @param db - The DorkOS database.
 * @param id - The notification.
 */
export function readStoredPayload(db: Db, id: string): StoredPayload | null {
  const row = db
    .select({ kind: notifications.kind, dataJson: notifications.dataJson })
    .from(notifications)
    .where(eq(notifications.id, id))
    .get();
  if (!row) return null;
  try {
    return { kind: row.kind, payload: row.dataJson ? JSON.parse(row.dataJson) : null };
  } catch {
    return { kind: row.kind, payload: null };
  }
}
