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
  /**
   * A handle somebody asked for is live on another author (spec `handles` §8).
   *
   * **Three handle codes, not one**, because they are three different things a
   * person does about it: pick another, ask whoever had it, or fix the spelling.
   * Collapsing them would make the message do work the code should. This is the
   * direct lesson from Buzz, which enforces uniqueness in the index and then
   * swallows the violation — a user who picks a taken handle is told nothing,
   * and their profile syncs without it.
   */
  | 'HANDLE_TAKEN'
  /**
   * A handle somebody asked for is tombstoned to another author, or is one of
   * the seeded broadcast reservations (`everyone`, `here`, `channel`). A freed
   * handle stays its original author's forever, and they may take it back
   * (spec `handles` §3).
   */
  | 'HANDLE_RESERVED'
  /** A handle somebody asked for fails the grammar in `@dorkos/shared/handle`. */
  | 'INVALID_HANDLE'
  | 'NESTED_THREAD'
  /**
   * A moment was offered with no source, with nothing a person could read, or —
   * on the agent path — naming somebody other than its author
   * (team-room-home spec D5.1, `RoomService.postMoment`).
   *
   * **Never reachable from a request.** No route and no tool accepts a moment;
   * they are minted by detectors inside this process, so this code means a
   * detector built one wrong, the same way `RESERVED_NATURAL_KEY` means DorkOS
   * built a key wrong.
   */
  | 'INVALID_MOMENT'
  | 'ROOM_ARCHIVED'
  /**
   * Somebody who is not the owner tried to rename or archive a SYSTEM room —
   * a room carrying a well-known key, which today means #team (team-room-home
   * spec D3.1).
   *
   * **Narrow on purpose, and that narrowness is the whole design.**
   * `RoomService.updateRoom` stays ungated for ordinary rooms, because the
   * blanket `requireOperator` fix breaks `createRoom`'s DM un-archive path
   * (DOR-608). A DM never carries a well-known key, so this refusal cannot
   * reach that path — it closes the hole for the one room the product cannot
   * work without, and changes nothing anywhere else.
   *
   * A 403 rather than a 404: the caller is a member of a room it can see, and
   * "you may not rename this one" is more useful than pretending it is gone.
   */
  | 'SYSTEM_ROOM'
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
   * adopting the surviving row for a different binding (which usually, but
   * not always, means a different agent — a binding can also be re-created
   * for the SAME agent), or un-archiving and reusing it for the same binding
   * — and both are task 1.5's lifecycle, not this create path's.
   * `createBridgedRoom` only ever self-heals the plain replay: the same
   * `(adapterId, chatId)` bridged again for the SAME live binding.
   */
  | 'CHAT_ALREADY_BRIDGED'
  /**
   * `RoomService.addMember` refused a second agent on a bridged room (spec
   * §3.4, D-6 Q3): outbound consent is per binding, so a second agent's
   * replies would have no gate that names them — a half-silent room where one
   * agent answers into the chat and the other answers only into the cockpit.
   * `buildBridgeSecondAgentRefusedNotice` is posted into the room BEFORE this
   * throws, so the refusal is visible there too, not just in the API error.
   */
  | 'BRIDGE_SECOND_AGENT_REFUSED'
  /**
   * `RoomService.createBridgedRoom` received a `chatType` outside the closed
   * set it declares (`'private' | 'group' | 'supergroup' | 'channel'`), or a
   * `channelType` that fails `ChannelTypeSchema`. Both fields' TypeScript
   * types are a claim about the caller's discipline, not a runtime
   * guarantee — the values cross a trust boundary from Telegram's own string
   * (`chat.type`, `packages/relay/src/adapters/telegram/inbound.ts:470`)
   * through several untyped hops before they reach this method. Refused
   * rather than silently falling through the kind-mapping ternary, which
   * would otherwise treat any unrecognized `chatType` as `channel`.
   */
  | 'UNKNOWN_CHAT_TYPE'
  /**
   * An external author was offered an identity a natural key cannot be built
   * from — an empty platform type, instance id or platform user id, or a
   * segment carrying the key separator (chats-as-channels spec §4.1). Refused
   * rather than coerced: a key that can be spelled two ways is a person who
   * can be two authors, and a key with an empty segment is a person who could
   * collide with another.
   */
  | 'EXTERNAL_IDENTITY_INVALID'
  /**
   * A local mint path was offered a natural key beginning `platform:`, the
   * prefix reserved for people outside this machine (spec §4.1). The three
   * local shapes — `local`, `user:{id}`, an agent's absolute directory —
   * cannot spell it, so reaching this is a bug rather than a user action; it
   * is a refusal rather than an assertion because the alternative is an
   * operator or an agent silently rendering as a stranger, or shadowing an
   * external author's row and inheriting their messages.
   */
  | 'RESERVED_NATURAL_KEY'
  /**
   * `RoomService.postExternal` was aimed at a room with no live bridge row
   * (chats-as-channels spec §4.2). An external author is only ever a member of
   * a room that projects an external chat; landing one anywhere else would put
   * a stranger in the operator's own private conversation. Checked against the
   * bridge store here rather than trusted from the caller, the same shape the
   * create path takes.
   */
  /**
   * A post named an attachment id that is not this room's, or is somebody
   * else's and not yet posted. Never a 403: existence is not leaked.
   */
  | 'ATTACHMENT_NOT_FOUND'
  /** A post named an attachment that another entry already carries. A file belongs to one message. */
  | 'ATTACHMENT_ALREADY_POSTED'
  /** A post named more attachments than `uploads.maxFiles` allows, or named one twice. */
  | 'TOO_MANY_ATTACHMENTS'
  | 'NOT_A_BRIDGED_ROOM'
  /**
   * `RoomService.rebridge` was asked to re-bridge a `(adapterId, chatId)` that
   * has no surviving bridge row (chats-as-channels spec §3.5). Re-bridging is
   * the lifecycle path that reuses or adopts a row a previous bridge left
   * behind; with nothing to reuse, the caller wanted `createBridgedRoom`
   * instead. Refused rather than silently falling back to a create, because the
   * two differ in whether an existing room and its history are adopted.
   */
  | 'NO_SURVIVING_BRIDGE';

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
