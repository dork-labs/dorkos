/**
 * The channel seats an agent gives up when it leaves your team, and gets back if
 * the same agent returns (DOR-2095).
 *
 * Split from `RoomStore` on a real boundary: everything here is about ONE event
 * in an agent's life — leaving, or coming back — and the tombstone table
 * `room_departed_seats` has no reader or writer anywhere else.
 *
 * @module server/services/rooms/manage/departed-seat-store
 */
import {
  authors,
  rooms,
  roomMembers,
  roomSessions,
  roomDepartedSeats,
  eq,
  and,
  inArray,
  isNull,
  type Db,
} from '@dorkos/db';

/** One channel seat, by room and author. */
export interface ChannelSeat {
  roomId: string;
  authorId: string;
}

/** One author leaving, and the manifest id a later replay must match. */
export interface DepartingAuthor {
  authorId: string;
  /**
   * The manifest ULID of the agent this author spoke for, or `null` when it
   * cannot be known — a seat recorded under `null` is kept for the record but
   * never replayed, because nothing could prove a returning agent is the same.
   */
  manifestId: string | null;
}

/** Drizzle CRUD over the seats departed agents left behind. */
export class DepartedSeatStore {
  constructor(private readonly db: Db) {}

  /**
   * Take a set of authors out of every CHANNEL they are in, writing each seat to
   * `room_departed_seats` in the SAME transaction — so a seat is either on the
   * roster or in the tombstone, never lost between the two.
   *
   * **Channels only, and that is the whole policy.** A channel roster is live
   * state: it is what an agent reads to learn who will see a message, and a
   * member who can never answer again makes it lie. A direct message is the
   * opposite case — it is NAMED by who is in it (`dm_member_key`), so taking one
   * person out would turn a DM with them into a different conversation, or
   * collide with one that already exists. A DM keeps its roster, and the member
   * reads as retired off their author instead (`RoomRoster.list`).
   *
   * Each seat leaves with its per-room session binding, exactly as
   * `RoomStore.removeMember` does, and a room whose fallback seat was one of
   * these authors has the seat cleared — the seat is not a foreign key, and one
   * naming somebody who is not on the roster reaches nobody. Whether they held
   * it is remembered, so a replay can give it back.
   *
   * @param departing - The authors to take out, each with the identity a replay must match.
   * @param now - When they left.
   * @returns Every seat that was removed, so the caller can tell the rooms.
   */
  removeFromChannels(departing: readonly DepartingAuthor[], now: string): ChannelSeat[] {
    const manifestOf = new Map(departing.map((d) => [d.authorId, d.manifestId]));
    const ids = [...manifestOf.keys()];
    if (ids.length === 0) return [];
    let removed: ChannelSeat[] = [];
    this.db.transaction(
      (tx) => {
        const seats = tx
          .select({
            member: roomMembers,
            fallbackSeatAuthorId: rooms.fallbackSeatAuthorId,
          })
          .from(roomMembers)
          .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
          .where(and(inArray(roomMembers.authorId, ids), eq(rooms.kind, 'channel')))
          .all();
        for (const { member, fallbackSeatAuthorId } of seats) {
          const { roomId, authorId } = member;
          const heldFallbackSeat = fallbackSeatAuthorId === authorId;
          const tombstone = {
            manifestId: manifestOf.get(authorId) ?? null,
            responseMode: member.responseMode,
            joinedAt: member.joinedAt,
            joinedSeq: member.joinedSeq,
            lastReadSeq: member.lastReadSeq,
            heldFallbackSeat,
            departedAt: now,
          };
          tx.insert(roomDepartedSeats)
            .values({ roomId, authorId, ...tombstone })
            .onConflictDoUpdate({
              target: [roomDepartedSeats.roomId, roomDepartedSeats.authorId],
              set: tombstone,
            })
            .run();
          tx.delete(roomMembers)
            .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
            .run();
          tx.delete(roomSessions)
            .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
            .run();
          if (heldFallbackSeat) {
            tx.update(rooms).set({ fallbackSeatAuthorId: null }).where(eq(rooms.id, roomId)).run();
          }
        }
        removed = seats.map(({ member }) => ({ roomId: member.roomId, authorId: member.authorId }));
      },
      { behavior: 'immediate' }
    );
    return removed;
  }

