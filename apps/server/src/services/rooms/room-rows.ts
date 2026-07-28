/**
 * The mapping between a room table row and its `@dorkos/shared/room-schemas`
 * type, plus the insert shapes {@link RoomStore} takes.
 *
 * Split from `room-store.ts` so that file is queries and this one is shapes.
 * SQLite has no enums and no JSON columns, so every read narrows a `text`
 * column back onto a union and parses two JSON payloads — mechanical work that
 * would otherwise be interleaved with every query in the store.
 *
 * @module server/services/rooms/room-rows
 */
import type { rooms, roomMembers, roomEntries } from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type {
  Room,
  RoomEntry,
  RoomEntryBody,
  RoomEntryKind,
  RoomKind,
  RoomMember,
} from '@dorkos/shared/room-schemas';

/** A stored room row. */
export type RoomRow = typeof rooms.$inferSelect;
/** A stored membership row. */
export type RoomMemberRow = typeof roomMembers.$inferSelect;
/** A stored entry row. */
export type RoomEntryRow = typeof roomEntries.$inferSelect;

/** What {@link RoomStore.createRoom} needs. Every column, explicitly. */
export interface NewRoom {
  id: string;
  kind: RoomKind;
  parentId: string | null;
  slug: string | null;
  title: string;
  topic: string | null;
  workspaceId: string | null;
  rootEntryId: string | null;
  createdAt: string;
}

/** What {@link RoomStore.appendEntry} needs, minus the `seq` it allocates. */
export interface NewRoomEntry {
  roomId: string;
  id: string;
  authorId: string;
  kind: RoomEntryKind;
  body: RoomEntryBody;
  mentions: readonly string[];
  sessionId: string | null;
  cascadeRoot: string;
  cascadeDepth: number;
  /** The entry this one answers, or null for a top-level entry. */
  parentEntryId: string | null;
  /** The head of this entry's thread, or null when it is top-level. */
  threadRootEntryId: string | null;
  createdAt: string;
}

/**
 * Narrow a room row's stringly-typed `kind` onto the domain union.
 *
 * @param row - The stored row.
 */
export function toRoom(row: RoomRow): Room {
  return { ...row, kind: row.kind as RoomKind };
}

/**
 * Narrow a membership row's `response_mode` onto the shared enum.
 *
 * @param row - The stored row.
 */
export function toMember(row: RoomMemberRow): RoomMember {
  return { ...row, responseMode: row.responseMode as ResponseMode };
}

/**
 * Narrow an entry row, parsing its two JSON columns.
 *
 * We author both, so a parse failure is a corrupted row rather than untrusted
 * input. It degrades to an empty mention list and a body carrying the raw text,
 * so one bad row costs one message's formatting instead of throwing a whole
 * room's history.
 *
 * @param row - The stored row.
 */
export function toEntry(row: RoomEntryRow): RoomEntry {
  return {
    ...row,
    kind: row.kind as RoomEntryKind,
    body: parseJson<RoomEntryBody>(row.body, { text: row.body }),
    mentions: parseJson<string[]>(row.mentions, []),
  };
}

/** Parse a column we wrote as JSON, falling back rather than throwing. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
