/**
 * The marks each chat carries for the turns that pick it up on their own, kept on the chat's row
 * so they outlive a restart (DOR-3061, `specs/turn-marks/design-note.md`).
 *
 * A turn a Wi-Fi sign-in, a stranger or a teammate reached carries its marks to everything it
 * sends. Some turns are sent by nobody, though: they pick the same chat up on their own, with no
 * new words from anyone. An approval's answer delivered, an automatic resume or handoff after a
 * usage limit, a nudge after a sign-in, a wake after a restart cut background work short, a
 * compaction. Each would otherwise run at the agent's own level on marked words, so each reads
 * {@link continuationCeiling}, the one answer for "what does picking this chat up carry". The
 * continuation census (`chat-marks.census.test.ts`) fails on a turn start that is neither.
 *
 * **Only a person clears them.** Every turn adds its marks to what the chat keeps. The one turn
 * that may clear them is a person's own message from a control panel that carries no mark
 * ({@link notePersonMessage}): an agent's `chat_send`, a relayed message, a schedule, a beat and
 * every automatic continuation only ever add.
 *
 * **Keys.** Rows are kept under the chat's durable id ({@link queueKeyOf}), the one its rows move
 * to when the runtime renames it mid-first-turn, and `rekeySessionSettings` merges the marks of
 * both ids when it moves a row ({@link mergeStoredChatMarks}). A row left under another id the
 * chat answers to is folded in when read and cleared on the next write.
 *
 * **Unknown is marked.** A chat with no row at all reads as carrying the outsider mark: an
 * automatic path errs toward asking. Rows that existed before this column were backfilled with
 * `{}` by its migration, so an owner's existing chats continue as they did.
 *
 * @module services/core/turn-power/chat-marks
 */
import { and, inArray, isNull, sessionMetadata, type Db } from '@dorkos/db';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { primaryOf, queueKeyOf } from '../../session/resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';
import {
  ceilingCarrying,
  hasMarks,
  mergeMarks,
  NO_MARKS,
  parseStoredMarks,
  type TurnMarks,
} from './turn-marks.js';

let db: Db | undefined;

/** What this process last knew per chat (as JSON), so unchanged marks write nothing. */
const known = new Map<string, string>();

/** How many chats the cache remembers; the oldest go first. */
const KNOWN_MAX = 10_000;

/** What a chat with no record carries: the outsider mark, the fail-closed answer. */
const UNKNOWN: TurnMarks = Object.freeze({ outsider: true });

/** Messages a person typed at a control panel, by id, newest last. */
const personMessages = new Set<string>();

/** How many such messages are remembered; a message runs or is gone long before this many. */
const PERSON_MESSAGE_MEMORY = 10_000;

/**
 * Remember that a person typed this message at a control panel (the `interactive` origin), so
 * its turn, when it carries no mark, may clear what the chat keeps. Every other turn only adds.
 *
 * @param messageId - The message's id, which its turn is sent with (`MessageOpts.messageId`).
 */
export function notePersonMessage(messageId: string): void {
  personMessages.delete(messageId);
  personMessages.add(messageId);
  if (personMessages.size > PERSON_MESSAGE_MEMORY) {
    personMessages.delete(personMessages.values().next().value as string);
  }
}

/**
 * Whether a turn sent with this message id carries a person's own message.
 *
 * @param messageId - The id the turn was sent with, if any.
 */
export function isPersonMessage(messageId: string | undefined): boolean {
  return messageId !== undefined && personMessages.has(messageId);
}

/**
 * Hand over (or clear) the database the marks are kept in.
 *
 * @param handle - The consolidated database; `undefined` clears it.
 */
export function setChatMarksDb(handle: Db | undefined): void {
  db = handle;
  known.clear();
}

/** Remember what a chat carries, dropping the oldest past the bound. */
function remember(key: string, marks: TurnMarks): void {
  known.delete(key);
  known.set(key, JSON.stringify(marks));
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value as string);
}

/** Every id a chat's row may sit under: its durable id first, then the others it answers to. */
function idsOf(sessionId: string): { key: string; others: string[] } {
  const key = queueKeyOf(sessionId);
  const others = [...new Set([primaryOf(sessionId), sessionId])].filter((id) => id !== key);
  return { key, others };
}

/**
 * What a chat is known to carry: every recorded mark under any id it answers to, or `undefined`
 * when nothing is recorded. Throws when the rows cannot be read.
 */
