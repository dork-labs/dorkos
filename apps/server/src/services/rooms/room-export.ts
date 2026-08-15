/**
 * Turning a room's rows into export lines (DOR-1225).
 *
 * The pure half of `GET /api/rooms/:id/export`: given a room, a roster and an
 * entry, produce the JSONL objects `@dorkos/shared/room-export-schemas`
 * describes. The gating, the paging and the roll-ups live on
 * {@link RoomService.exportRoom}, which is the only caller.
 *
 * **Read-only, and structurally so.** Nothing here touches the store, so no
 * amount of misuse can make an export write to the room it is copying. The
 * database stays the truth; the file is a copy, never a sync target.
 *
 * @module server/services/rooms/room-export
 */
import {
  ROOM_EXPORT_FORMAT,
  ROOM_EXPORT_VERSION,
  type RoomExportAuthor,
  type RoomExportEntry,
  type RoomExportHeader,
  type RoomExportMember,
  type RoomExportScope,
} from '@dorkos/shared/room-export-schemas';
import type { Room, RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { toAuthorRef, type AuthorRecord } from './author-registry.js';

/**
 * Resolves an author id to the identity an export line carries.
 *
 * A function rather than a map so the caller decides how to look one up — the
 * service memoizes a registry read, the tests hand over a literal.
 */
export type ExportAuthorResolver = (authorId: string) => RoomExportAuthor;

/**
 * The identity fields an export keeps, out of a stored author.
 *
 * The render cache (`emoji`, `color`, `imageUrl`) is deliberately dropped: those
 * three point at state on this machine, and a file somebody took with them when
 * they left cannot resolve them.
 *
 * @param record - The stored author.
 */
export function toExportAuthor(record: AuthorRecord): RoomExportAuthor {
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
export function unknownExportAuthor(authorId: string): RoomExportAuthor {
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
export function toExportHeader(input: {
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
export function toExportEntry(entry: RoomEntry, resolve: ExportAuthorResolver): RoomExportEntry {
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
