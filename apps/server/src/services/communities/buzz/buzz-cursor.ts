/**
 * The Buzz cursor — a keyset position, because Buzz has no sequence.
 *
 * This is the deepest of the seven mismatches the capability spike found
 * (`research/20260727_buzz-protocol-capability-spike.md` §11(b)-1), and the whole
 * reason the port's cursor is an opaque adapter-minted token rather than a
 * number. Our own rooms allocate a per-room monotonic `seq` inside the insert
 * transaction. Buzz has nothing equivalent: NIP-01 filters page by `created_at`,
 * a client-assigned wall clock in whole seconds, which ties constantly and can
 * skew. The only tiebroken position anywhere in Buzz is its own NIP-CW keyset,
 * `(until, before_id)` — a timestamp plus the event id, "mandatory both or
 * neither" (`crates/buzz-relay/src/api/bridge.rs:404-455`).
 *
 * So a position here is that same pair, and entries are totally ordered by
 * `(createdAt, eventId)`. The event id is a sha256 of the event's own content, so
 * the tiebreak is arbitrary but **stable and global** — the two properties an
 * ordering needs. `createdAt` alone is neither.
 *
 * Encoding: `buzz|<community>|<roomId>|<createdAt>|<eventId>`. The first three
 * fields are what make it self-identifying, exactly as the local cursor's are.
 *
 * **There is deliberately no epoch.** The local cursor frames itself with a
 * per-process `STREAM_EPOCH` because a local resume is served out of a stream
 * this process owns. A Buzz position is a fact about somebody else's durable
 * store: the event id outlives our restart, our reconnection and our whole
 * install, so refusing a cursor because we restarted would throw away a resume
 * the relay can still serve perfectly. The four rejections the port asks for are
 * met without one — wrong community, wrong room, malformed, and a position the
 * relay cannot place.
 *
 * @module server/services/communities/buzz/buzz-cursor
 */
import {
  StaleCommunityCursorError,
  type CommunityCursor,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';

/** Field separator. Legal in none of the four fields it separates. */
const SEPARATOR = '|';

/** Tag that marks a token as this adapter's, so a local cursor is refused on sight. */
const SCHEME = 'buzz';

/** One position in a room's total order. */
export interface BuzzPosition {
  /** The event's `created_at`, in unix seconds. */
  createdAt: number;
  /** The event's id — the tiebreak, without which same-second events are unorderable. */
  eventId: string;
}

/**
 * The position before every real one, for a read that starts at the beginning.
 *
 * Its `eventId` is empty because there is no event there — that is what makes it
 * the beginning. It is a legal, encodable position and NOT a null object: a room
 * with nothing in it has to hand its subscriber a cursor, and this is the one it
 * hands out. An encoding that accepted only real event ids would mint that cursor
 * and then refuse it, which reads to a caller as a resume failing on a healthy
 * room — the caller falls back to a cold snapshot exactly as the port instructs,
 * forever, and never resumes again. Conformance U17 exists because nothing else
 * looked at it.
 */
export const BEGINNING: BuzzPosition = { createdAt: 0, eventId: '' };

/**
 * Whether a position is {@link BEGINNING} — the one position with no event
 * behind it.
 *
 * @param position - The position to classify.
 */
export function isBeginning(position: BuzzPosition): boolean {
  return position.createdAt === 0 && position.eventId === '';
}

/**
 * Compare two positions in the room's total order.
 *
 * @param a - Left position.
 * @param b - Right position.
 * @returns Negative when `a` is older, positive when newer, zero when identical.
 */
export function comparePositions(a: BuzzPosition, b: BuzzPosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Mint the cursor that resumes AFTER a position.
 *
 * @param community - The community this cursor belongs to.
 * @param roomId - The room this cursor belongs to.
 * @param position - The position it resumes after.
 */
export function mintBuzzCursor(
  community: CommunityRef,
  roomId: string,
  position: BuzzPosition
): CommunityCursor {
  // The separator is safe by construction — a `CommunityRef` is path-safe, a
  // channel id is a UUID, an event id is hex, and the second is digits — but
  // "by construction" is a claim about callers, and this function is reachable
  // from a room id a relay chose. A token whose fields cannot be told apart
  // would be read back as a different position in a different room, which is
  // the one failure mode the self-identifying rule exists to prevent, so it is
  // refused here rather than encoded and misread later.
  if (roomId.includes(SEPARATOR)) {
    throw new Error(
      `a Buzz room id may not contain '${SEPARATOR}': it is the cursor's field separator (room '${roomId}')`
    );
  }
  return [SCHEME, community, roomId, position.createdAt, position.eventId].join(
    SEPARATOR
  ) as CommunityCursor;
}

/**
 * Read a cursor's position, refusing every cursor this room cannot serve
 * gap-free.
 *
 * Rejected, never bounded: a cursor minted for another room is a plausible
 * timestamp here, and bounding it would resume from the wrong place and silently
 * drop whatever fell in between.
 *
 * @param community - The community the reader is asking about.
 * @param roomId - The room the reader is asking about.
 * @param cursor - The cursor presented.
 * @throws {StaleCommunityCursorError} When the cursor is malformed, or names
 *   another community, another room, or another adapter's scheme.
 */
export function readBuzzCursor(
  community: CommunityRef,
  roomId: string,
  cursor: CommunityCursor
): BuzzPosition {
  const refuse = (reason: string): never => {
    throw new StaleCommunityCursorError(community, roomId, reason);
  };

  const parts = String(cursor).split(SEPARATOR);
  if (parts.length !== 5) return refuse('cursor is malformed');
  const [scheme, cursorCommunity, cursorRoomId, createdAt, eventId] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (scheme !== SCHEME) return refuse('cursor was minted by another kind of backend');
  if (cursorCommunity !== community) return refuse('cursor belongs to another community');
  if (cursorRoomId !== roomId) return refuse('cursor belongs to another room');

  const seconds = Number(createdAt);
  if (!Number.isInteger(seconds) || seconds < 0) return refuse('cursor is malformed');
  // The beginning-of-room sentinel, which is a position this adapter genuinely
  // mints (see {@link BEGINNING}) and must therefore genuinely accept. It is
  // accepted ONLY in its exact encoded form: an empty event id at any other
  // second is a truncated token, not a beginning, and is refused with the rest.
  const position = { createdAt: seconds, eventId };
  if (isBeginning(position)) return position;
  if (!/^[0-9a-f]{64}$/.test(eventId)) return refuse('cursor is malformed');
  return position;
}
