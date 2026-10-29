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
 * Written by the turn-level seam on every turn a person, an agent or a stranger
 * starts (`recordTurnLevels`), and only when the answer changes, so the hot path
 * adds no write for an ordinary turn. A turn this hold itself clamped
 * (`MessageOpts.continuationHold`) writes nothing: it read no new words, so it
 * leaves the answer the last real turn gave.
 *
 * A chat with no record reads as NOT held (DOR-3203). Only a turn that really
 * read words DorkOS cannot vouch for writes `true`, and every chat that ran
 * before the column existed is settled to `false` by its migration; reading
 * "nothing recorded" as held clamped every such chat woken after the 0.124.1
 * upgrade, and each clamped turn then recorded itself as held. A record that
 * exists but cannot be READ is the other case: it may say held, so it is.
 *
 * @module services/core/turn-power/continuation-hold
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
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
  carriedOnly.clear();
}

/**
 * Chats whose latest marked turn only CARRIED an outsider's words on (DOR-3390): our own agent's
 * post or message passed them, no stranger's turn held it. Kept in memory only, so after a
 * restart every held row reads as a stranger's again: the strict answer.
 */
const carriedOnly = new Set<string>();

/**
 * Record whether a chat's latest turn read outsider words. Never throws: a
 * failed write leaves the last answer.
 *
 * @param sessionId - The id the turn was sent under.
 * @param held - Whether the turn read words DorkOS cannot vouch for.
 * @param carried - Whether it only carried them on, held for no stranger (DOR-3390).
 */
export function noteTurnHold(sessionId: string, held: boolean, carried = false): void {
  const key = primaryOf(sessionId);
  carriedOnly.delete(key);
  if (held && carried) {
    carriedOnly.add(key);
    if (carriedOnly.size > WRITTEN_MAX) carriedOnly.delete(carriedOnly.values().next().value!);
  }
  if (!db) return;
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
 * Whether a chat's latest turn was held, read under the chat's first id.
 * `false` when nothing is recorded, or when there is no database to record in
 * (tests, and nothing writes a hold there either); `true` when the record
 * cannot be read, since it may say held.
 *
 * @param sessionId - The chat.
 */
export function lastTurnHeld(sessionId: string): boolean {
  const key = primaryOf(sessionId);
  const cached = written.get(key);
  if (cached !== undefined) return cached;
  if (!db) return false;
  try {
    const row = db
      .select({ held: sessionMetadata.lastTurnHeld })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, key))
      .get();
    return row?.held === true;
  } catch (err) {
    logger.warn('[continuation-hold] could not read the turn hold; holding the turn', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * The ceiling a turn that picks a chat up on its own carries, as the spread a
 * dispatch takes: the runtime's default when the chat's latest turn was held,
 * nothing otherwise. The hold is named as a continuation's
 * (`continuationHold`), so the turn it clamps is held in power only: it
 * neither records itself as held nor marks what it posts as an outsider's.
 *
 * @param sessionId - The chat.
 */
export function ceilingForContinuation(sessionId: string): {
  permissionCeiling?: TurnPermissionBound;
  continuationHold?: true;
} {
  if (!lastTurnHeld(sessionId)) return {};
  // A chat that only carried an outsider's words on stays marked and runs at its own level
  // (DOR-3390): the words are still in it, and the mark gates the risky actions.
  if (carriedOnly.has(primaryOf(sessionId))) return { permissionCeiling: CARRIED_OUTSIDER_LEVEL };
  return { permissionCeiling: 'runtime-default', continuationHold: true };
}

/**
 * The bound a turn that READS a held chat's words in its seed carries (an automatic carry-over):
 * the carried outsider mark when the chat only carried them on (DOR-3390), the runtime's default
 * otherwise, and nothing when its latest turn was not held.
 *
 * @param sessionId - The chat whose words are carried over.
 */
export function heldBoundFor(sessionId: string): TurnPermissionBound | undefined {
  if (!lastTurnHeld(sessionId)) return undefined;
  return carriedOnly.has(primaryOf(sessionId)) ? CARRIED_OUTSIDER_LEVEL : 'runtime-default';
}
