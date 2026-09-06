/**
 * What a room service is built from, and the three shapes its write paths
 * answer with.
 *
 * Kept beside `room-service.ts` rather than inside it so the ports this domain
 * is handed — the message index, the turn runner, the live config reads — can
 * be read without also reading the orchestration that consumes them.
 *
 * @module server/services/rooms/service/room-service-deps
 */
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomWorktreeManager } from '../repo/room-worktree-manager.js';
import type { ReadCursorService } from '../../core/read-cursor-service.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { EngagedWindow } from '../engagement.js';
import type { CollectWindow } from '../room-collect.js';
import type { ResponseGateMode } from '../response-gate/routing-rules.js';
import type { RoomLimitsResolver } from '../limits/room-limits.js';
import type { ReactionBudget } from '../reactions/reaction-budget.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomAgentLookup } from '../room-errors.js';
import type { RoomStore } from '../room-store.js';
import type { RoomBroadcaster } from '../room-stream.js';
import type { RoomDispatchSummary, RoomTurnRunner } from '../room-trigger.js';
import type { RoomTurnBudget } from '../limits/turn-budget.js';

/**
 * The message index, as this domain sees it: words in, coordinates out, no
 * access rule of its own.
 *
 * `ordinal` is a room entry's `seq`. The finder is handed exactly the room ids
 * the caller may read and a floor it may read above, and everything else about
 * who may see what stays on this side of the port.
 */
export interface RoomMessageFinder {
  (input: {
    /**
     * The rooms to search, each with the `seq` it may be read above — already
     * resolved to what this caller may see.
     *
     * **A floor per room, never one for the request.** A member joins different
     * rooms at different points, so a single floor across several rooms is
     * wrong in both directions at once: it leaks what was said before they
     * arrived in a room they joined late, and hides what is theirs in a room
     * they joined early. One room per entry keeps the pair that decides
     * visibility together.
     */
    rooms: ReadonlyArray<{ roomId: string; afterSeq: number }>;
    /** What the caller typed. */
    query: string;
    /** The most hits to bring back, best first. */
    limit: number;
  }): Array<{ roomId: string; seq: number }>;
}

/**
 * How a committed entry reaches the message index (message-search spec §5,
 * Amendment 6).
 *
 * The write half of the same port {@link RoomMessageFinder} is the read half of,
 * and it is a port for the same reason: this domain neither imports the index
 * nor knows it is FTS5. It is handed a coordinate it already has in its hand.
 *
 * **It must not throw and must not be slow.** The room log is the truth and the
 * index is a copy, so a copy that cannot be written is a warning and a
 * five-minute wait for the reconciler — never a failed post. The implementation
 * that ships (`services/search/write-through.ts`) owns that guarantee, and this
 * service guards the call anyway: a port whose contract is "never throws" that
 * nobody checks is a contract that holds until somebody wires a different one.
 */
export interface RoomEntryIndexer {
  (entry: { roomId: string; seq: number }): void;
}

/**
 * What one caller may search of the room log, across every room at once
 * (message-search spec §7).
 *
 * `'all'` is the operator, whose clause is OMITTED rather than filled with every
 * room on the machine — a filter that has to enumerate everything silently
 * starts excluding things the day enumeration misses one. Everybody else gets a
 * map of room id to the `seq` they joined at, which is the floor their search
 * runs above.
 */
export type RoomSearchScope = 'all' | ReadonlyMap<string, number>;

