/**
 * A direct message's member-set identity: the key it is stored under, and how
 * to tell SQLite refusing a second DM for one member set (DOR-1616).
 *
 * @module server/services/rooms/manage/room-dm-key
 */
import { canonicalDmMemberKey } from '@dorkos/db';
import type { RoomKind } from '@dorkos/shared/room-schemas';

/**
 * What SQLite says when the partial unique index behind "one DM per member set"
 * refuses a write. `better-sqlite3` names the COLUMN rather than the index
 * (`UNIQUE constraint failed: rooms.dm_member_key`), which is what makes this
 * string, and not the error code, the thing to match on.
 */
const DM_MEMBER_KEY_CONSTRAINT = 'rooms.dm_member_key';

/**
 * Whether a thrown error is SQLite refusing a second direct message for one
 * member set (DOR-1616).
 *
 * **The column is matched, not just the error code.** `rooms` carries three
 * unique indexes — the channel slug, the well-known key, and this one — so a
 * caller that read any `SQLITE_CONSTRAINT_UNIQUE` as "somebody else opened this
 * DM first" would swallow a `SLUG_TAKEN` collision along with it. The column
 * name in the message is the only thing that tells them apart.
 *
 * **The whole cause chain is searched**, because the error a caller catches is
 * not always the one SQLite threw: a driver is free to wrap it, and a guard
 * that only read the outermost `message` would start answering `false` after a
 * dependency bump — silently turning every adopt-the-winner path back into the
 * 500 it exists to prevent.
 *
 * @param err - Whatever was caught.
 * @returns `true` when the DM member-set constraint is what refused the write.
 */
export function isDmMemberSetTaken(err: unknown): boolean {
  for (let cursor: unknown = err; cursor instanceof Error; cursor = cursor.cause) {
    if (cursor.message.includes(DM_MEMBER_KEY_CONSTRAINT)) return true;
  }
  return false;
}

/**
 * The `rooms.dm_member_key` a new room is inserted with — its canonical member
 * set, or `null` when it takes part in no member-set dedupe.
 *
 * Two rooms answer `null`. A CHANNEL has no member-set identity: its name is
 * `#slug` and `rooms_channel_slug_unique` is its constraint. A BRIDGED DM's
 * identity is its bridge row and never its roster (ADR 260804-093318) — the
 * roster of a bridged private chat is byte-identical to the operator's own DM
 * with that agent, so a bridged chat inside this dedupe would let a fresh open
 * reuse, and un-archive, a stranger's chat log.
 *
 * An empty roster also answers `null`, and that is not a degenerate case being
 * papered over: a room with nobody in it has no member set to be identified by,
 * and `RoomStore.findDmByMemberSet([])` has always answered `null` for exactly
 * that reason.
 *
 * @param kind - The room's kind.
 * @param bridged - Whether this room is a bridge projection.
 * @param members - The roster being written alongside the room.
 */
export function dmMemberKeyFor(
  kind: RoomKind,
  bridged: boolean,
  members: ReadonlyArray<{ authorId: string }>
): string | null {
  if (kind !== 'dm' || bridged) return null;
  const key = canonicalDmMemberKey(members.map((member) => member.authorId));
  return key === '' ? null : key;
}
