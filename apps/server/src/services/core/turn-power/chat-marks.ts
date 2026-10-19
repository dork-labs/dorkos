/**
 * Each chat's latest turn's marks, kept on the chat's row so they outlive a restart (DOR-3061,
 * `specs/turn-marks/design-note.md`).
 *
 * A turn a Wi-Fi sign-in, a stranger or a teammate reached carries its marks to everything it
 * sends. Some turns are sent by nobody, though: they pick the same chat up on their own, with no
 * new words from anyone. An approval's answer delivered, an automatic resume or handoff after a
 * usage limit, a nudge after a sign-in, a wake after a restart cut background work short. Each
 * would otherwise run at the agent's own level on the marked turn's words, so each reads
 * {@link ceilingForContinuation}, the one answer for "what does picking this chat up carry".
 * The continuation census (`chat-marks.census.test.ts`) fails on a dispatch that is neither.
 *
 * Written by the turn-level seam on every turn (`recordTurnLevels`), and only when the marks
 * change, so the hot path adds no write for an ordinary turn. A chat with no record (it never ran
 * since this existed, the row cannot be read, or there is no database) is read as unknown, which
 * carries the outsider mark: an automatic path errs toward asking.
 *
 * @module services/core/turn-power/chat-marks
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';
import { ceilingCarrying, parseStoredMarks, type TurnMarks } from './turn-marks.js';

let db: Db | undefined;

/** What this process last wrote per chat (as JSON), so unchanged marks write nothing. */
const written = new Map<string, string>();

/** How many chats the write cache remembers; the oldest go first. */
const WRITTEN_MAX = 10_000;

/** What a chat with no record carries: the outsider mark, the fail-closed answer. */
const UNKNOWN: TurnMarks = Object.freeze({ outsider: true });

/**
 * Hand over (or clear) the database the marks are kept in.
 *
 * @param handle - The consolidated database; `undefined` clears it.
 */
export function setChatMarksDb(handle: Db | undefined): void {
  db = handle;
  written.clear();
}

/** Remember what was last written for a chat, dropping the oldest past the bound. */
function remember(key: string, stored: string): void {
  written.delete(key);
  written.set(key, stored);
  if (written.size > WRITTEN_MAX) written.delete(written.keys().next().value as string);
}

/**
 * Record the marks a chat's latest turn carries. Never throws: a failed write leaves the last
 * answer in place, and a chat with no record reads as unknown.
 *
 * @param sessionId - The id the turn was sent under.
 * @param marks - The marks the turn carries; none for an unmarked turn.
 */
export function noteChatMarks(sessionId: string, marks: TurnMarks): void {
  const key = primaryOf(sessionId);
  const stored = JSON.stringify(marks);
  if (written.get(key) === stored) return;
  if (!db) {
    // No database (a unit test, an embedded boot): this process still knows what it ran.
    remember(key, stored);
    return;
  }
  try {
    db.insert(sessionMetadata)
      .values({
        sessionId: key,
        runtime: null,
        createdAt: new Date().toISOString(),
        lastTurnMarks: stored,
      })
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { lastTurnMarks: stored } })
      .run();
    remember(key, stored);
  } catch (err) {
    logger.warn('[chat-marks] could not record the turn marks', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The marks a chat's latest turn carried: read under the chat's first id, and the outsider mark
 * when nothing is recorded or the record cannot be read.
 *
 * @param sessionId - The chat.
 */
export function chatMarksOf(sessionId: string): TurnMarks {
  const key = primaryOf(sessionId);
  const cached = written.get(key);
  if (cached !== undefined) return parseStoredMarks(cached);
  if (!db) return UNKNOWN;
  try {
    const row = db
      .select({ marks: sessionMetadata.lastTurnMarks })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, key))
      .get();
    if (!row || row.marks === null) return UNKNOWN;
    return parseStoredMarks(row.marks);
  } catch {
    return UNKNOWN;
  }
}

/**
 * The ceiling a turn that picks a chat up on its own carries, as the spread a dispatch takes: a
 * ceiling carrying the latest turn's marks (`ceilingCarrying`: the runtime default, the Wi-Fi
 * level, a teammate's read-only level), or nothing when that turn carried none.
 *
 * @param sessionId - The chat.
 */
export function ceilingForContinuation(sessionId: string): {
  permissionCeiling?: TurnPermissionCeiling;
} {
  const ceiling = ceilingCarrying(chatMarksOf(sessionId));
  return ceiling === undefined ? {} : { permissionCeiling: ceiling };
}