/** Everything {@link RoomService} is constructed from. */
export interface RoomServiceDeps {
  store: RoomStore;
  /** Reactions on this room's entries — durable state, never a turn. */
  reactions: ReactionStore;
  /** The rows behind this room's attachments. The BYTES live behind a separate seam. */
  attachments: AttachmentRowStore;
  authors: AuthorRegistry;
  broadcaster: RoomBroadcaster;
  agents: RoomAgentLookup;
  /** How a triggered agent actually takes its turn. */
  turns: RoomTurnRunner;
  /**
   * Where that turn runs, when the room has files of its own (spec §3.5).
   *
   * A thunk rather than the manager, because the manager is built after this
   * service — it needs the claim map this service owns to know which working
   * copies are in use. Optional: without one, every turn runs in the agent's own
   * directory, exactly as it did before project rooms existed.
   */
  worktrees?: () => RoomWorktreeManager | null;
  /** The per-room ceiling on automatic turns, counted whoever is calling. */
  budget: RoomTurnBudget;
  /**
   * The per-`(room, agent)` hourly ceiling on reactions — the price of letting
   * agents react at all (ADR 260814-195522).
   *
   * Required rather than defaulted, because a budget this class could build for
   * itself is one a caller could forget to build — and the failure mode of
   * forgetting is an unbounded one.
   */
  reactionBudget: ReactionBudget;
  /**
   * How `search_room_history` finds a message by words: the message index, behind
   * a port so this domain neither imports it nor knows it is FTS5
   * (room-participation spec §10.3, as amended by DOR-672).
   *
   * A port rather than a direct call for the reason every seam in this file is
   * one: the index enforces no access rule and must never be asked to. It is
   * handed a scope this service resolved and returns coordinates this service
   * resolves back through its own read path, so membership, the join floor and
   * the thread filter are applied by the code that already owns them.
   */
  findMessages: RoomMessageFinder;
  /**
   * How a committed entry reaches the index, so a message is findable the
   * moment it is said rather than up to five minutes later (message-search
   * spec Amendment 6).
   *
   * Required rather than optional, and that is the decision: an optional
   * write-through is one a caller can forget to wire, and forgetting it is
   * invisible — search simply lags, which is indistinguishable from a quiet
   * room. A caller that genuinely wants no index passes a no-op and says so.
   */
  indexEntry: RoomEntryIndexer;
  /**
   * What bounds automatic replies in one room — the room's own overrides where
   * it has them, Settings otherwise (`resolveRoomLimits`, DOR-1429). Injected
   * so this domain reads no config.
   *
   * This service reads exactly one field of it, `maxAgentDepth`, and only to
   * STAMP a cascade: it does not judge them. The dispatcher it hands the
   * resolver to is what judges.
   */
  limitsFor: RoomLimitsResolver;
  /** The live `rooms.engagedWindow*` ceilings, injected for the same reason. */
  engagedWindow(): EngagedWindow;
  /** The live `rooms.collect*` ceilings, injected for the same reason. */
  collect(): CollectWindow;
  /** The live `rooms.responseGate` setting, injected for the same reason. */
  responseGate(): ResponseGateMode;
  /**
   * The live `rooms.lateReplyCeilingMinutes` in milliseconds — how long a room
   * waits on an agent busy elsewhere before it gives up. Injected for the same
   * reason.
   */
  holdCeilingMs(): number;
  /**
   * The live `uploads.maxFiles` — how many files one post may carry.
   *
   * Injected in the same style as {@link RoomServiceDeps.limitsFor}, so this
   * domain still reads no config. Read PER POST rather than captured, because a
   * person may change the limit between two messages. Deliberately not
   * `ROOM_ATTACHMENT_MAX_PER_ENTRY`, which is the schema's static 50-ceiling on
   * what this may be SET to, not the limit anyone feels.
   */
  maxAttachmentsPerEntry(): number;
  /**
   * The live `rooms.maxPostsPerTurn` — how many messages one agent may post into
   * a room inside a single turn (spec `tool-only-room-replies` §D9).
   *
   * Injected in the same style as {@link RoomServiceDeps.limitsFor}, so this
   * domain still reads no config. Read PER POST rather than captured, because an
   * operator who feels the number is wrong must be able to move it without
   * restarting anything — posting is the agent's only voice once
   * `rooms.toolOnlyReplies` is on.
   */
  maxPostsPerTurn(): number;
  /**
   * Whether this author is the person who owns the install.
   *
   * Injected in the same style as {@link RoomServiceDeps.limitsFor}, so this
   * domain still reads no config and no auth module: who the owner is depends on
   * whether an account exists, which is not a room's business to know.
   */
  isOwnerAuthor(authorId: string): boolean;
  /**
   * The record-based twin of {@link RoomServiceDeps.isOwnerAuthor}, for a
   * caller that already holds the row — resolving an id `isOwnerAuthor`
   * would otherwise re-fetch from a batch {@link AuthorRegistry.getMany}
   * already answered (`author-registry.ts`'s own warning against paying
   * that query per member when a caller already has the roster loaded).
   */
  isOwnerRecord(record: AuthorRecord): boolean;
  /**
   * Where {@link RoomService.createBridgedRoom} writes the `room_bridges` row
   * that IS a bridged room's identity (chats-as-channels spec §3.2). Consumed,
   * never reshaped: this domain calls only {@link BridgeStore.createBridge},
   * inside the same transaction `RoomStore.createRoom` opens for the room and
   * its roster.
   */
  bridges: BridgeStore;
  /**
   * Where the PEOPLE in a room have read up to (team-room-home spec §D4).
   *
   * The one user-side read-state store, shared with agent sessions and the
   * inbox, so a person's place in a conversation is one fact wherever they are
   * reading it. **Not the agent cursor**: what the ambient participation loop
   * has SHOWN an agent stays on `room_members.last_read_seq`, which this domain
   * still owns and still writes (room-participation spec §8.3).
   */
  readCursors: ReadCursorService;
  /**
   * Whether the operator has muted this room (spec `notification-system`
   * task T11).
   *
   * Injected in the same style as {@link RoomServiceDeps.limitsFor}, so this
   * domain still reads no config: mute lives in `ui.sidebar.muted`, which is a
   * client-organization concern, not a rooms one. Read per post, not captured,
   * so toggling mute in the sidebar takes effect on the very next message —
   * and a config manager that is not up yet must default to "not muted" rather
   * than silently going deaf to a real DM.
   */
  isRoomMuted(roomId: string): boolean;
}

