/**
 * When a Wi-Fi sign-in was last used, for its 12-hour idle limit (DOR-4744;
 * `./session-route.ts` reads it).
 *
 * The session gate stamps `session.last_active_at` each time a Wi-Fi sign-in
 * works, at most once per {@link WIFI_ACTIVITY_WRITE_MS}, straight on the row.
 * The limit is counted on the server, so a device cannot keep its sign-in alive
 * by saying it was busy. Better Auth's own renewal is not used for this: it
 * writes at most once a day, which is far coarser than 12 hours.
 *
 * @module services/core/auth/sessions/wifi-activity
 */
import { eq, session } from '@dorkos/db';

import { readAuthDb } from '../index.js';

/** How often one sign-in's last use is written, at most: once a minute. */
export const WIFI_ACTIVITY_WRITE_MS = 60_000;

/** The last write per session id, so a busy device writes once a minute. */
const lastWrite = new Map<string, number>();

/** Most sessions remembered before the oldest are forgotten. */
const MAX_REMEMBERED = 1000;

/**
 * Record that a Wi-Fi sign-in was just used.
 *
 * @param sessionId - The session's id.
 * @param now - The current time, for tests.
 */
export function noteWifiSessionUsed(sessionId: string, now = Date.now()): void {
  const db = readAuthDb();
  if (!db) return;
  const last = lastWrite.get(sessionId);
  if (last !== undefined && now - last < WIFI_ACTIVITY_WRITE_MS) return;
  lastWrite.delete(sessionId);
  lastWrite.set(sessionId, now);
  if (lastWrite.size > MAX_REMEMBERED) lastWrite.delete(lastWrite.keys().next().value!);
  db.update(session)
    .set({ lastActiveAt: new Date(now) })
    .where(eq(session.id, sessionId))
    .run();
}

/**
 * Forget the write times. Tests only.
 *
 * @internal
 */
export function resetWifiActivityForTests(): void {
  lastWrite.clear();
}
