/**
 * Letting one Wi-Fi sign-in run agents at their own level (DOR-4744).
 *
 * A turn a Wi-Fi request starts runs at the runtime's default level
 * (`./wifi-turn-ceiling.ts`). The owner may lift that for one device at a time:
 *
 * - **Per sign-in.** The choice is a column on that one session row
 *   (`wifi_agent_turns_at`), so it is shown on that device's row, ends when that
 *   device signs out, and no other sign-in inherits it. Every sign-in starts
 *   with it off.
 * - **Only at this computer.** It is set and cleared only through
 *   `routes/devices.ts`, behind `requirePersonAtThisComputer`. No agent tool,
 *   capability, API key or approval token reaches it.
 * - **It ends on its own.** It lasts only while its sign-in is used: a Wi-Fi
 *   sign-in ends after 12 hours unused (`./session-route.ts`), and so does this.
 *   It is read fresh from the row on every turn, never from the cookie's cached
 *   snapshot, so clearing it takes effect on the next turn.
 *
 * @module services/core/auth/sessions/wifi-agent-turns
 */
import { and, eq, session } from '@dorkos/db';

import { readAuthDb } from '../index.js';
import { wifiSessionIdle } from './session-route.js';

/**
 * Whether this Wi-Fi sign-in may run agents at their own level: the owner
 * turned it on at this computer, and the sign-in is still in use.
 *
 * @param sessionId - The verified session's id.
 * @param now - The current time, for tests.
 */
export function wifiAgentTurnsAllowed(sessionId: string, now = Date.now()): boolean {
  const db = readAuthDb();
  if (!db) return false;
  const row = db
    .select({
      route: session.route,
      on: session.wifiAgentTurnsAt,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .where(eq(session.id, sessionId))
    .get();
  if (!row || row.route !== 'wifi' || row.on === null) return false;
  if (row.expiresAt.getTime() <= now) return false;
  return !wifiSessionIdle(row, now);
}

/**
 * Turn it on or off for one of a person's Wi-Fi sign-ins. Callers check who is
 * asking first (`routes/devices.ts`).
 *
 * @param userId - Whose sign-in.
 * @param sessionId - The sign-in.
 * @param on - On or off.
 * @param now - The current time, for tests.
 * @returns Whether a Wi-Fi sign-in of theirs was changed.
 */
export function setWifiAgentTurns(
  userId: string,
  sessionId: string,
  on: boolean,
  now = Date.now()
): boolean {
  const db = readAuthDb();
  if (!db) return false;
  const result = db
    .update(session)
    .set({ wifiAgentTurnsAt: on ? new Date(now) : null })
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), eq(session.route, 'wifi')))
    .run();
  return result.changes > 0;
}