function recorded(sessionId: string): TurnMarks | undefined {
  const { key, others } = idsOf(sessionId);
  const cached = known.get(key);
  if (cached !== undefined) return parseStoredMarks(cached);
  if (!db) return undefined;
  const rows = db
    .select({ marks: sessionMetadata.lastTurnMarks })
    .from(sessionMetadata)
    .where(inArray(sessionMetadata.sessionId, [key, ...others]))
    .all();
  const stored = rows.flatMap((row) => (row.marks === null ? [] : [parseStoredMarks(row.marks)]));
  return stored.length === 0 ? undefined : stored.reduce(mergeMarks, NO_MARKS);
}

/**
 * Record a turn's marks on its chat. A person's own unmarked turn clears what the chat carried;
 * every other turn adds its marks to it. Never throws: when the write fails, this process still
 * answers with the new, stronger marks rather than the old ones.
 *
 * @param sessionId - The id the turn was sent under.
 * @param marks - The marks the turn carries; none for an unmarked turn.
 * @param personTurn - Whether the turn's words are a person's own ({@link isPersonMessage}).
 */
export function noteChatMarks(sessionId: string, marks: TurnMarks, personTurn: boolean): void {
  const { key, others } = idsOf(sessionId);
  let next: TurnMarks;
  if (personTurn && !hasMarks(marks)) {
    next = NO_MARKS;
  } else {
    let before: TurnMarks;
    try {
      // A chat with no record yet has carried nothing before this turn.
      before = recorded(sessionId) ?? NO_MARKS;
    } catch {
      before = UNKNOWN;
    }
    next = mergeMarks(before, marks);
  }
  const stored = JSON.stringify(next);
  if (known.get(key) === stored) return;
  remember(key, next);
  if (!db) return;
  const handle = db;
  try {
    handle.transaction((tx) => {
      tx.insert(sessionMetadata)
        .values({
          sessionId: key,
          runtime: null,
          createdAt: new Date().toISOString(),
          lastTurnMarks: stored,
        })
        .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { lastTurnMarks: stored } })
        .run();
      if (others.length === 0) return;
      // Marks left under an id the chat answered to before its rename were folded in above.
      tx.update(sessionMetadata)
        .set({ lastTurnMarks: null })
        .where(inArray(sessionMetadata.sessionId, others))
        .run();
      // A row that held nothing but those marks is gone entirely.
      tx.delete(sessionMetadata)
        .where(
          and(
            inArray(sessionMetadata.sessionId, others),
            isNull(sessionMetadata.runtime),
            isNull(sessionMetadata.agentPath),
            isNull(sessionMetadata.launchOrigin),
            isNull(sessionMetadata.lastAutoResumeFor),
            isNull(sessionMetadata.permissionMode),
            isNull(sessionMetadata.model),
            isNull(sessionMetadata.effort),
            isNull(sessionMetadata.fastMode)
          )
        )
        .run();
    });
  } catch (err) {
    logger.warn('[chat-marks] could not record the turn marks', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The marks a chat carries for the turns that pick it up on their own, and the outsider mark when
 * nothing is recorded or the record cannot be read.
 *
 * @param sessionId - The chat, by any id it answers to.
 */
export function chatMarksOf(sessionId: string): TurnMarks {
  try {
    return recorded(sessionId) ?? UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * The ceiling a turn that picks a chat up on its own carries, as the spread a dispatch takes: a
 * ceiling carrying the chat's marks (`ceilingCarrying`: the runtime default, the Wi-Fi level, a
 * teammate's read-only level), or nothing when it carries none.
 *
 * @param sessionId - The chat.
 */
export function continuationCeiling(sessionId: string): {
  permissionCeiling?: TurnPermissionCeiling;
} {
  const ceiling = ceilingCarrying(chatMarksOf(sessionId));
  return ceiling === undefined ? {} : { permissionCeiling: ceiling };
}

/**
 * Both rows' stored marks together, for a row moving onto another id: `null` only when neither
 * recorded any.
 *
 * @param a - One row's `last_turn_marks`.
 * @param b - The other's.
 */
export function mergeStoredChatMarks(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return JSON.stringify(mergeMarks(parseStoredMarks(a), parseStoredMarks(b)));
}

/**
 * Forget what this process remembers for both ids of a chat being renamed, so the next read
 * comes from the moved row.
 *
 * @param fromId - The id the row moved from.
 * @param toId - The id it moved to.
 */
export function forgetChatMarksOf(fromId: string, toId: string): void {
  known.delete(fromId);
  known.delete(toId);
}
