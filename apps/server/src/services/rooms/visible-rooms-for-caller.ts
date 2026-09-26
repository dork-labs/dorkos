/**
 * The rooms one caller can see, as plain rows (DOR-2055).
 *
 * ## Why this is a named unit and not a closure in `index.ts`
 *
 * Because it carries a security rule, and a rule nothing executes is a rule
 * nobody is holding. This was three lines inside the `listVisibleRooms` wiring,
 * and review measured what that cost: reverting the caller resolution to the
 * install owner's left 712 tests green. Every test of the capabilities above it
 * injects its own roster fake, so none of them ever reached the one line that
 * decides WHOSE rooms are listed. Here it has a name, an import, and
 * `__tests__/visible-rooms-for-caller.test.ts` driving it against a real
 * `RoomService`.
 *
 * ## What it is for
 *
 * `operator.sidebar_add_to_group` and `operator.sidebar_remove_from_group` check
 * a room reference before storing one, and they must check it against what their
 * CALLER can see. Resolving against a wider view and then reporting the outcome
 * is an existence oracle over the operator's private conversations — guess a DM
 * title, read a real room id back out of the answer — and
 * `service/room-visibility.ts` closes exactly that, deliberately, by answering
 * the same `ROOM_NOT_FOUND` for "no such room" and "not visible to you".
 *
 * Nothing here restates that rule. The caller is resolved by the rooms domain's
 * own {@link callerAuthor} and the listing is the rooms domain's own
 * `listRooms`, so the owner's `seesEveryRoom` and every other grant those encode
 * carry over by construction rather than by a second copy agreeing with them.
 *
 * ## Resolving the caller WRITES
 *
 * {@link callerAuthor} is not a pure read: it upserts an author row through
 * `resolveAgent`, `localHuman` or `bindOwner` — minting the caller's row when
 * this database has never seen them, and adopting the pre-login sentinel onto an
 * owner account when one appears. That is the same write every room verb already
 * performs on its first call from a given principal, so this adds no new
 * behaviour; it is written down because a function that looks like a read and
 * writes is worth being told about.
 *
 * @module server/services/rooms/visible-rooms-for-caller
 */
import type { CapabilityHandlerContext } from '../core/capabilities/registry.js';
import { callerAuthor } from './room-capabilities.js';
import type { RoomService } from './room-service.js';

/** One room a caller can see, in the shape the sidebar capabilities check against. */
export interface VisibleRoomRow {
  /** The room's id — the only thing a sidebar reference ever stores. */
  roomId: string;
  /** The room's title. */
  name: string;
  /** The channel slug, or `null` for a direct message. */
  slug: string | null;
}

/**
 * Every non-archived room this caller can see, or `undefined` when the question
 * cannot be answered for them.
 *
 * ## Fail closed, on ANY failure
 *
 * The `catch` is deliberately total rather than a `RoomError` filter. The known
 * case is an identity that could not be verified — {@link callerAuthor} throws
 * `AGENT_IDENTITY_UNVERIFIED` for a revoked or expired token, and
 * `UNIDENTIFIED_CALLER` when login is on and the surface named nobody — but the
 * decision this feeds is "may I store a reference to this room", and the honest
 * answer to a store that just threw is the same as the answer to a revoked
 * token: I cannot say. A narrower catch would let an unexpected failure become
 * an empty list, which reads as "no such room" and would be a wrong answer
 * rather than a refusal.
 *
 * `undefined` is therefore never "no rooms". The caller refuses the reference;
 * see `SidebarRoster` in `core/operator/sidebar-item-refs.ts`.
 *
 * @param rooms - The live rooms service.
 * @param caller - What the registry resolved about this call.
 * @returns The caller's visible rooms, or `undefined` when unanswerable.
 */
export function visibleRoomsForCaller(
  rooms: RoomService,
  caller: CapabilityHandlerContext
): VisibleRoomRow[] | undefined {
  try {
    return rooms
      .listRooms(callerAuthor(rooms, caller).id, { includeArchived: false })
      .map((room) => ({ roomId: room.id, name: room.title, slug: room.slug }));
  } catch {
    return undefined;
  }
}
