/**
 * The room domain's typed refusals, and the one port it needs into the agent
 * registry.
 *
 * Split out of `room-service.ts` so the routes can map an error onto a status
 * code without importing the service, and so the roster half and the room half
 * can throw the same errors without one importing the other.
 *
 * @module server/services/rooms/room-errors
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';

/** Machine-readable failures the routes map onto status codes. */
export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'SLUG_TAKEN'
  | 'INVALID_SLUG'
  | 'NESTED_THREAD'
  | 'ROOM_ARCHIVED'
  | 'OPERATOR_ONLY'
  /** A non-person tried to react. Agents do not send reactions (etiquette E16b). */
  | 'PEOPLE_ONLY'
  /**
   * A Telegram broadcast channel (`chat.type === 'channel'`) was offered to
   * `RoomService.createBridgedRoom` (chats-as-channels spec §3.3). A broadcast
   * channel is not a conversation — there is no room kind for it, and the claim
   * card offers only "Ignore"/"Leave".
   */
  | 'BROADCAST_NOT_BRIDGEABLE'
  /**
   * `RoomService.createBridgedRoom` was asked to bridge a `(adapterId, chatId)`
   * that already has a bridge row whose `bindingId` differs, or whose room is
   * archived (chats-as-channels spec §3.5). Both are re-bridge shapes —
   * adopting the surviving row for a different agent, or un-archiving and
   * reusing it for the same one — and both are task 1.5's lifecycle, not this
   * create path's. `createBridgedRoom` only ever self-heals the plain replay:
   * the same `(adapterId, chatId)` bridged again for the SAME live binding.
   */
  | 'CHAT_ALREADY_BRIDGED';

/** A refusal from the room domain, carrying a code the routes can switch on. */
export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/**
 * What the room domain needs to know about an agent, without reaching into mesh
 * internals.
 *
 * **Still keyed on the directory, and only on the directory** — that is the
 * point of ADR 260726-170126, enforced here by the lookup taking a path and
 * nothing else. What changed under ADR 260801-003051 is that the ANSWER now
 * carries the occupant's manifest id: an author row is minted for one occupant
 * of a directory, and telling one occupancy generation from the next needs the
 * current occupant's id at the seam that decides who owns a handle. Nobody may
 * look an agent up BY that id, and nobody may supply one.
 */
export interface RoomAgentLookup {
  /**
   * Resolve an agent by its directory.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @returns The agent registered there, or `null` when none is — which is what
   *   makes an author a ghost.
   */
  byPath(agentPath: string): RoomAgent | null;
}

/** What the room domain knows about one agent. */
export interface RoomAgent {
  /**
   * The manifest ULID of the agent occupying this directory right now.
   *
   * **Derived, never caller-supplied.** It is read off the registry row by
   * whoever implements {@link RoomAgentLookup}, and it exists for exactly one
   * comparison: an author row stamped for a DIFFERENT occupant of this same
   * directory is a previous generation, and claims no handle and receives no
   * turn (ADR 260801-003051). Nothing keys identity, storage or routing on it
   * here.
   */
  id: string;
  /** The agent's handle — what somebody types after an `@`. */
  name: string;
  /** The agent's rendered name. */
  displayName: string;
  /** The manifest default, which seeds a DM membership. */
  responseMode: ResponseMode;
  /** Emoji avatar, cached onto the author row for rendering. */
  emoji: string | null;
  /** Identity colour, cached onto the author row for rendering. */
  color: string | null;
}
