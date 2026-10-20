/**
 * Whether a chat's latest turn read words DorkOS cannot vouch for, kept on the
 * chat's row so it outlives a restart (DOR-3037).
 *
 * A turn a Wi-Fi sign-in started (or a stranger's) runs at the runtime's
 * default at most. Every turn that later picks the same chat up on its own,
 * with nobody newly asking — an approval's answer delivered, an automatic
 * resume or handoff after a usage limit, a nudge after a sign-in, a wake after
 * a restart cut background work short — would otherwise run at the agent's own
 * level on that turn's words. {@link ceilingForContinuation} is the one answer
 * those paths ask.
 *
 * Written by the turn-level seam on every turn (`recordTurnLevels`), and only
 * when the answer changes, so the hot path adds no write for an ordinary turn.
 * A chat with no record (never ran since this existed, or no database) reads as
 * held: an automatic path errs toward asking.
 *
 * @module services/core/turn-power/continuation-hold
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';

let db: Db | undefined;

/** What this process last wrote per chat, so an unchanged answer writes nothing. */
const written = new Map<string, boolean>();

/** How many chats the write cache remembers; the oldest go first. */
const WRITTEN_MAX = 10_000;

/**
 * Hand over (or clear) the database the hold is kept in.
 *
 * @param handle - The consolidated database; `undefined` clears it.
 */
export function setContinuationHoldDb(handle: Db | undefined): void {
  db = handle;
  written.clear();
}

/**
 * Record whether a chat's latest turn read outsider words. Never throws: a
 * failed write leaves the last answer, and no record reads as held.
 *
 * @param sessionId - The id the turn was sent under.
 * @param held - Whether the turn read words DorkOS cannot vouch for.
 */
export function noteTurnHold(sessionId: string, held: boolean): void {
  if (!db) return;
  const key = primaryOf(sessionId);
  if (written.get(key) === held) return;
  try {
    db.insert(sessionMetadata)
      .values({
        sessionId: key,
        runtime: null,
        createdAt: new Date().toISOString(),
        lastTurnHeld: held,
      })
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { lastTurnHeld: held } })
      .run();
    written.delete(key);
    written.set(key, held);
    if (written.size > WRITTEN_MAX) written.delete(written.keys().next().value as string);
  } catch (err) {
    logger.warn('[continuation-hold] could not record the turn hold', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether a chat's latest turn was held: read under the chat's first id, and
 * `true` when nothing is recorded or the record cannot be read.
 *
 * @param sessionId - The chat.
 */
export function lastTurnHeld(sessionId: string): boolean {
  const key = primaryOf(sessionId);
  const cached = written.get(key);
  if (cached !== undefined) return cached;
  if (!db) return true;
  try {
    const row = db
      .select({ held: sessionMetadata.lastTurnHeld })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, key))
      .get();
    return row?.held !== false;
  } catch {
    return true;
  }
}

/**
 * The ceiling a turn that picks a chat up on its own carries, as the spread a
 * dispatch takes: the runtime's default when the chat's latest turn was held
 * (or nothing is recorded), nothing otherwise.
 *
 * @param sessionId - The chat.
 */
export function ceilingForContinuation(sessionId: string): {
  permissionCeiling?: TurnPermissionBound;
} {
  return lastTurnHeld(sessionId) ? { permissionCeiling: 'runtime-default' } : {};
}
