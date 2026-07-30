/**
 * The local community's opaque resume cursor.
 *
 * A room's `seq` is a per-room monotonic integer allocated inside the insert
 * transaction (`packages/db/src/schema/rooms.ts`), and it is the only thing a
 * local resume needs. The port forbids handing that integer to a consumer: a
 * cursor must be **self-identifying**, so one minted for another room, another
 * community or a superseded epoch is rejected rather than silently serving a
 * plausible-looking number that skips real entries.
 *
 * So the encoding is `community|roomId|epoch|seq`, and the four fields are
 * exactly the four rejections the port requires. The delimiter is safe by
 * construction: a `CommunityRef` is path-safe (no `|`), a room id is a ULID, and
 * the last two fields are digits.
 *
 * **The epoch is `STREAM_EPOCH`** — the same per-process value the shipped room
 * SSE stream frames its `id:` lines with. A room's `seq` is durable and would in
 * fact survive a restart, so this is stricter than it has to be, and
 * deliberately so for the reason `lib/stream-cursor.ts` already gives: one
 * cursor discipline across both streams is worth more than saving a reader one
 * cold snapshot after a server restart, and a consumer that had to know which
 * streams keep their seq space is a consumer that gets it wrong. A cursor from a
 * previous process is refused, and the caller falls back to a snapshot exactly
 * as the port instructs.
 *
 * @module server/services/communities/local/local-cursor
 */
import {
  StaleCommunityCursorError,
  type CommunityCursor,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { STREAM_EPOCH } from '../../../lib/stream-cursor.js';

/** Field separator. Legal in none of the four fields it separates. */
const SEPARATOR = '|';

/**
 * Mint the cursor that resumes AFTER a given `seq`.
 *
 * @param community - The community this cursor belongs to.
 * @param roomId - The room this cursor belongs to.
 * @param seq - The entry's per-room sequence number.
 * @param epoch - This process's stream epoch; defaults to {@link STREAM_EPOCH}.
 */
export function mintLocalCursor(
  community: CommunityRef,
  roomId: string,
  seq: number,
  epoch: number = STREAM_EPOCH
): CommunityCursor {
  return [community, roomId, epoch, seq].join(SEPARATOR) as CommunityCursor;
}

/**
 * Read a cursor's `seq`, refusing every cursor this room cannot serve gap-free.
 *
 * Rejected, never bounded. A foreign cursor is a plausible value: bounding it to
 * this room's range would resume from the wrong place and quietly drop whatever
 * fell in between, which is the failure the port's "self-identifying" rule
 * exists to make impossible.
 *
 * @param community - The community the reader is asking about.
 * @param roomId - The room the reader is asking about.
 * @param cursor - The cursor presented.
 * @param highestSeq - The highest `seq` this room has issued, so a cursor from
 *   the future is refused rather than silently suppressing every entry the
 *   reader connected to receive.
 * @param epoch - This process's stream epoch; defaults to {@link STREAM_EPOCH}.
 * @throws {StaleCommunityCursorError} When the cursor names another community,
 *   another room, a superseded epoch, or a position this room has not reached.
 */
export function readLocalCursor(
  community: CommunityRef,
  roomId: string,
  cursor: CommunityCursor,
  highestSeq: number,
  epoch: number = STREAM_EPOCH
): number {
  const refuse = (reason: string): never => {
    throw new StaleCommunityCursorError(community, roomId, reason);
  };

  const parts = String(cursor).split(SEPARATOR);
  if (parts.length !== 4) return refuse('cursor is malformed');
  const [cursorCommunity, cursorRoomId, cursorEpoch, cursorSeq] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (cursorCommunity !== community) return refuse('cursor belongs to another community');
  if (cursorRoomId !== roomId) return refuse('cursor belongs to another room');
  if (cursorEpoch !== String(epoch)) return refuse('cursor is from a superseded epoch');

  const seq = Number(cursorSeq);
  if (!Number.isInteger(seq) || seq < 0) return refuse('cursor is malformed');
  if (seq > highestSeq) return refuse('cursor is ahead of this room');
  return seq;
}
