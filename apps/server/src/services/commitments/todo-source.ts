/**
 * What a to-do's source message is, read by the server itself (DOR-3088, Security's PR 4 check):
 * who wrote it and the marks their words carry. Never taken from the caller, so a to-do made from
 * an outsider's message keeps the outsider's mark however it was asked for.
 *
 * @module services/commitments/todo-source
 */
import { and, authors, eq, roomEntries, roomMembers, type Db } from '@dorkos/db';
import { COMMITMENT_WHAT_MAX } from '@dorkos/shared/commitment-schemas';
import { readOwnerAccount } from '../core/auth/index.js';
import { isOwnerRecord, toRecord } from '../rooms/author-registry.js';
import {
  mergeMarks,
  NO_MARKS,
  parseStoredMarks,
  type TurnMarks,
} from '../core/turn-power/turn-marks.js';

/** The outsider mark alone: words DorkOS cannot vouch for. */
const OUTSIDER: TurnMarks = Object.freeze({ outsider: true });

/** A source message, as the server read it. */
export interface TodoSourceFacts {
  /** The entry. */
  readonly entryId: string;
  /** The room it is in. */
  readonly roomId: string;
  /** Who wrote it, by name. */
  readonly author: string;
  /** The marks its author's words carry. */
  readonly marks: TurnMarks;
  /** Its text, as stored. */
  readonly text: string;
}

/** One line, trimmed and with its runs of spaces collapsed, for comparing titles. */
function normalizedLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Whether a to-do's title is still its source's words (Security's PR 4 G3): the title the person
 * or agent sent matches the source message's first line, decided here from the stored message and
 * never taken from the caller. A title they rewrote is their own words.
 *
 * The app prefills a first line longer than the title's limit cut to that limit, so a title at the
 * limit that starts the longer line still counts. Nothing shorter does: a few words lifted from
 * the start of a message are the writer's choice, not the source's line.
 *
 * @param what - The title being saved.
 * @param facts - The source message, as the server read it.
 */
export function titleIsFromSource(what: string, facts: Pick<TodoSourceFacts, 'text'>): boolean {
  const firstLine = facts.text.split('\n').find((line) => line.trim() !== '') ?? '';
  const title = normalizedLine(what);
  const source = normalizedLine(firstLine);
  if (title === '') return false;
  if (title === source) return true;
  const cutAtLimit =
    what.trim().length === COMMITMENT_WHAT_MAX && firstLine.trim().length > COMMITMENT_WHAT_MAX;
  return cutAtLimit && source.startsWith(title);
}

/**
 * Read a source message's author and marks.
 *
 * - The owner's own words (`isOwnerRecord`, the rooms' own check): whatever marks the post kept
 *   (none, for a person typing).
 * - Any other person (a guest, a bridged chat's user): the outsider mark, always.
 * - An agent's or DorkOS's own post: the marks it was written under, and the outsider mark when
 *   nobody recorded any. A post nobody can vouch for is never read as clean.
 *
 * @param db - The DorkOS database.
 * @param entryId - The room entry.
 * @returns The facts, or undefined when no such entry exists.
 */
export function readTodoSourceFacts(db: Db, entryId: string): TodoSourceFacts | undefined {
  const row = db
    .select({
      roomId: roomEntries.roomId,
      turnMarks: roomEntries.turnMarks,
      body: roomEntries.body,
      author: authors,
    })
    .from(roomEntries)
    .innerJoin(authors, eq(authors.id, roomEntries.authorId))
    .where(eq(roomEntries.id, entryId))
    .get();
  if (!row) return undefined;
  const kept = row.turnMarks === null ? undefined : parseStoredMarks(row.turnMarks);
  const author = toRecord(row.author);
  let marks: TurnMarks;
  if (isOwnerRecord(author, readOwnerAccount()?.id ?? null)) marks = kept ?? NO_MARKS;
  else if (author.kind === 'human') marks = mergeMarks(kept ?? NO_MARKS, OUTSIDER);
  else marks = kept ?? OUTSIDER;
  let text: string;
  try {
    const body = JSON.parse(row.body) as { text?: unknown };
    text = typeof body.text === 'string' ? body.text : '';
  } catch {
    text = '';
  }
  return { entryId, roomId: row.roomId, author: author.displayName, marks, text };
}

/**
 * Whether an agent is a member of a room: what lets a to-do it makes cite a message there.
 *
 * @param db - The DorkOS database.
 * @param roomId - The room.
 * @param agentPath - The agent's home folder (its author's natural key).
 */
export function agentInRoom(db: Db, roomId: string, agentPath: string): boolean {
  return (
    db
      .select({ authorId: roomMembers.authorId })
      .from(roomMembers)
      .innerJoin(authors, eq(authors.id, roomMembers.authorId))
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(authors.kind, 'agent'),
          eq(authors.naturalKey, agentPath)
        )
      )
      .get() !== undefined
  );
}
