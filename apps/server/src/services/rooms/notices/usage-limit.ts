/**
 * Whether a failed room turn failed because its account ran out of usage
 * (DOR-2823), so the room can say when the agent can answer again instead of
 * "ran into a problem".
 *
 * @module server/services/rooms/notices/usage-limit
 */
import { getSessionLimitStore } from '../../session/fleet/session-limit-store.js';

/** A usage limit as the session limit store keeps it. */
export interface StoredUsageLimit {
  /** When it resets (ISO 8601), or `null` when unknown. */
  resetsAt: string | null;
}

/**
 * The usage limit a chat is under right now, if any.
 *
 * @param lookup - Reads the limit a chat's account hit during its last turn.
 *   Absent in a harness without the limit store.
 * @param sessionId - The chat as it is bound now: a first turn may have
 *   renamed it, and the limit is filed under the new name.
 * @param now - The current time, in ms.
 * @returns The limit, or `null` for none or for one whose reset is already
 *   past (a stale row, not why this turn failed).
 */
export function usageLimitNow(
  lookup: ((sessionId: string) => StoredUsageLimit | null) | undefined,
  sessionId: string,
  now = Date.now()
): StoredUsageLimit | null {
  const stored = lookup?.(sessionId) ?? null;
  if (stored === null) return null;
  return stored.resetsAt === null || Date.parse(stored.resetsAt) > now ? stored : null;
}

/**
 * The usage limit a chat's account hit during its last turn, read from the
 * session limit store at the moment of failure, never cached.
 *
 * @param sessionId - The chat.
 * @returns When it resets, or `null` when the chat is under no limit.
 */
export function storedUsageLimit(sessionId: string): StoredUsageLimit | null {
  const stored = getSessionLimitStore()?.get(sessionId);
  if (!stored || stored.state === 'reset-ready' || stored.state === 'moved') return null;
  return { resetsAt: stored.limit.resetsAt ?? null };
}
