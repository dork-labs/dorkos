/**
 * The source array — one row per indexed source (message-search spec §3, D12).
 *
 * Adding a source means adding a row here and a pure projection beside it.
 * Nothing else varies: discovery, change detection, the incremental read, the
 * upsert and the prune are written once per *mechanism*, in `row-frontier.ts`.
 *
 * This is deliberately a record and not a `SearchAdapter` port. A port
 * abstracting two mechanisms and three functions is a class hierarchy standing
 * where a record would do. The trigger that would change that is written down
 * rather than left to taste: **the day a third mechanism is needed the promotion
 * fires**, and the source that would introduce one (OpenCode, whose SDK poll has
 * no resumption primitive and requires a live child process) is deferred for
 * that reason among others.
 *
 * @module server/services/search/registry
 */
import { authors, roomEntries, rooms, and, asc, eq, gt, sql, type Db } from '@dorkos/db';
import { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
import type { RowContainer, RowSource } from './types.js';

/**
 * The room log — **M2**, rows above a monotonic watermark.
 *
 * Rooms go first because DorkOS owns the write, so any bug here is ours and
 * cheap to see. It reads `room_entries` where it already lives and alters
 * nothing, which is the property that makes the index deletable.
 *
 * Archived rooms are indexed like any other. Archiving releases a channel's
 * slug; it does not unsay what was said, and a person searching their own
 * history is precisely the reader who has forgotten which room it was in.
 */
export const roomsSource: RowSource = {
  id: 'rooms',

  listContainers(db: Db): RowContainer[] {
    // One GROUP BY answers discovery AND change detection. A LEFT JOIN so a room
    // with no entries yet is still a container — it discovers as `maxOrdinal: 0`,
    // matches its absent watermark, and is skipped without a read.
    const rows = db
      .select({
        originKey: rooms.id,
        maxOrdinal: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0)`,
      })
      .from(rooms)
      .leftJoin(roomEntries, eq(roomEntries.roomId, rooms.id))
      .groupBy(rooms.id)
      .all();

    return rows.map((row) => ({
      originKey: row.originKey,
      // A room is not a directory, so there is no working directory a hit could
      // open in (spec §4). The column is nullable for exactly this.
      containerPath: null,
      maxOrdinal: row.maxOrdinal,
    }));
  },

  readSince(db: Db, originKey: string, afterOrdinal: number) {
    // Explicit fields, never `SELECT *` — the index reads what it projects and
    // nothing else. A LEFT JOIN onto `authors` because dropping an entry whose
    // author row is missing would lose a real message to a broken join; the
    // projection reads a null kind as "not a human" instead.
    const rows: RoomEntrySourceRow[] = db
      .select({
        roomId: roomEntries.roomId,
        seq: roomEntries.seq,
        kind: roomEntries.kind,
        authorKind: authors.kind,
        body: roomEntries.body,
        createdAt: roomEntries.createdAt,
      })
      .from(roomEntries)
      .leftJoin(authors, eq(authors.id, roomEntries.authorId))
      .where(and(eq(roomEntries.roomId, originKey), gt(roomEntries.seq, afterOrdinal)))
      // Stated rather than inherited. `room_entries` is keyed `(room_id, seq)`,
      // so this ordering already falls out of the primary key and no test can
      // tell the clause apart from its absence — but the projection's contract
      // says "in ordinal order", and a contract that holds only because of the
      // shape of somebody else's index is one nobody can safely change.
      .orderBy(asc(roomEntries.seq))
      .all();

    return projectRoomEntries(rows);
  },
};

/**
 * Every source the indexer sweeps.
 *
 * One entry today. Claude Code and Codex join it on the JSONL mechanism (M1);
 * OpenCode is deferred and its deferral is what keeps this an array of records
 * rather than a port.
 */
export const SEARCH_SOURCES: readonly RowSource[] = [roomsSource];
