/**
 * Building a room's export, line by line (DOR-1225).
 *
 * The whole shape of `GET /api/rooms/:id/export` lives here: the header, every
 * entry, the trailing receipt, and the paging loop that walks a log with no
 * upper bound. {@link RoomService.exportRoom} is the only caller — it decides
 * WHO may export and HOW MUCH, and hands the answer over as a
 * {@link RoomExportSource}.
 *
 * **The split is the point.** Everything the export needs arrives as data or as
 * a reader function, so this module holds no reference to the store, the roster
 * or the registry — which is what makes "an export is read-only" structural
 * rather than a promise in a comment. The database stays the truth; the file is
 * a copy, never a sync target.
 *
 * @module server/services/rooms/room-export
 */
import {
  ROOM_EXPORT_FORMAT,
  ROOM_EXPORT_VERSION,
  type RoomExportAuthor,
  type RoomExportEntry,
  type RoomExportHeader,
  type RoomExportLine,
  type RoomExportMember,
  type RoomExportScope,
} from '@dorkos/shared/room-export-schemas';
import type { Room, RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { toAuthorRef, type AuthorRecord } from './author-registry.js';

/**
 * How many entries one page of an export reads.
 *
 * Matched to the reaction/attachment roll-up chunk in `room-service.ts` (500),
 * so a page costs one query for each rather than two.
 */
const EXPORT_PAGE_ENTRIES = 500;

/**
 * Resolves an author id to the identity an export line carries.
 *
 * A function rather than a map so the caller decides how to look one up — the
 * service memoizes a registry read, the tests hand over a literal.
 */
export type ExportAuthorResolver = (authorId: string) => RoomExportAuthor;

/**
 * Everything an export needs, with nothing left for this module to fetch.
 *
 * A reader function rather than a store handle, because the page it returns has
 * already had its reactions and attachments rolled up — that is a service
 * concern, and passing the store would have dragged the roll-up in with it.
 */
export interface RoomExportSource {
  /** The room being copied, as it stands. */
  room: Room;
  /** Its roster, oldest membership first. */
  members: readonly RoomRosterEntry[];
  /** Who asked for the file. */
  exportedBy: RoomExportAuthor;
  /** The version writing it. */
  dorkosVersion: string;
  /** When it was written, ISO 8601. */
  exportedAt: string;
  /** How much of the room this file holds, and why. */
  scope: RoomExportScope;
  /** How to turn an author id into an identity. */
  resolve: ExportAuthorResolver;
  /**
   * One forward page of the room's log, oldest first, strictly above `afterSeq`
   * and at most `limit` long — with reactions and attachments already attached.
   * Threads included: an export is a copy of the room, not a view of it.
   */
  page: (afterSeq: number, limit: number) => readonly RoomEntry[];
}

/**
 * An author resolver that reads each id through `lookup` at most once.
 *
 * An export names the same handful of authors on every line — that repetition is
 * the point, since it is what makes the file greppable — so without the cache a
 * thousand-message room would be a thousand indexed reads of the same three rows.
 *
 * @param lookup - How to read one stored author, or `null` when none has that id.
 */
export function createExportAuthorResolver(
  lookup: (authorId: string) => AuthorRecord | null
): ExportAuthorResolver {
  const seen = new Map<string, RoomExportAuthor>();
  return (authorId) => {
    const hit = seen.get(authorId);
    if (hit) return hit;
    // A retired author still wrote what they wrote. Keeping the id with an
    // honest placeholder is the only answer that does not quietly change what
    // the room said.
    const record = lookup(authorId);
    const resolved = record ? toExportAuthor(record) : unknownExportAuthor(authorId);
    seen.set(authorId, resolved);
    return resolved;
  };
}

/**
 * The export itself: a header, every entry in ascending `seq`, then the receipt.
 *
 * **A generator, because a room's log is never trimmed.** The lines come out one
 * at a time and the route writes each as it arrives, so a ten-year channel is
 * never assembled in memory before the download can start. That is also why the
 * header cannot state a count and why the last line is a `summary`: a truncated
 * download is otherwise a perfectly valid file of the messages that made it,
 * with nothing inside it saying so.
 *
 * @param source - The room, the roster, the scope, and how to read a page.
 * @yields Each line of the export, in file order.
 */
export function* buildRoomExport(source: RoomExportSource): Generator<RoomExportLine> {
  yield toExportHeader(source);

  let cursor = source.scope.fromSeq;
  let entryCount = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  for (;;) {
    const page = source.page(cursor, EXPORT_PAGE_ENTRIES);
    if (page.length === 0) break;
    for (const entry of page) {
      yield toExportEntry(entry, source.resolve);
      entryCount += 1;
      firstSeq ??= entry.seq;
      lastSeq = entry.seq;
    }
    cursor = page[page.length - 1].seq;
    if (page.length < EXPORT_PAGE_ENTRIES) break;
  }

  yield { type: 'summary', entryCount, firstSeq, lastSeq };
}

/**
 * The identity fields an export keeps, out of a stored author.
 *
 * The render cache (`emoji`, `color`, `imageUrl`) is deliberately dropped: those
 * three point at state on this machine, and a file somebody took with them when
 * they left cannot resolve them.
 *
 * @param record - The stored author.
 */
function toExportAuthor(record: AuthorRecord): RoomExportAuthor {
  const ref = toAuthorRef(record);
  return {
    id: ref.id,
    kind: ref.kind,
    displayName: ref.displayName,
    handle: ref.handle,
    ...(ref.agentRef ? { agentRef: ref.agentRef } : {}),
  };
}

/**
 * The identity an export falls back to when an id resolves to nothing.
 *
 * A reaction or a mention can name an author whose row has since been retired,
 * and dropping it would silently change what the room said. The line keeps the
 * id and says plainly that the name is gone.
 *
 * @param authorId - The id that resolved to no row.
 */
function unknownExportAuthor(authorId: string): RoomExportAuthor {
  return { id: authorId, kind: 'system', displayName: 'Unknown author', handle: null };
}

/**
 * One roster row, as the header lists it.
 *
 * @param member - The membership with its author already resolved.
 */
function toExportMember(member: RoomRosterEntry): RoomExportMember {
  return {
    author: {
      id: member.author.id,
      kind: member.author.kind,
      displayName: member.author.displayName,
      handle: member.author.handle,
      ...(member.author.agentRef ? { agentRef: member.author.agentRef } : {}),
    },
    responseMode: member.responseMode,
    joinedAt: member.joinedAt,
    joinedSeq: member.joinedSeq,
  };
}

/**
 * Build the header line — the first line of every export.
 *
 * @param input.room - The room being copied.
 * @param input.members - Its roster, oldest membership first.
 * @param input.exportedBy - Who asked for the file.
 * @param input.exportedAt - When it was written, ISO 8601.
 * @param input.dorkosVersion - The version that wrote it.
 * @param input.scope - How much of the room the file holds, and why.
 */
function toExportHeader(input: {
  room: Room;
  members: readonly RoomRosterEntry[];
  exportedBy: RoomExportAuthor;
  exportedAt: string;
  dorkosVersion: string;
  scope: RoomExportScope;
}): RoomExportHeader {
  return {
    type: 'room-export',
    format: ROOM_EXPORT_FORMAT,
    version: ROOM_EXPORT_VERSION,
    exportedAt: input.exportedAt,
    exportedBy: input.exportedBy,
    dorkosVersion: input.dorkosVersion,
    room: {
      id: input.room.id,
      kind: input.room.kind,
      slug: input.room.slug,
      title: input.room.title,
      topic: input.room.topic,
      archived: input.room.archived,
      wellKnown: input.room.wellKnown ?? null,
      createdAt: input.room.createdAt,
      lastActivityAt: input.room.lastActivityAt,
    },
    members: input.members.map(toExportMember),
    scope: input.scope,
  };
}

/**
 * Build one entry line.
 *
 * **Every author id on the line is resolved here**, not left for a reader to
 * join against the header: the message's author, everyone it mentioned, and
 * everyone behind each reaction. That repetition is what makes the file
 * greppable — one line answers who said what to whom.
 *
 * @param entry - The stored entry, with its reactions and attachments already
 *   rolled up. Absent roll-ups are read as empty, exactly as the wire contract
 *   says.
 * @param resolve - How to turn an author id into an identity.
 */
function toExportEntry(entry: RoomEntry, resolve: ExportAuthorResolver): RoomExportEntry {
  return {
    type: 'entry',
    seq: entry.seq,
    id: entry.id,
    createdAt: entry.createdAt,
    kind: entry.kind,
    author: resolve(entry.authorId),
    text: entry.body.text,
    ...(entry.body.notice ? { notice: entry.body.notice } : {}),
    ...(entry.body.subjectAuthorId ? { subject: resolve(entry.body.subjectAuthorId) } : {}),
    ...(entry.body.moment ? { moment: entry.body.moment } : {}),
    mentions: entry.mentions.map(resolve),
    sessionId: entry.sessionId,
    parentEntryId: entry.parentEntryId,
    threadRootEntryId: entry.threadRootEntryId,
    reactions: (entry.reactions ?? []).map((reaction) => ({
      emoji: reaction.emoji,
      firstAt: reaction.firstAt,
      by: reaction.authorIds.map(resolve),
    })),
    attachments: entry.attachments ?? [],
  };
}
