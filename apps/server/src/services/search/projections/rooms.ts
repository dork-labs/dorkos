/**
 * The room log's projection: `room_entries` rows in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock. That is what makes it
 * table-testable, and it is the property that keeps "adding a source" honest at
 * one function (message-search spec §Code structure).
 *
 * @module server/services/search/projections/rooms
 */
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import type { ProjectedMessage, Projection } from '../types.js';

/**
 * One `room_entries` row as the projection needs it — the entry's own columns
 * plus its author's kind.
 *
 * The author's kind is the only thing here that is not on `room_entries`, and
 * it is the only thing that answers "who said this". It is joined in by the
 * registry's read rather than looked up here, because a projection that queries
 * is not a projection.
 */
export interface RoomEntrySourceRow {
  /** The room this entry belongs to. */
  roomId: string;

  /** Per-room monotonic sequence. */
  seq: number;

  /** `'post' | 'notice'`. */
  kind: string;

  /**
   * `'human' | 'agent' | 'system'`, or `null` when the author row is missing.
   * Null is not expected — every entry is written with a resolved author — but
   * it is read defensively rather than dropped, because losing a message to a
   * missing join row would be silent.
   */
  authorKind: string | null;

  /** The JSON `RoomEntryBody` as stored. */
  body: string;

  /** ISO-8601. */
  createdAt: string;
}

/**
 * Project a room's entries into searchable messages.
 *
 * Three kinds of row do not become a message, and the difference between them is
 * the whole point of this function reporting a count:
 *
 * - **Notices**, dropped silently. `messages` holds "one thing someone said", and
 *   a notice is the room reporting about itself — "this back-and-forth hit its
 *   automatic-reply limit". It is neither `user` nor `assistant`, it is generated
 *   from a fixed set of codes, and indexing it would return the same sentence for
 *   every room that ever hit the cascade guard. An expected outcome, not a signal.
 * - **Empty text**, dropped silently for the same reason: a post with nothing
 *   left after trimming has nothing to search.
 * - **A body that parses but carries no string `text`**, counted as `skipped`.
 *   This one is not an expected outcome — it is `RoomEntryBody` having changed
 *   shape underneath the index, which is the failure ADR 260728-214214 names as
 *   its sharpest negative because it is otherwise indistinguishable from a quiet
 *   room. It must not throw (one drifted row would stop the whole room) and it
 *   must not be indexed (the raw JSON would go in as prose, so `MATCH 'blocks'`,
 *   `'type'` and `'value'` would all return hits on the container's plumbing).
 *
 * A body that will not parse AT ALL is the separate case, and it degrades to its
 * raw column exactly as `room-rows.ts`'s `toEntry` does. We author that JSON, so
 * a parse failure is a corrupted row rather than a format change, and the honest
 * cost is that one message's formatting.
 *
 * @param rows - Entries from ONE room, in ordinal order.
 */
export function projectRoomEntries(rows: readonly RoomEntrySourceRow[]): Projection {
  const messages: ProjectedMessage[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.kind !== 'post') continue;

    const text = readBodyText(row.body);
    if (text === null) {
      skipped += 1;
      continue;
    }
    if (text.trim() === '') continue;

    messages.push({
      // `origin_key` is composed HERE and parsed nowhere. Today that is the bare
      // room id; when community scoping lands it becomes
      // `${communityRef}:${roomId}` and this line is the only one that changes.
      originKey: row.roomId,
      ordinal: row.seq,
      // A room needs none, so it gets none (DOR-1579). `ordinal` here IS the
      // entry's `seq`, which is the address the room's own timeline resolves —
      // a room hit has landed on its message since DOR-687. Putting the entry id
      // here as well would be a second address for the same row, kept in step by
      // nothing.
      messageId: null,
      // A human is a `user`; everything else in a room that speaks is answering
      // like one. `system` only ever writes notices, which never reach here.
      role: row.authorKind === 'human' ? 'user' : 'assistant',
      createdAt: row.createdAt,
      body: text,
    });
  }

  return { messages, skipped };
}

/**
 * The searchable text of a stored `RoomEntryBody`.
 *
 * @returns The text; the raw column when the JSON will not parse at all
 *   (corruption, degraded rather than lost); or `null` when it parses and has no
 *   string `text` (a format change, which the caller counts).
 */
function readBodyText(raw: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }
  const text = (body as RoomEntryBody | null)?.text;
  return typeof text === 'string' ? text : null;
}
