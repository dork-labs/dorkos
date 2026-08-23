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
  MentionSpan,
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
  slug: string | null;
  title: string;
  topic: string | null;
  workspaceId: string | null;
  /**
   * The well-known key this room answers to, for the rooms the product itself
   * opens (`'team'`). Omitted — and stored as `null` — for every room a person
   * or an agent creates, which is every room that reaches here through
   * `POST /api/rooms`: the key is what makes a room a SYSTEM room, so no
   * request body may name one.
   */
  wellKnown?: string | null;
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
  /**
   * Where each resolved `@mention` sits in `body.text`, one per written
   * `@handle`. Optional at the seam: a writer with nothing to place (a notice,
   * a test fixture) may omit it and {@link RoomStore.appendEntry} stores `[]`.
   */
  mentionSpans?: readonly MentionSpan[];
  sessionId: string | null;
  cascadeRoot: string;
  cascadeDepth: number;
  /**
   * The agent turn that wrote this entry, when one did — the dispatcher's
   * `dispatchId` (DOR-1434). Optional at the seam and stored as `null` by
   * default: a person's post, the room's own voice, and an agent post with no
   * turn behind it all have no turn to name, and a `null` row counts as one
   * turn on its own, which is what the repeat rule did for every row before
   * this column existed.
   */
  dispatchId?: string | null;
  /** The entry this one answers, or null for a top-level entry. */
  parentEntryId: string | null;
  /** The head of this entry's thread, or null when it is top-level. */
  threadRootEntryId: string | null;
  createdAt: string;
}

/**
 * One grouped row from {@link RoomStore.listThreadsForMember} — a thread and the
 * room it lives in, before the root's body is parsed and truncated.
 *
 * `rootBody` is the raw JSON column rather than a preview, because turning a
 * body into one line of text is a product decision (`RoomService.listThreads`
 * makes it) and the store's job stops at the row.
 */
export interface ThreadAggregateRow {
  roomId: string;
  roomKind: string;
  roomSlug: string | null;
  roomTitle: string;
  rootEntryId: string;
  rootAuthorId: string;
  /** The root's `body` column, still JSON. */
  rootBody: string;
  replyCount: number;
  unreadCount: number;
  lastActivityAt: string;
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
 * **`dispatch_id` is dropped here on purpose.** It is the repeat rule's private
 * accounting (DOR-1434) — read only inside {@link RoomStore}, meaningful only
 * against a live dispatcher, and of no use to a reader of the room. Spreading
 * the row would carry it into every SSE frame and every API response as a field
 * `RoomEntry` does not declare, so it is removed here rather than left to a
 * schema parse somewhere downstream to strip.
 *
 * @param row - The stored row.
 */
export function toEntry(row: RoomEntryRow): RoomEntry {
  const { dispatchId: _internalDispatchId, ...rest } = row;
  return {
    ...rest,
    kind: row.kind as RoomEntryKind,
    body: parseEntryBody(row.body),
    mentions: parseJson<string[]>(row.mentions, []),
    mentionSpans: parseJson<MentionSpan[]>(row.mentionSpans, []),
  };
}

/**
 * Parse an entry's `body` column, degrading to the raw text rather than
 * throwing. Exported because the cross-room thread list reads a root's body
 * without building the whole entry around it, and two spellings of "what does
 * a corrupted body mean" is one more than this store gets to have.
 *
 * @param raw - The stored `body` column.
 */
export function parseEntryBody(raw: string): RoomEntryBody {
  return parseJson<RoomEntryBody>(raw, { text: raw });
}

/** Parse a column we wrote as JSON, falling back rather than throwing. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
