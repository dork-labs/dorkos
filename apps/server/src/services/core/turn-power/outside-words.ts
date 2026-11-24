/**
 * Whether a chat's latest turn read words from outside the team (DOR-3440): a room turn that
 * answered or was shown a stranger's words, or a turn another chat's outside words reached
 * (DOR-4029). A stamp on what the turn saves, kept apart from the marks on purpose: it lowers
 * nothing.
 *
 * Saved with the chat (`session_outside_words`, DOR-4148), so a restart cannot clear it: a
 * spin-off a stranger’s words reached reads as noted after a restart as well as before it. Memory
 * keeps what this process last wrote or read, so an unchanged note writes nothing and a read hits
 * the database once per chat. A record that cannot be read may say noted, so it is.
 *
 * @module services/core/turn-power/outside-words
 */
import { eq, sessionOutsideWords, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

/** How many chats are remembered, oldest dropped first (as `turn-levels.ts`). */
const MEMORY = 10_000;

let db: Db | undefined;

/** What this process last wrote or read per chat id: noted, or not. */
const chats = new Map<string, boolean>();

/** Remember a chat's note, newest last, dropping the oldest past {@link MEMORY}. */
function remember(sessionId: string, noted: boolean): void {
  chats.delete(sessionId);
  chats.set(sessionId, noted);
  if (chats.size > MEMORY) chats.delete(chats.keys().next().value!);
}

/**
 * Hand over (or clear) the database the note is saved in. Forgets what this process remembered,
 * as a restart does.
 *
 * @param handle - The consolidated database; `undefined` clears it.
 */
export function setOutsideWordsDb(handle: Db | undefined): void {
  db = handle;
  chats.clear();
}

/** Whether the note's database is wired, so a failed read is a failure and not early boot. */
export function outsideWordsDbReady(): boolean {
  return db !== undefined;
}

/** Save the note, or its absence. Never throws: a failed write leaves the last saved answer. */
function save(sessionId: string, noted: boolean): void {
  if (!db) return;
  try {
    if (noted) {
      db.insert(sessionOutsideWords)
        .values({ sessionId, notedAt: new Date().toISOString() })
        .onConflictDoNothing({ target: sessionOutsideWords.sessionId })
        .run();
    } else {
      db.delete(sessionOutsideWords).where(eq(sessionOutsideWords.sessionId, sessionId)).run();
    }
  } catch (err) {
    logger.warn('[outside-words] could not save the outside-words note', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Note what a room turn answers, on every turn, so the chat's next turn starts clean.
 *
 * @param sessionId - The chat.
 * @param outside - Whether any message it answers came from outside this machine.
 */
export function noteRoomTurnWords(sessionId: string, outside: boolean): void {
  if (chats.get(sessionId) !== outside) save(sessionId, outside);
  remember(sessionId, outside);
}

/**
 * Carry a chat's outside words to the id its session goes by next: a runtime renaming a first
 * turn's session, or a room seat moving to a fresh one (Security M1 on #3576). Only ever adds,
 * and reads the saved note, so a seat moved after a restart keeps it too.
 *
 * @param from - The id the turn was noted under.
 * @param to - The id the session is known by now.
 */
export function aliasRoomTurnWords(from: string, to: string): void {
  if (from === to || !roomTurnReadOutsideWords(from)) return;
  noteRoomTurnWords(to, true);
}

/**
 * Whether this chat's latest room turn answered someone from outside this machine. `false` with no
 * database and nothing noted in this process; `true` when the saved note cannot be read.
 *
 * @param sessionId - The chat.
 */
export function roomTurnReadOutsideWords(sessionId: string): boolean {
  const known = chats.get(sessionId);
  if (known !== undefined) return known;
  if (!db) return false;
  try {
    const noted =
      db
        .select({ id: sessionOutsideWords.sessionId })
        .from(sessionOutsideWords)
        .where(eq(sessionOutsideWords.sessionId, sessionId))
        .get() !== undefined;
    remember(sessionId, noted);
    return noted;
  } catch (err) {
    logger.warn('[outside-words] could not read the outside-words note; reading it as noted', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** Room posts an agent wrote from a chat that had read outside words, newest kept. */
const posts = new Set<string>();

/**
 * Keep a room post's outside words with it when its writer's chat had read some (DOR-4023): marks
 * spread through agent hops, so the turn the post wakes counts them as its own. Called as the post
 * is written, before anything it triggers is dispatched. Kept in memory here; the post's own row
 * keeps the outsider mark for it across a restart (`room-entry-writer.ts`, DOR-4587).
 *
 * @param entryId - The post.
 * @param writers - The chats that wrote or vouch for it.
 * @param readOutside - Whether a writer's chat read outside words; the room-turn note alone by
 *   default. The rooms layer passes `chatReadOutsideWords`, which also counts a chat a stranger
 *   started, such as a Telegram chat (DOR-4029).
 */
export function carryRoomPostWords(
  entryId: string,
  writers: readonly (string | null | undefined)[],
  readOutside: (sessionId: string) => boolean = roomTurnReadOutsideWords
): void {
  if (!writers.some((sessionId) => typeof sessionId === 'string' && readOutside(sessionId))) return;
  posts.add(entryId);
  if (posts.size > MEMORY) posts.delete(posts.values().next().value!);
}

/**
 * Whether a room post carries outside words its writer's chat had read.
 *
 * @param entryId - The post.
 */
export function roomPostCarriesOutsideWords(entryId: string): boolean {
  return posts.has(entryId);
}