/**
 * Provenance a post carries when a trigger produced it.
 *
 * Server-internal, and only ever built by the dispatcher: no request body
 * reaches this shape, which is what keeps `cascadeDepth: 0` — and now
 * `dispatch_id` — something the room observed rather than something a caller
 * claimed.
 */
export interface PostTrigger {
  root: string;
  depth: number;
  /**
   * The turn this post belongs to, for the repeat rule's per-turn count
   * (DOR-1434). Set by the dispatcher on every answer it delivers.
   */
  dispatchId?: string;
}

/**
 * A room, plus whether opening it is what brought it into existence.
 *
 * The flag exists so `POST /api/rooms` can answer 201 for a room it created and
 * 200 for a direct message that already held those members. That distinction is
 * not inferable from the body — a conversation forty messages deep and one
 * opened a moment ago serialize identically — and a caller that is not the
 * cockpit (a CLI, an MCP client) has to be able to tell them apart.
 *
 * Deliberately an intersection rather than a wrapper object: it is structurally
 * a `RoomWithRoster` everywhere one is expected, so nothing that only wants the
 * room has to reach through a field to get it. The route strips it before
 * serializing, so the wire body stays exactly `RoomWithRosterSchema`.
 */
export type OpenedRoom = RoomWithRoster & {
  /** `false` when an existing direct message was returned instead of a new room. */
  created: boolean;
};

/**
 * A committed entry, plus what writing it asked of the room.
 *
 * The same intersection {@link OpenedRoom} is, for the same reason: it is
 * structurally a `RoomEntry` everywhere one is expected, so none of the ten
 * callers that only want the entry has to reach through a field for it, and the
 * route strips the extra before serializing.
 *
 * `dispatch` is the room's answer to "who did this reach", assembled
 * synchronously by {@link RoomTriggerDispatcher.dispatch} while the post was
 * written. A message that addresses nobody carries an EMPTY summary rather than
 * `null`, because "nothing was asked of anybody" is an answer. `null` is the
 * other thing entirely: dispatching threw, the entry is committed and published
 * regardless, and nothing here knows who it reached. The route drops the fields
 * in that case rather than reporting an empty room, which is what
 * `PostToRoomResponse` means by "absent is not nobody".
 *
 * Only the paths that go through `writePost` carry one, which is every path a
 * person or an agent writes through. {@link RoomService.postNotice} is the room
 * speaking about itself: it dispatches from nothing and answers with a plain
 * `RoomEntry`, because there is no writer waiting to be told who it reached.
 */
export type PostedEntry = RoomEntry & {
  /** Who this write triggered and who it could not, or `null` when dispatch threw. */
  dispatch: RoomDispatchSummary | null;
};