  /**
   * Give an author back the channel seats it left, when the agent returning is
   * the one that left — its manifest id matches the one recorded on the seat.
   * One transaction; the matched tombstones are deleted whatever became of them.
   *
   * A seat comes back only where it still makes sense: the room still exists, is
   * still a channel and is not archived, and the author has no seat there now (a
   * seat taken since — #team seats every registered agent — is the live answer,
   * and wins). The fallback seat comes back only if nobody holds it now.
   *
   * **The session binding does not come back.** It was deleted with the seat,
   * and restoring a pointer at a runtime session from before a long absence
   * would ask the runtime to resume a transcript it may have pruned or re-keyed
   * since — the convergence repair that follows re-keys only runs on bindings
   * that were live at the time. The agent's next turn here opens a fresh
   * session and reads what it missed from its restored cursor, which is the
   * same path any first turn in a room takes.
   *
   * @param authorId - The author that is live again.
   * @param manifestId - The manifest id of the agent now answering for it.
   * @returns The seats given back.
   */
  restore(authorId: string, manifestId: string): ChannelSeat[] {
    const restored: ChannelSeat[] = [];
    this.db.transaction(
      (tx) => {
        const tombstones = tx
          .select()
          .from(roomDepartedSeats)
          .where(
            and(
              eq(roomDepartedSeats.authorId, authorId),
              eq(roomDepartedSeats.manifestId, manifestId)
            )
          )
          .all();
        for (const seat of tombstones) {
          const room = tx.select().from(rooms).where(eq(rooms.id, seat.roomId)).get();
          if (!room || room.kind !== 'channel' || room.archived) continue;
          const inserted = tx
            .insert(roomMembers)
            .values({
              roomId: seat.roomId,
              authorId,
              responseMode: seat.responseMode,
              joinedAt: seat.joinedAt,
              joinedSeq: seat.joinedSeq,
              lastReadSeq: seat.lastReadSeq,
            })
            .onConflictDoNothing()
            .run();
          if (inserted.changes === 0) continue;
          if (seat.heldFallbackSeat) {
            tx.update(rooms)
              .set({ fallbackSeatAuthorId: authorId })
              .where(and(eq(rooms.id, seat.roomId), isNull(rooms.fallbackSeatAuthorId)))
              .run();
          }
          restored.push({ roomId: seat.roomId, authorId });
        }
        if (tombstones.length > 0) {
          tx.delete(roomDepartedSeats)
            .where(
              and(
                eq(roomDepartedSeats.authorId, authorId),
                eq(roomDepartedSeats.manifestId, manifestId)
              )
            )
            .run();
        }
      },
      { behavior: 'immediate' }
    );
    return restored;
  }

  /** Every author with at least one seat waiting to be given back. */
  listWaitingAuthorIds(): string[] {
    return this.db
      .selectDistinct({ authorId: roomDepartedSeats.authorId })
      .from(roomDepartedSeats)
      .all()
      .map((row) => row.authorId);
  }

  /**
   * The direct messages any of these authors is in — the rooms whose roster
   * keeps a departed agent and so has to be told it now reads as retired.
   *
   * @param authorIds - The authors to look for.
   */
  listDmIdsWith(authorIds: readonly string[]): string[] {
    const ids = [...new Set(authorIds)];
    if (ids.length === 0) return [];
    return this.db
      .selectDistinct({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(inArray(roomMembers.authorId, ids), eq(rooms.kind, 'dm')))
      .all()
      .map((row) => row.roomId);
  }

  /**
   * Every AGENT author that holds a seat in at least one channel — the set the
   * repair sweep asks "is this one still registered?" of.
   */
  listChannelAgentMemberIds(): string[] {
    return this.db
      .selectDistinct({ authorId: roomMembers.authorId })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .innerJoin(authors, eq(authors.id, roomMembers.authorId))
      .where(and(eq(rooms.kind, 'channel'), eq(authors.kind, 'agent')))
      .all()
      .map((row) => row.authorId);
  }
}
