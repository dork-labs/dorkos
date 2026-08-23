/**
 * Room orchestration: create, join, post, read cursor, thread replies.
 *
 * The service owns the rules a room has that the tables cannot state — a reply
 * may not hang off another reply, a channel slug is unique while it is
 * live — and it publishes what happened to the two streams a room fans out on:
 * its own SSE stream for entries and signals, the global `/api/events` stream
 * for lifecycle. Membership lives next door in `room-roster.ts`, and turning a
 * committed post into agent replies lives in `room-trigger.ts`.
 *
 * **Roster writes are the owner's — as far as identity can tell.** Adding,
 * removing, or re-configuring a member is refused for anyone the server does
 * not resolve as this install's owner. That was a harmless asymmetry while
 * nothing read `responseMode`; now that a post triggers turns, an agent that
 * could widen another agent's addressing could drive replies nobody asked for,
 * from inside the room where it is hardest to notice.
 *
 * **Those three are the whole list. `updateRoom` is deliberately not on it** —
 * a room's title, topic and archived flag are writable by any member, so an
 * agent can rename or archive a room it belongs to. That is pre-existing and
 * survives DOR-598 unchanged, and it is not a gate anyone forgot: the naive fix
 * (`requireOperator` in `updateRoom`) breaks `createRoom`'s DM un-archive path,
 * where the caller re-opening its own archived direct message may legitimately
 * be that agent. Closing it properly means splitting the re-open out first.
 * Tracked as DOR-608; do not add the gate without that split.
 *
 * **One narrow exception now exists: a SYSTEM room** — a room carrying a
 * well-known key, which today means the #team channel `ensureTeamRoom` opens at
 * boot (team-room-home spec D3.1). Renaming or archiving one is refused for
 * anyone but the owner. It is not the blanket gate above and cannot become it:
 * the refusal reads `wellKnown`, a DM never has one, so the un-archive path
 * DOR-608 protects is untouched by construction. The product renders its home
 * tab from that room, so an agent that could rename or put it away could take
 * the cockpit's front door with it.
 *
 * **The gates ask who the OWNER is, never whether the author is a human**
 * (DOR-598). Those were the same question only while this table held exactly one
 * human author. It will not: joining a community fills it with other humans —
 * cached remote members whose messages you hold (ADR 260727-184933 D6) — and
 * none of them operates this machine. Ownership is injected as `isOwnerAuthor`
 * rather than read here, because whether an account exists is not a room's
 * business to know.
 *
 * Read "not the owner" literally: it means a request the server resolved to
 * somebody else. In the DEFAULT posture (`auth.enabled` off) a request carrying
 * no `X-DorkOS-Agent` header resolves to the owner, so a program on this machine
 * clears every gate in this file by omitting a header. That is the documented
 * DOR-505 residual, not a hole this domain opened or can close — with login off
 * there is nothing left to tell a local program from the person at the keyboard.
 * Turning **Require login** on is what makes these gates mean what they say.
 *
 * What holds regardless is `turn-budget.ts`, which counts without asking who is
 * calling: a per-room cap on what any ONE room may spend, and a global cap on
 * what the whole install may. The per-room one bounds a room, not a bill —
 * rooms are free to create, so it alone can be multiplied by making more of
 * them; the global one is the ceiling. These gates shape a healthy room; those
 * caps are what bound a dishonest one.
 *
 * **A thread is no longer one of those levers** (ADR 260728-022013). While a
 * thread was a child room it came with a fresh budget window and a fresh cascade
 * namespace, which is why opening one used to answer to the seeding gate; now a
 * thread reply is an entry in its channel, so it spends the channel's budget and
 * lands in the channel's ancestry set. Threads got cheaper to make and stopped
 * buying anything.
 *
 * @module server/services/rooms/room-service
 */
import { ulid } from 'ulidx';
import type { DbTransaction } from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import {
  ChannelTypeSchema,
  type ChannelType,
  type PlatformChatType,
  type SignalType,
} from '@dorkos/shared/relay-schemas';
import type {
  AuthorKind,
  CreateRoomRequest,
  Room,
  RoomAttachment,
  RoomEntry,
  RoomEntryBody,
  RoomEntryReaction,
  RoomKind,
  RoomBridgeInfo,
  RoomMember,
  RoomMoment,
  RoomPresencePayload,
  RoomReactionEvent,
  RoomRosterEntry,
  RoomSessionBinding,
  RoomSummary,
  RoomWithRoster,
  ThreadSummary,
  UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import {
  directMessageTitle,
  isDirectMessageTitleDerived,
  RoomMomentSchema,
  THREAD_PREVIEW_MAX_CHARS,
  withoutActivityTarget,
} from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type { RoomExportLine } from '@dorkos/shared/room-export-schemas';
import { logger } from '../../lib/logger.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { eventFanOut } from '../core/event-fan-out.js';
import type { ReadCursorService } from '../core/read-cursor-service.js';
import { notifyRoomMessage as emitRoomMessageNotification } from '../notifications/emitters/room-messages.js';
import { markRoomRead as markRoomNotificationsRead } from '../notifications/notification-service.js';
import type {
  Bridge,
  BridgeStore,
  BridgeablePlatformChatType,
} from '../relay/chat-bridge/bridge-store.js';
import {
  bridgedRoomFraming,
  topicNamesForEntries,
} from '../relay/chat-bridge/room-context-framing.js';
import type { AuthorRecord, AuthorRegistry, ExternalAuthorIdentity } from './author-registry.js';
import { deriveCascade } from './cascade-guard.js';
import type { EngagedWindow } from './engagement.js';
import type { CollectWindow } from './room-collect.js';
import type { RoomLimitsResolver } from './limits/room-limits.js';
import { resolveAddressing } from './mentions.js';
import type { ReactionBudget } from './reactions/reaction-budget.js';
import type { ReactionStore } from './reactions/reaction-store.js';
import type { AttachmentRowStore } from './attachments/attachment-row-store.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import { buildRoomExport, createExportAuthorResolver } from './room-export.js';
import {
  buildBridgeAgentSwappedNotice,
  buildBridgeDisconnectedNotice,
  buildBridgeHistoryNotice,
  buildBridgeSecondAgentRefusedNotice,
} from './notices/notice-copy.js';
import { dmTitleNames, RoomRoster, type AddMemberInput } from './room-roster.js';
import { parseEntryBody, type NewRoom } from './room-rows.js';
import type { RoomStore } from './room-store.js';
import type { RoomBroadcaster } from './room-stream.js';
import { RoomTriggerDispatcher, type RoomTurnRunner } from './room-trigger.js';
import type { ActiveClaimView, HeldView } from './room-claims.js';
import type { RoomTurnBudget } from './limits/turn-budget.js';

/** Everything {@link RoomService} is constructed from. */
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
    /** The rooms to search — already resolved to what this caller may read. */
    roomIds: readonly string[];
    /** What the caller typed. */
    query: string;
    /** The most hits to bring back, best first. */
    limit: number;
    /** Ignore entries at or below this `seq`. */
    afterSeq: number;
  }): Array<{ roomId: string; seq: number }>;
}

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
 * How many entry ids one reaction lookup binds at a time.
 *
 * SQLite caps the parameters a single statement may bind (32 766 in the build
 * `better-sqlite3` ships), and the SSE replay is the one read with no bound on
 * its page: a reader gone for a week resumes against every entry since. Five
 * hundred is comfortably inside the cap and still turns a fifty-message page
 * into exactly one query, which is the case that runs constantly.
 */
const REACTION_LOOKUP_CHUNK = 500;

/**
 * The fields of an update that only the install's OWNER may send (DOR-1429).
 *
 * Listed rather than inferred, because the gate has to fire on a key that is
 * PRESENT AND `null` — clearing an override is a write like any other — and
 * `Object.hasOwn` over a named list is the only reading of "did they send this"
 * that a `null` cannot slip past. Constrained to {@link UpdateRoomRequest}'s own
 * keys, so a renamed field turns this red instead of silently guarding nothing.
 */
const ROOM_TURN_LIMIT_FIELDS = [
  'turnLimitsEnabled',
  'maxAgentDepth',
  'maxTurnsPerAgentPerCascade',
  'maxAutoTurnsPerHour',
] as const satisfies ReadonlyArray<keyof UpdateRoomRequest>;

/**
 * The most entries either history tool will return in one page
 * (room-participation spec §10.3).
 *
 * **A clamp, never a refusal.** An agent that asks for a thousand messages is not
 * making an error a `400` would teach it anything about; it wants as much as it
 * can have, and the useful answer is the most that is sensible plus a cursor to
 * ask again with. Two hundred is roughly a long afternoon in a busy channel and
 * still a page a model can hold.
 */
export const HISTORY_PAGE_MAX = 200;

/**
 * Bring a requested page size inside {@link HISTORY_PAGE_MAX}, and above zero.
 *
 * @param limit - What the caller asked for.
 * @returns A page size the store will accept.
 */
function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return HISTORY_PAGE_MAX;
  return Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * The header badge's and room sheet's view of a room's bridge (chats-as-channels
 * spec §8, §3.4) — `null` for an unbridged room.
 *
 * `visibility` is projected through {@link bridgedRoomFraming}, the SAME
 * derivation `room_context` carries into a turn: the header badge and the model's
 * own view of the room read one function's output, never two independent
 * encodings of "how much can this bot see" that could drift apart.
 *
 * Takes the bridge rather than a room id, so the room list can resolve every
 * bridge in one query and project each one here.
 *
 * @param bridge - The bridge row, or `null`/`undefined` for an unbridged room.
 */
function bridgeInfo(bridge: Bridge | null | undefined): RoomBridgeInfo | null {
  if (!bridge) return null;
  return {
    visibility: bridgedRoomFraming(bridge).visibility,
    platformTitle: bridge.platformTitle,
  };
}

/** Provenance a post carries when a trigger produced it. */
export interface PostTrigger {
  root: string;
  depth: number;
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
 * Input to {@link RoomService.createBridgedRoom} — already resolved and
 * validated by the caller (chats-as-channels spec §3.1's claim card / "Bridge
 * to a channel" entry points, both one code path). Every platform-sourced
 * field crosses the trust boundary at this call.
 */
export interface CreateBridgedRoomRequest {
  /** The relay adapter instance this chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /** The binding this bridge is a mode of. */
  bindingId: string;
  /**
   * Read from `platformData.chatType`, never re-derived (spec §3.3). The full
   * raw {@link PlatformChatType}: `'channel'` — a Telegram broadcast — is
   * accepted at the boundary and refused inside
   * {@link RoomService.createBridgedRoom}, so the refusal lives at the one trust
   * boundary rather than being pushed onto every caller's type.
   */
  chatType: PlatformChatType;
  /**
   * `ChannelTypeSchema` value read off the relay subject, or `null` for a DM
   * subject. Typed loosely at the boundary (`string | null`) and parsed
   * through `ChannelTypeSchema.nullable()` at the top of
   * {@link RoomService.createBridgedRoom} — the same trust-boundary reasoning
   * as `chatType` above applies to this field too.
   */
  channelType: string | null;
  /**
   * The raw, UNSANITIZED platform title: the external person's display name
   * for a `dm`, the platform chat title for a `channel`. Sanitized inside
   * {@link RoomService.createBridgedRoom} (spec §9.2, A9.3) — never sanitize it
   * twice, and never pass an already-sanitized value.
   */
  title: string;
  /** The bound agent's directory. Exactly one agent seeds a bridged room (D-6 Q3). */
  agentPath: string;
  /** The operator's author id. The bridge always creates the room AS the operator (spec §3.4). */
  operatorAuthorId: string;
}

/**
 * Input to {@link RoomService.rebridge} — re-bridging a chat that already has a
 * surviving (archived) bridge row (chats-as-channels spec §3.5). Resolved
 * through the bridge store on `(adapterId, chatId)`, never the roster: the chat
 * is the natural key that identifies the room, and the row outlives the flag.
 */
export interface RebridgeRequest {
  /** The relay adapter instance this chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /**
   * The binding that now owns this bridge. May differ from the row's current
   * `bindingId` — a binding is re-created rather than re-pointed, so even a
   * re-bridge to the SAME agent can carry a fresh binding id.
   */
  bindingId: string;
  /**
   * The agent to bind. When it resolves to the room's current bound agent this
   * is a plain reuse; when it resolves to a different one it is the agent swap
   * (§3.5, A3.6b), which adopts the surviving row and its whole log.
   */
  agentPath: string;
  /** The operator's author id. Re-bridging acts as the operator, like the create path. */
  operatorAuthorId: string;
}

/** Orchestration over the store, the roster, the author registry and the streams. */
export class RoomService {
  private readonly store: RoomStore;
  private readonly reactions: ReactionStore;
  /** How many emoji an agent may still land in one room this hour. */
  private readonly reactionBudget: ReactionBudget;
  /** Words in, entry coordinates out. The message index, behind its port. */
  private readonly findMessages: RoomMessageFinder;
  private readonly attachments: AttachmentRowStore;
  private readonly authors: AuthorRegistry;
  private readonly broadcaster: RoomBroadcaster;
  private readonly roster: RoomRoster;
  private readonly triggers: RoomTriggerDispatcher;
  /**
   * What bounds automatic replies in one room. Read per write, so a change in
   * Settings or on the room takes effect on the very next message.
   */
  private readonly limitsFor: RoomLimitsResolver;
  /** The live `uploads.maxFiles`. Read per post, so a change takes effect. */
  private readonly maxAttachmentsPerEntry: () => number;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;
  /** The record-based twin of {@link RoomService.isOwnerAuthor}. */
  private readonly isOwnerRecord: (record: AuthorRecord) => boolean;
  private readonly bridges: BridgeStore;
  /** Where the PEOPLE in a room have read up to. Never an agent's cursor. */
  private readonly readCursors: ReadCursorService;
  /**
   * The mesh agent table, keyed by directory — read here only to resolve a
   * posting agent's `agents.id` for a notification payload (spec
   * `notification-system` task T11). Every other agent lookup in this domain
   * goes through {@link RoomService.authors} or {@link RoomService.roster}.
   */
  private readonly agents: RoomAgentLookup;
  /** Whether the operator has muted a room. Read per post, never captured. */
  private readonly isRoomMuted: (roomId: string) => boolean;
  /**
   * Called synchronously after every committed entry — the chat bridge's
   * inline-delivery fast path (chats-as-channels §6.1). Registered after
   * construction (the delivery engine is built later, in the binding subsystem)
   * and unset by default, so an install with no bridge pays nothing here. It
   * must never throw into the commit; the bridge's own handler swallows its
   * errors, and this call site does too.
   */
  private onEntryCommitted?: (entry: RoomEntry) => void;
  /**
   * Called synchronously after every published ephemeral signal — the chat
   * bridge's presence forwarder (chats-as-channels §6.8). Registered after
   * construction, same as {@link RoomService.onEntryCommitted}, and unset by
   * default, so an install with no bridge pays nothing here. It must never
   * throw into the publish; {@link RoomService.publishSignal} guards the call
   * the same way {@link RoomService.publishEntry} guards its own listener.
   */
  private onSignalPublished?: (
    roomId: string,
    signal: SignalType,
    authorId: string,
    presence?: Partial<RoomPresencePayload>
  ) => void;

  constructor(deps: RoomServiceDeps) {
    this.store = deps.store;
    this.reactions = deps.reactions;
    this.reactionBudget = deps.reactionBudget;
    this.findMessages = deps.findMessages;
    this.attachments = deps.attachments;
    this.authors = deps.authors;
    this.broadcaster = deps.broadcaster;
    this.limitsFor = deps.limitsFor;
    this.maxAttachmentsPerEntry = deps.maxAttachmentsPerEntry;
    this.isOwnerAuthor = deps.isOwnerAuthor;
    this.isOwnerRecord = deps.isOwnerRecord;
    this.bridges = deps.bridges;
    this.readCursors = deps.readCursors;
    this.agents = deps.agents;
    this.isRoomMuted = deps.isRoomMuted;
    this.roster = new RoomRoster({
      store: deps.store,
      authors: deps.authors,
      agents: deps.agents,
      readCursors: deps.readCursors,
    });
    // The dispatcher writes back through this service (a reply is a post like
    // any other, mentions and provenance included), so it takes bound methods
    // rather than the store. They are only ever called after construction.
    this.triggers = new RoomTriggerDispatcher({
      store: deps.store,
      reactions: deps.reactions,
      authors: deps.authors,
      agents: deps.agents,
      // Read per turn, never captured: a room becomes bridged partway through
      // its life, and the standing line in the fence has to follow that rather
      // than whatever was true when the service was built.
      //
      // An ARCHIVED bridge still counts, and that is the deliberate direction.
      // Unbinding stops new messages arriving; it does not remove the ones
      // already in the log, and a room whose history holds a stranger's words
      // should not quietly lose the sentence that says so — so this reads
      // `findBridgeByRoom`, not a live-only lookup.
      bridgedFraming: (roomId) => {
        const bridge = this.bridges.findBridgeByRoom(roomId);
        return bridge ? bridgedRoomFraming(bridge) : null;
      },
      topicNamesFor: (entryIds) => topicNamesForEntries(this.bridges, entryIds),
      attachmentsFor: (roomId, entryIds) => this.attachments.listFor(roomId, entryIds),
      runner: deps.turns,
      budget: deps.budget,
      limitsFor: deps.limitsFor,
      engagedWindow: deps.engagedWindow,
      collect: deps.collect,
      holdCeilingMs: deps.holdCeilingMs,
      writer: {
        post: (roomId, input) => this.post(roomId, input),
        postNotice: (roomId, body, cascade, replyTo) =>
          this.postNotice(roomId, body, cascade, replyTo),
      },
      // The room's ephemeral channel, handed over as a bound method for the same
      // reason the writer is: the dispatcher publishes what its claim map knows
      // and stays ignorant of how a room fans out. `progress` is bound HERE, so
      // the one signal name presence may use is not a decision the dispatcher can
      // get wrong.
      publishPresence: (roomId, authorId, presence) =>
        this.publishSignal(roomId, 'progress', authorId, presence),
      // Deliberately NOT `room_activity`, which is the other event a room's work
      // makes the sidebar redraw for. That one fires on a committed entry and
      // carries the `seq` its reader orders the list by; a claim has no entry and
      // no `seq`, so borrowing the name would have meant either a lie in the
      // payload or a second meaning for its consumer to disambiguate
      // (room-presence spec §6).
      publishWorkingCount: (roomId, working) =>
        eventFanOut.broadcast('room_presence', { roomId, working }),
    });
  }

  /** The live subscription source behind `GET /api/rooms/:id/events`. */
  get stream(): RoomBroadcaster {
    return this.broadcaster;
  }

  /** The author registry, for callers that need to resolve their own identity. */
  get authorRegistry(): AuthorRegistry {
    return this.authors;
  }

  /**
   * Resolve once every turn a post triggered has finished.
   *
   * A cascade is asynchronous by construction — posting returns before any
   * agent has answered — so this is how a caller waits it out without sleeping.
   */
  /**
   * Every room turn in flight right now, for the diagnostic read surface.
   *
   * Delegated rather than re-derived: the dispatcher's claim map IS the answer,
   * and a second count computed from the store would be a second truth that can
   * disagree with the indicator people are looking at.
   *
   * @returns One row per live claim.
   */
  listActiveClaims(): ActiveClaimView[] {
    return this.triggers.listClaims();
  }

  /**
   * Every message waiting on an agent that is busy in another room.
   *
   * {@link RoomService.listActiveClaims}'s sibling, and the question it cannot
   * answer during an incident: a room showing no claim and no answer looks
   * exactly like a room whose message went nowhere. Delegated for the same
   * reason — the dispatcher's hold map IS the answer.
   *
   * @returns One row per live hold.
   */
  listHolds(): HeldView[] {
    return this.triggers.listHolds();
  }

  triggersIdle(): Promise<void> {
    return this.triggers.idle();
  }

  /**
   * Stop everything running in one room.
   *
   * RP8's halt verb (room-participation spec §10.4), and the only entry point
   * to it. **It is a control action and is never inferred from anything anybody
   * typed** — no phase of this product pattern-matches a message for "stop",
   * because a person telling a looping agent to stop is exactly the message a
   * looping agent will treat as one more turn to answer.
   *
   * Refuses like every other room verb: a caller who cannot see the room gets
   * the same `ROOM_NOT_FOUND` they get for a room that does not exist, and only
   * a person may halt — an agent stopping its room-mates mid-sentence is
   * arbitration, which this domain has declined twice (ADR 260726-170125).
   *
   * An archived room is NOT refused, deliberately, and it is the one place this
   * differs from `post`. Archiving stops a room gaining messages; a turn that
   * was already running when the room was archived is still running, and
   * refusing to stop it would leave the only way to stop it behind a door that
   * has just been shut.
   *
   * @param roomId - The room to stop.
   * @param viewerAuthorId - Who is stopping it.
   * @returns How many in-flight turns were interrupted; `0` when it was idle.
   */
  async haltRoom(roomId: string, viewerAuthorId: string): Promise<number> {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requirePersonAuthor(viewerAuthorId, 'stop a room');
    return this.triggers.halt(room);
  }

  /**
   * Stop one agent in a room, leaving the others working.
   *
   * The same three refusals as {@link RoomService.haltRoom}, plus one it cannot
   * have: the target has to be an agent on this room's roster. Answering
   * `0` for a name that is not there would hide a client bug behind a success,
   * and nothing leaks by saying so — `requireVisibleRoom` has already
   * established that this caller can see the room and its roster.
   *
   * A person on the roster is refused by the same code, and the sentence is
   * literally true: there is no agent by that id here. A second code that no
   * client would treat differently is a second thing to keep true.
   *
   * Order is load-bearing and matches every other verb here: **room first, then
   * caller, then target.** A caller who cannot see the room gets
   * `ROOM_NOT_FOUND` whether or not the agent exists, so a room id is never a
   * way to enumerate a roster.
   *
   * Archived rooms are allowed, exactly as they are for the room-wide halt.
   *
   * @param roomId - The room.
   * @param authorId - The agent to stop.
   * @param viewerAuthorId - Who is stopping it.
   * @returns `1` when a turn was interrupted, `0` when the agent was not running
   *   one here. `0` is a success.
   */
  async haltAgent(roomId: string, authorId: string, viewerAuthorId: string): Promise<number> {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requirePersonAuthor(viewerAuthorId, 'stop an agent');
    if (
      this.store.getMember(roomId, authorId) === null ||
      this.authors.getById(authorId)?.kind === 'human'
    ) {
      throw new RoomError('MEMBER_NOT_FOUND', 'No such agent in this room.');
    }
    return this.triggers.haltAgent(room, authorId, viewerAuthorId);
  }

  /**
   * Ask for this room's waiting message to be answered before the other rooms
   * waiting on the same agent.
   *
   * **It reorders and never preempts**, which is what keeps it out of the
   * arbitration this domain has declined twice (ADR 260726-170125): the blocking
   * turn is untouched, no second turn is started, and a promoted message still
   * waits for the agent to be free. What it orders is one agent's own unanswered
   * messages, which is what a person means by "answer me first".
   *
   * Gated exactly as {@link RoomService.haltRoom} is — a caller who cannot see
   * the room gets the same `ROOM_NOT_FOUND` a room that does not exist gets, and
   * only a person may ask, because an agent reordering its own queue would be
   * the agent deciding whose question matters.
   *
   * @param roomId - The room asking to be answered first.
   * @param authorId - The agent it is waiting on.
   * @param viewerAuthorId - Who is asking.
   * @returns `false` when there was nothing waiting — a stale button, not an
   *   error.
   */
  promoteHold(roomId: string, authorId: string, viewerAuthorId: string): boolean {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requirePersonAuthor(viewerAuthorId, 'ask to be answered first');
    return this.triggers.promoteHold(roomId, authorId);
  }

  /**
   * Ask one agent something the room never posted, on the room's own session
   * for it, and hand back what it said.
   *
   * The one caller is the welcome-back offer (DOR-1046): a person came back,
   * their agents have already posted what they did, and this is how one of them
   * is asked whether it has a next step worth a decision. It is deliberately
   * NARROW — it takes no viewer, refuses nobody by name, and posts nothing, so
   * it cannot become a second way to make an agent speak. Every bound a normal
   * trigger has still applies; see {@link RoomTriggerDispatcher.askAside}, which
   * also explains why the answer comes back rather than going straight in.
   *
   * **Never throws.** A missing room, an archived one, a deleted entry and a
   * failed turn are all the same answer: `null`, because the greeting this
   * belongs to must not fail the read-state write that revealed it.
   *
   * @param input.roomId - The room the offer belongs to.
   * @param input.authorId - The agent being asked.
   * @param input.aboutEntryId - The status line it just posted.
   * @param input.prompt - The question, as the model will see it.
   * @returns What it said, or `null` for silence of any kind.
   */
  async askAside(input: {
    roomId: string;
    authorId: string;
    aboutEntryId: string;
    prompt: string;
  }): Promise<string | null> {
    const room = this.store.getRoom(input.roomId);
    // An archived room takes no new posts, so an offer for it could never be
    // written down — spending a turn to find that out would be the speculative
    // cost this whole feature is gated on avoiding.
    if (room === null || room.archived) return null;
    const entry = this.store.getEntryById(input.roomId, input.aboutEntryId);
    if (entry === null) return null;
    return this.triggers.askAside({
      room,
      entry,
      authorId: input.authorId,
      prompt: input.prompt,
    });
  }

  // === Rooms ===

  /**
   * Open a channel or a DM, seeding its roster with the creator and whoever the
   * request names — by author id (`members`) or by agent directory
   * (`agentPaths`).
   *
   * `agentPaths` is what makes a DM one call. The cockpit knows agents by
   * directory and nothing else; author ids are minted server-side and the only
   * surface that resolves one is `POST /:id/members`. So creating a DM used to
   * mean create-then-join, and a failed join left a direct message with nobody
   * in it — a room named after an agent that the agent was not in, which no
   * amount of retrying could repair because the room already existed.
   *
   * Resolve-then-create: every member is resolved before `RoomStore.createRoom`
   * is called at all, and that call writes the room and its whole roster in one
   * transaction. So an unregistered agent path fails while the room does not
   * exist, and the obvious retry works. (The resolution itself is not inside
   * that transaction — it does not need to be, and saying so would be drift.)
   *
   * **A DM is idempotent on its member set.** Ask for a direct message with
   * people you already have one with and you get that conversation back, not a
   * second one beside it. A DM is identified by WHO IS IN IT, so two rooms
   * holding the same authors are the same room told twice — the failure mode
   * Teams ships, where duplicate chats are real and you are told to rename them
   * apart. Slack behaves the way this does.
   *
   * It has to be decided here rather than in the picker for two reasons. It is
   * an idempotency property of the resource, so every caller gets it — the
   * cockpit, an MCP client, a shell. And a client could only evaluate it by
   * holding every DM's roster, which is exactly the per-room fetch R5 deleted.
   *
   * Three consequences worth stating, because none of them is obvious:
   *
   * - **An archived match is un-archived and returned.** Archive is this
   *   product's reversible "put it away" (spec §12.4 — there is no Leave), so
   *   re-opening a conversation is what asking for it again means. Minting a
   *   parallel room would strand the history in the archived one.
   * - **The existing room keeps its own title.** A request that matched is
   *   asking for a conversation, not renaming one; silently retitling a room
   *   somebody had named would be a side effect nobody asked for. Rename is its
   *   own verb (`PATCH /api/rooms/:id`).
   * - **The caller is told which one it got**, via {@link OpenedRoom.created},
   *   because nothing in the body says. This is an upsert on a natural key, not
   *   a replay of one caller's earlier answer against an idempotency key they
   *   supplied — the room this matches may have been opened by somebody else
   *   hours ago — so the honest report is PUT-shaped: 201 for a room that was
   *   created, 200 for one that was already there.
   * - **`lastActivityAt` is left alone**, on the matched path and the
   *   un-archived one alike. Opening a conversation is not activity in it, and
   *   bumping it would push a silent room to the top of a sidebar sorted by
   *   recency and tell the reader something happened. A re-opened DM comes back
   *   where it was.
   *
   * @param request - The validated create request.
   * @param creatorAuthorId - The author opening the room; joined automatically.
   * @returns The room with its roster and whether this call created it — new, or
   *   the one that already held these exact members.
   */
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): OpenedRoom {
    const slug = request.kind === 'channel' ? (request.slug ?? slugify(request.title ?? '')) : null;
    if (request.kind === 'channel' && !slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number, or give it a slug'
      );
    }
    if (slug && this.store.findLiveChannelBySlug(slug)) {
      throw new RoomError('SLUG_TAKEN', `A channel called #${slug} already exists`);
    }

    const draft: NewRoom = {
      id: ulid(),
      kind: request.kind,
      slug,
      title: request.title ?? `#${slug ?? ''}`,
      topic: request.topic ?? null,
      workspaceId: request.workspaceId ?? null,
      createdAt: new Date().toISOString(),
    };

    // Resolve the whole roster BEFORE anything is written. An unknown author id
    // or an unregistered agent path has to fail while the room does not exist
    // yet — otherwise the caller gets a 404 for a room that is sitting in the
    // table holding its slug.
    const joinedAt = draft.createdAt;
    const creator = this.roster.requireAuthor(creatorAuthorId);
    const resolved = new Map<string, AuthorRecord>([[creator.id, creator]]);
    for (const authorId of request.members) {
      const author = this.roster.resolve({ authorId });
      resolved.set(author.id, author);
    }
    for (const agentPath of request.agentPaths) {
      const author = this.roster.resolve({ agentPath });
      resolved.set(author.id, author);
    }
    // Opening a room is not a way around the operator-only roster rule. An agent
    // may make itself a room, and may bring a colleague into one — but only into
    // a room the person is on the roster of (the three-way rule,
    // ADR 260814-025326). `addMember` and `removeMember` hold the same shape
    // afterwards, so this is a gate and not a formality.
    this.requireSeedingAllowed(creator, [...resolved.values()]);

    // Deliberately AFTER that gate, not before. A caller the gate refuses gets
    // the same 403 whether or not the room it named exists, so this stays a
    // create path that sometimes answers with an existing room and never a way
    // to probe for one.
    if (request.kind === 'dm') {
      const existing = this.store.findDmByMemberSet([...resolved.keys()]);
      if (existing) {
        // `updateRoom` re-checks visibility and broadcasts `room_updated`, which
        // is what a sidebar holding a stale list needs to hear. Its slug-reclaim
        // branch is channel-only, so it is inert here.
        const reopened = existing.archived
          ? this.updateRoom(existing.id, creatorAuthorId, { archived: false })
          : this.withRoster(existing, creatorAuthorId);
        return { ...reopened, created: false };
      }
    }

    const members = [...resolved.values()].map((author) => ({
      authorId: author.id,
      responseMode: this.roster.seedResponseMode(draft, author),
      joinedAt,
    }));

    const room = this.store.createRoom(draft, members);

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { ...this.withRoster(room, creatorAuthorId), created: true };
  }

  /**
   * Get — or open, once — the channel holding a well-known key. The write half
   * of `ensureTeamRoom` (team-room-home spec D3.1). **Operator-only.**
   *
   * **Idempotent on the key, not on the name.** A room already carrying the key
   * is returned untouched, whatever it has since been renamed to, archived to,
   * or given as a topic: this runs on every boot, and a hook that re-asserted
   * the seed values would quietly undo the person's own edits every restart.
   * The key is the identity precisely so the name is free to change.
   *
   * **Separate from {@link RoomService.createRoom} because the key must not be
   * requestable.** `CreateRoomRequest` deliberately has no `wellKnown` field —
   * a well-known key is what makes a room a system room, so an API that let a
   * caller name one would let an agent mint a room the owner alone may rename.
   * This method is reachable only from the boot hook.
   *
   * **The slug is de-collided, never stolen — and it steps over archived
   * channels too.** An install may already have an ordinary `#team` somebody
   * made; adopting it would hand a person's own channel system-room semantics
   * and a roster of every agent, so the system room takes the next free name
   * (`#team-2`) instead. An ARCHIVED `#team` is stepped over for a second
   * reason: archiving releases a slug, so a system room that took it would
   * leave that channel permanently un-un-archivable — the way back is the name
   * it left behind. See {@link RoomService.uniqueChannelSlug}.
   *
   * **The find-then-insert is not atomic across processes, and the insert is
   * what settles it.** Two boots — a cockpit and a CLI started together — can
   * both read "no team room" and both try to write one; the unique key on
   * `rooms.well_known` makes exactly one of them win. The loser ADOPTS the
   * winner's row rather than failing, because a loser that gave up would leave
   * that boot with no home room and no agents seated in the one that exists.
   * The re-read decides it rather than an errno test: any insert failure is
   * re-checked against the key, and one that did not leave the key held is
   * rethrown untouched, so nothing real is swallowed.
   *
   * @internal Reachable only from the `ensureTeamRoom` boot hook. Not a route,
   *   not a tool, and deliberately not part of `CreateRoomRequest`.
   * @param wellKnown - The key this room answers to forever (`'team'`).
   * @param seed - The name and topic to open it with, used only on creation.
   * @param operatorAuthorId - The install owner, who is seeded as its first member.
   * @returns The room, and whether this call is what created it.
   */
  /**
   * Record which member holds this room's **fallback seat** — the one that
   * answers a post nobody addressed (team-room-home spec D3.4).
   * **Operator-only**, for the same reason `updateMembership` is: the seat is
   * what makes an agent answer without being addressed, so an agent able to
   * claim it could manufacture a conversation.
   *
   * Paired with, and never a substitute for, the `always` mode on that same
   * membership: the mode is what ADDRESSING selects the seat with, and this is
   * what tells the dispatcher and the boot reconcile WHICH member the seat is —
   * a question `always` cannot answer, because a person may set any agent to
   * "Everything" themselves.
   *
   * @internal Reachable only from the `ensureTeamRoom` boot hook and the
   *   default-agent watcher beside it. Not a route and not a tool.
   * @param roomId - The room.
   * @param operatorAuthorId - The install owner.
   * @param authorId - The member taking the seat, or `null` to empty it.
   * @returns The updated room.
   */
  setFallbackSeat(roomId: string, operatorAuthorId: string, authorId: string | null): Room {
    this.requireVisibleRoom(roomId, operatorAuthorId);
    this.requireOperator(operatorAuthorId, 'which agent answers what nobody addressed');
    const room = this.store.setFallbackSeat(roomId, authorId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  ensureSystemChannel(
    wellKnown: string,
    seed: { slug: string; topic?: string },
    operatorAuthorId: string
  ): { room: Room; created: boolean } {
    this.requireOperator(operatorAuthorId, 'the rooms DorkOS itself depends on');
    const existing = this.store.findByWellKnown(wellKnown);
    if (existing) return { room: existing, created: false };

    const slug = this.uniqueChannelSlug(seed.slug, { includeArchived: true });
    const createdAt = new Date().toISOString();
    const operator = this.roster.requireAuthor(operatorAuthorId);
    let room: Room;
    try {
      room = this.store.createRoom(
        {
          id: ulid(),
          kind: 'channel',
          slug,
          title: `#${slug}`,
          topic: seed.topic ?? null,
          workspaceId: null,
          wellKnown,
          createdAt,
        },
        [
          {
            authorId: operator.id,
            responseMode: this.roster.seedResponseMode({ kind: 'channel' }, operator),
            joinedAt: createdAt,
          },
        ]
      );
    } catch (err) {
      const won = this.store.findByWellKnown(wellKnown);
      if (!won) throw err;
      return { room: won, created: false };
    }
    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { room, created: true };
  }

  /**
   * Open a room for a claimed platform chat (chats-as-channels spec §3.1–§3.4)
   * — the room half of the bridge create path.
   *
   * **Never idempotent on member set — the whole reason this method exists
   * rather than a `kind: 'dm'` call to {@link RoomService.createRoom}.** A
   * bridged private chat's roster (the bound agent plus the operator) is
   * byte-identical to the operator's own private DM with that agent, and
   * `createRoom`'s DM branch would silently return — and un-archive — that
   * private conversation, landing a stranger's messages in it (spec §3.2, D-7
   * amendment 1). This method never calls {@link RoomStore.findDmByMemberSet}
   * at all, in either kind branch: that is the bypass the spec requires, and
   * it holds by construction rather than by a flag threaded through the shared
   * path.
   *
   * **Idempotent on the chat — resolved through the bridge store, never the
   * roster (spec §3.2, A3.2).** After the chat-type validation below, the
   * next thing this method does is {@link BridgeStore.findBridgeByChat}. A
   * live bridge already pointing at the SAME binding is the plain-replay
   * case — bridging a chat that is already bridged the way it is already
   * bridged — and this method self-heals it by returning that room rather
   * than minting a second one beside it. Anything else an existing row could
   * mean — a different binding (which usually, but not always, means a
   * different agent: a binding can also be re-created for the SAME agent),
   * or an archived row (un-archive and reuse) — is §3.5's re-bridge
   * lifecycle, which is task 1.5's, not this create path's: this method
   * refuses those with `CHAT_ALREADY_BRIDGED` rather than guessing at rebind
   * semantics it does not implement. The `UNIQUE (adapter_id, chat_id)`
   * index is the structural backstop either way.
   *
   * **Kind mapping (§3.3).** `private` → `dm`; `group` / `supergroup` →
   * `channel`; `channel` (a Telegram broadcast) is refused — a broadcast is
   * not a conversation.
   *
   * **Roster (§3.4).** Exactly the bound agent and the operator, both written
   * in the SAME transaction as the room and the `room_bridges` row. A bridged
   * `channel`'s agent joins `mention-only`, resolved directly into its
   * membership row here — never as a follow-up `setResponseMode` — because
   * `RoomRoster.seedResponseMode` returns `engaged` for a channel, and there
   * must be no observable instant where a bridged group's agent is anything
   * but mention-gated (D-7 amendment 1's "no observable instant" invariant,
   * §3.4's implementation 1). A bridged `dm`'s agent keeps the manifest
   * default, same as any other DM. The operator is not re-checked against
   * `requireSeedingAllowed`: the bridge always creates as the operator, which
   * is what satisfies that gate without an exemption (§3.4).
   *
   * **Title and slug (§3.4, §9.2, A9.3).** `request.title` is untrusted
   * platform text and is sanitized HERE, at creation, not only at render —
   * `sanitizeIdentity`, the one function, never a second copy. A `channel`
   * slug that collides with a live channel gets `-2`, `-3`, … appended until
   * free (A3.4): a platform title is not something the person bridging typed
   * and gets to fix, so this never throws `SLUG_TAKEN` the way
   * {@link RoomService.createRoom} does.
   *
   * @param request - Every input the create path needs, already resolved by
   *   the caller (the claim flow / "Bridge to a channel" action).
   * @returns The new bridged room with its roster.
   */
  createBridgedRoom(request: CreateBridgedRoomRequest): OpenedRoom {
    // `request.chatType` is typed as the closed `PlatformChatType` union, but
    // that type is a claim about the CALLER's discipline, not a runtime
    // guarantee: the value crosses a trust boundary from Telegram's
    // own string (`chat.type`, `packages/relay/src/adapters/telegram/
    // inbound.ts:470`) through several untyped hops before it reaches here.
    // This switch is exhaustive and refuses anything it does not recognize,
    // rather than letting an unrecognized string fall through the
    // kind-mapping ternary below and get silently treated as `channel`.
    let platformChatType: BridgeablePlatformChatType;
    switch (request.chatType) {
      case 'private':
      case 'group':
      case 'supergroup':
        platformChatType = request.chatType;
        break;
      case 'channel':
        throw new RoomError(
          'BROADCAST_NOT_BRIDGEABLE',
          'A broadcast channel is not a conversation and cannot be bridged'
        );
      default: {
        const unrecognized: string = request.chatType;
        throw new RoomError(
          'UNKNOWN_CHAT_TYPE',
          `Unrecognized platform chat type '${unrecognized}' — cannot bridge`
        );
      }
    }

    // Same trust-boundary reasoning as `chatType` above: `channelType` is
    // typed loosely (`string | null`) at the request boundary and parsed
    // through the real schema here, as the field's own doc claims — not
    // just declared and trusted.
    const channelTypeResult = ChannelTypeSchema.nullable().safeParse(request.channelType);
    if (!channelTypeResult.success) {
      throw new RoomError(
        'UNKNOWN_CHAT_TYPE',
        `Unrecognized channel type '${String(request.channelType)}' — cannot bridge`
      );
    }
    const channelType: ChannelType | null = channelTypeResult.data;

    // Checked BEFORE the idempotent-replay short-circuit below, not just on
    // the create branch — a non-owner caller gets the same 403 whether or not
    // the chat it named is already bridged, the same "refuse before probing"
    // shape `createRoom`'s own seeding gate takes. That guarantee holds
    // relative to the BRIDGE LOOKUP below only — it says nothing about the
    // chat-type validation above, which runs first and refuses an
    // unrecognized or broadcast `chatType` before the operator is even
    // resolved. That ordering is harmless: a chat type is not information a
    // non-owner caller learns anything sensitive from.
    const operator = this.roster.requireAuthor(request.operatorAuthorId);
    if (!this.isOwnerAuthor(operator.id)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can bridge a chat');
    }

    const existingBridge = this.bridges.findBridgeByChat(request.adapterId, request.chatId);
    if (existingBridge) {
      if (existingBridge.archivedAt !== null || existingBridge.bindingId !== request.bindingId) {
        throw new RoomError(
          'CHAT_ALREADY_BRIDGED',
          'This chat is already bridged; re-bridging it needs the rebind flow, not a fresh create'
        );
      }
      const room = this.store.getRoom(existingBridge.roomId);
      if (!room) {
        // Structurally impossible on this single connection — `room_bridges.
        // room_id` has no FK cascade path that outlives its room — but a
        // defensive read-back beats a null-pointer crash if it ever happens.
        throw new RoomError('ROOM_NOT_FOUND', 'The bridged room no longer exists');
      }
      // The binding matched, which is what makes this a replay rather than a
      // rebind — but the caller's BELIEF about which agent that binding
      // points at might still be stale or wrong. Surface the mismatch rather
      // than silently handing back a room bound to a different agent than the
      // caller thinks it bridged; still return the existing room either way,
      // since the binding identity — not the caller's `agentPath` — is what
      // this method treats as ground truth.
      const currentAgent = this.roster
        .list(room.id)
        .map((member) => this.authors.getById(member.authorId))
        .find((author): author is AuthorRecord => author?.kind === 'agent');
      if (currentAgent && currentAgent.naturalKey !== request.agentPath) {
        logger.warn(
          '[rooms] a bridge replay named a different agent than the room actually holds',
          {
            roomId: room.id,
            bindingId: request.bindingId,
            requestedAgentPath: request.agentPath,
            actualAgentPath: currentAgent.naturalKey,
          }
        );
      }
      return { ...this.withRoster(room, operator.id), created: false };
    }

    const kind: RoomKind = platformChatType === 'private' ? 'dm' : 'channel';

    const agent = this.roster.resolve({ agentPath: request.agentPath });

    const title = sanitizeIdentity(request.title) ?? this.fallbackBridgeTitle(kind);
    const slug = kind === 'channel' ? this.uniqueChannelSlug(slugify(title) ?? 'chat') : null;

    const createdAt = new Date().toISOString();
    const draft: NewRoom = {
      id: ulid(),
      kind,
      slug,
      title,
      topic: null,
      workspaceId: null,
      createdAt,
    };
    // The one place this seeds a responseMode that is NOT
    // `RoomRoster.seedResponseMode`'s own answer — mention-only for a bridged
    // channel is a create-time override, resolved atomically with the add
    // (§3.4's implementation 1), not a value that channel's default would have
    // produced (`engaged`) and that a later write would have to correct.
    const agentResponseMode: ResponseMode =
      kind === 'channel' ? 'mention-only' : this.roster.seedResponseMode(draft, agent);
    const members = [
      {
        authorId: operator.id,
        responseMode: this.roster.seedResponseMode(draft, operator),
        joinedAt: createdAt,
      },
      { authorId: agent.id, responseMode: agentResponseMode, joinedAt: createdAt },
    ];

    const room = this.store.createRoom(draft, members, (tx) => {
      this.bridges.createBridge(
        {
          roomId: draft.id,
          adapterId: request.adapterId,
          chatId: request.chatId,
          channelType,
          platformChatType,
          bindingId: request.bindingId,
          // The SAME sanitized value that just named the room, never a second
          // copy — `null` for a DM, whose title is the person's display name
          // rather than a platform-side chat title (spec §3.4). This is what
          // lets the room sheet show what the chat is *actually* called on
          // the platform even after the room itself has been renamed, since a
          // rename never touches this column.
          platformTitle: kind === 'channel' ? title : null,
          // D-6 Q5: seeded by room kind — true for a bridged dm, false for a
          // bridged channel. The one per-bridge override lives on the row
          // itself; this create path never flips it later.
          deliverNotices: kind === 'dm',
          createdAt,
        },
        tx
      );
    });

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { ...this.withRoster(room, operator.id), created: true };
  }

  /**
   * Archive a bridged room and stamp its bridge row archived — the room half of
   * §3.5's unbind, bot-kick, and out-of-band-archive paths.
   *
   * **The disconnect notice is posted BEFORE the archive, because it must be.**
   * `postNotice` refuses an archived room, so the room's own voice records the
   * disconnect while it still can — the last line in the log, which is exactly
   * where a person scrolling back later looks for why the chat went quiet. A
   * room already archived out of band (§10.9) skips both the notice and the
   * archive and only stamps the bridge row, so this method is safe to call on a
   * room whose archive it did not itself perform.
   *
   * **The bridge row and every external ref survive (§3.5).** Only `archivedAt`
   * is stamped, and only when it is not already set — so a re-bridge finds the
   * row, its refs, and the room's whole log intact, and echo suppression and
   * reply targeting keep working across the gap. Clearing the binding's own
   * `bridge`/`roomId` is the caller's half (`BridgeLifecycle`): the binding is a
   * relay concern this domain does not write.
   *
   * @param roomId - The bridged room to archive.
   * @param operatorAuthorId - The install owner; the bridge always acts as them.
   * @param opts.reason - The platform's own words for why, when the disconnect
   *   was forced rather than chosen (bot blocked or kicked, §10.3). Written into
   *   the notice; omitted for a plain operator unbridge.
   */
  archiveBridgedRoom(
    roomId: string,
    operatorAuthorId: string,
    opts: { reason?: string } = {}
  ): void {
    const room = this.requireVisibleRoom(roomId, operatorAuthorId);
    this.requireOperator(operatorAuthorId, 'whether a chat is connected');
    const bridge = this.bridges.findBridgeByRoom(roomId);
    if (!bridge) {
      throw new RoomError('NOT_A_BRIDGED_ROOM', 'This room is not bridged to an external chat');
    }
    if (!room.archived) {
      this.postNotice(roomId, buildBridgeDisconnectedNotice(opts.reason));
      this.updateRoom(roomId, operatorAuthorId, { archived: true });
    }
    if (bridge.archivedAt === null) {
      this.bridges.archiveBridge(roomId, new Date().toISOString());
    }
  }

  /**
   * Re-bridge a chat that still has a surviving bridge row (chats-as-channels
   * spec §3.5) — the lifecycle path `createBridgedRoom` deliberately refuses
   * with `CHAT_ALREADY_BRIDGED`. Resolved through the bridge store on
   * `(adapterId, chatId)`, never the roster, because the chat is the natural key
   * and the row is the identity.
   *
   * Two shapes, decided by whether the requested agent is the one the room
   * already holds:
   *
   * - **Same agent — reuse.** Un-archive the room and the bridge row and hand it
   *   back. The log, the refs, and the agent's own `(room, agent)` session are
   *   all where they were, so the conversation simply resumes (A3.6). When the
   *   binding id changed under it — a binding is re-created, not re-pointed — the
   *   row is re-pointed to match, but nothing else moves and no notice is
   *   posted: nothing about the conversation changed.
   * - **Different agent — adopt and swap (A3.6b).** The surviving row's
   *   `UNIQUE (adapter_id, chat_id)` makes a second room impossible, and that is
   *   the right answer: minting a parallel room would strand this chat's history.
   *   So the rebind ADOPTS the room. The old agent leaves the roster and its
   *   `(room, agent)` session is dropped with it (orphaned, never migrated); the
   *   new agent joins with its mode seeded ATOMICALLY IN THE `RoomRoster.add`
   *   call — `mention-only` on a bridged channel, the manifest default on a
   *   bridged dm — so there is no observable instant where a swapped-in channel
   *   agent is anything but mention-gated, the same invariant the create path
   *   holds (§3.4). The bridge row is re-pointed to the new binding, and ONE
   *   notice posted into the room names the swap. The room keeps its id, title,
   *   slug and every external ref, so echo suppression and reply targeting stay
   *   continuous.
   *
   * The mode is seeded in the `add`, and every write that could fail — the
   * re-point, the notice — runs AFTER it, so a failure anywhere past the add
   * still leaves the swapped-in agent correctly gated (A3.6b's simulated-failure
   * assertion). Setting the binding's own `bridge`/`roomId` back on is the
   * caller's half (`BridgeLifecycle`).
   *
   * @param request - Which chat, which binding, which agent, and the operator.
   * @returns The re-bridged room with its roster; `created` is always `false` —
   *   re-bridging never mints a room.
   */
  rebridge(request: RebridgeRequest): OpenedRoom {
    const operator = this.roster.requireAuthor(request.operatorAuthorId);
    if (!this.isOwnerAuthor(operator.id)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can bridge a chat');
    }

    const bridge = this.bridges.findBridgeByChat(request.adapterId, request.chatId);
    if (!bridge) {
      throw new RoomError(
        'NO_SURVIVING_BRIDGE',
        'This chat has no bridge to re-bridge; create one instead'
      );
    }
    const room = this.store.getRoom(bridge.roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'The bridged room no longer exists');
    }

    const currentAgentMember = this.roster
      .list(room.id)
      .find((member) => member.author.kind === 'agent');
    const newAgent = this.roster.resolve({ agentPath: request.agentPath });
    const sameAgent = currentAgentMember?.authorId === newAgent.id;

    // Un-archive first — both shapes bring the room back to life, and the swap's
    // notice below cannot be posted into an archived room. The bridge row's
    // `archivedAt` is cleared to match, so `postExternal` accepts inbound again.
    // A CHANNEL un-archives onto a freshly-resolved unique slug so re-bridging
    // never throws `SLUG_TAKEN` on a platform-sourced title (§3.4, A3.4) — see
    // {@link RoomService.unarchiveBridgedRoom}.
    //
    // **The room-half writes from here down are NOT one transaction, on
    // purpose.** Each is a separate synchronous commit on this single-connection
    // `better-sqlite3` database — un-archive room, un-archive row, remove old
    // member, add new, re-point row, post notice — and they deliberately do not
    // share a `tx` handle: `RoomStore.removeMember`/`addMember` and the
    // bridge-store writers take none, and widening those seams for this one
    // caller is exactly the coupling `addMember`'s own doc argues against. The
    // recovery contract stands in for atomicity: this whole method is idempotent
    // under retry, because it re-reads the surviving row and the CURRENT roster
    // every time. A throw after the old agent is removed but before the new one
    // is added leaves an agent-less, un-archived room; re-running `rebridge`
    // finds no agent member, takes the different-agent branch, and adds the new
    // one. A throw after the add but before the re-point leaves the new agent
    // seeded correctly (A3.6b) and the row still on the old binding; re-running
    // sees the new agent already present, takes the same-agent branch, and
    // finishes the re-point. The only write a retry does not replay is the swap
    // notice — best-effort by design (`notices/notice-log.ts`'s degrade contract),
    // never the durable state.
    if (room.archived) this.unarchiveBridgedRoom(room);
    this.bridges.unarchiveBridge(bridge.roomId);

    if (!sameAgent) {
      // Old agent leaves, taking its (room, agent) session with it (§3.5) — the
      // store drops the `room_sessions` row inside `removeMember`.
      if (currentAgentMember) {
        this.roster.remove(room.id, currentAgentMember.authorId);
        eventFanOut.broadcast('room_member_removed', {
          roomId: room.id,
          authorId: currentAgentMember.authorId,
        });
      }
      // Seeded IN the add, never patched after — mention-only on a bridged
      // channel, the manifest default on a dm (§3.4). This is the write A3.6b
      // proves durable even when a later step throws.
      const responseMode: ResponseMode | undefined =
        room.kind === 'channel' ? 'mention-only' : undefined;
      const added = this.roster.add(room, { agentPath: request.agentPath, responseMode });
      eventFanOut.broadcast('room_member_added', { roomId: room.id, authorId: added.authorId });
    }

    // Re-point the row to the binding that now owns it — for the swap always,
    // and for a same-agent reuse only when the binding id actually changed. Runs
    // AFTER the add so a failure here cannot un-seed the mode above.
    if (bridge.bindingId !== request.bindingId) {
      this.bridges.rebindBridge(bridge.roomId, request.bindingId);
    }

    if (!sameAgent) {
      const oldName = currentAgentMember?.author.displayName ?? 'the previous agent';
      this.postNotice(room.id, buildBridgeAgentSwappedNotice(oldName, newAgent.displayName));
    }

    const fresh = this.requireRoom(room.id);
    return { ...this.withRoster(fresh, operator.id), created: false };
  }

  /**
   * Bind a session adopted at bridge time into the `(room, agent)` ledger
   * (chats-as-channels spec §7.3, step 3).
   *
   * **First-write-wins, so it MUST run before the room's first turn.** The
   * dispatcher mints a fresh id for a `(room, agent)` pair that has never
   * answered ({@link RoomStore.bindRoomSession} via `room-trigger.ts`); writing
   * the adopted id here first means that mint is a no-op and the first turn
   * resumes the adopted conversation instead of starting the agent over. That
   * ordering is the whole mechanism A7.1 asserts on — the transcript the turn
   * receives, not this row.
   *
   * The room log is deliberately NOT touched: the earlier messages stay in the
   * adopted session's own runtime-owned transcript and are never copied here
   * (§7.3, ADR-0310). The pointer notice ({@link buildBridgeHistoryNotice}) is
   * the only thing the log gains, and the adopter posts it.
   *
   * @param roomId - The bridged room.
   * @param agentAuthorId - The bound agent's author id in this room.
   * @param sessionId - The session the bridge adopted, already transcript-probed.
   */
  bindAdoptedSession(roomId: string, agentAuthorId: string, sessionId: string): void {
    this.store.bindRoomSession(roomId, agentAuthorId, sessionId, new Date().toISOString());
  }

  /**
   * Post the one-line history notice a bridge writes at creation
   * (chats-as-channels spec §7.3): where the conversation's earlier messages
   * live, and that this channel's own record starts now.
   *
   * @param roomId - The freshly bridged room.
   * @param priorSession - `true` when an existing session was adopted (the
   *   pointer variant), `false` when the bridge started fresh (pointer-less).
   */
  postBridgeHistoryNotice(roomId: string, priorSession: boolean): void {
    this.postNotice(roomId, buildBridgeHistoryNotice(priorSession));
  }

  /**
   * Un-archive a bridged room, giving a CHANNEL a freshly-resolved unique slug
   * so re-bridging never throws `SLUG_TAKEN` (spec §3.4, A3.4).
   *
   * A channel's slug is released when it archives, and a live channel may have
   * taken it while this one was away. {@link RoomService.updateRoom}'s un-archive
   * path refuses that collision with `SLUG_TAKEN` — correct for a room a person
   * named and can rename, wrong for a bridged channel whose title is
   * platform-sourced and whose re-bridge would then wedge on a name nobody typed
   * (and, because `rebridge` runs the room half first, wedge the binding flip
   * with it). So this mirrors the create path: {@link RoomService.uniqueChannelSlug}
   * appends `-2`, `-3`, … until free — the same auto-suffix `createBridgedRoom`
   * uses — rather than throwing. The slug is resolved while the room is still
   * archived, so `findLiveChannelBySlug` cannot match the room against itself. A
   * `dm` has no slug and keeps `null`.
   *
   * Bypasses {@link RoomService.updateRoom} rather than reusing it: that method
   * derives its slug from a `title` patch (there is none here) and re-runs the
   * very `SLUG_TAKEN` guard this path exists to sidestep. The operator check it
   * would apply is already satisfied — `rebridge` validated the owner before
   * reaching here.
   *
   * @param room - The archived bridged room, snapshotted before this write.
   * @returns The un-archived room.
   */
  private unarchiveBridgedRoom(room: Room): Room {
    // A `dm` keeps its `null` slug untouched — `slug` is omitted rather than
    // passed as `null`, which `RoomStore.updateRoom` does not accept.
    const patch: { archived: false; slug?: string } =
      room.kind === 'channel'
        ? { archived: false, slug: this.uniqueChannelSlug(slugify(room.title) ?? 'chat') }
        : { archived: false };
    const updated = this.store.updateRoom(room.id, patch);
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return updated;
  }

  /**
   * The title a bridged room falls back to when its platform-sourced title
   * sanitizes to nothing — an empty or symbol-only chat title is not
   * impossible (spec §9.2).
   *
   * @param kind - The room kind, for wording.
   */
  private fallbackBridgeTitle(kind: RoomKind): string {
    return kind === 'dm' ? 'Bridged chat' : 'Bridged channel';
  }

  /**
   * A free channel slug, appending `-2`, `-3`, … until one is (spec §3.4,
   * A3.4). Never throws `SLUG_TAKEN` — this is the path for names DorkOS mints
   * rather than names a person typed, and there is nobody behind a platform
   * title or a boot hook who could rename anything to resolve a collision.
   *
   * **`includeArchived` decides which question is being asked**, and both
   * callers are right about their own. A bridged room asks "may I take this
   * name?", so it steps over LIVE channels only: an archived channel has
   * released its slug and holding it in reserve forever would make every
   * bridged `#standup` a `#standup-2`. A system room asks the stronger
   * question, "is this name somebody's to come back to?", because it opens once
   * and keeps its name for the life of the install — taking an archived
   * channel's slug would leave that channel unable to un-archive at all, its
   * only way back being the name that had been quietly given away.
   *
   * @param base - The slugified title to start from.
   * @param opts.includeArchived - Step over archived channels too. Defaults to
   *   false, which is "a live channel is the only thing in my way".
   */
  private uniqueChannelSlug(base: string, opts: { includeArchived?: boolean } = {}): string {
    const taken = opts.includeArchived
      ? (slug: string) => this.store.anyChannelHoldsSlug(slug)
      : (slug: string) => this.store.findLiveChannelBySlug(slug) !== null;
    let candidate = base;
    for (let suffix = 2; taken(candidate); suffix += 1) {
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  /**
   * The rooms this viewer may list, each with their unread count.
   *
   * Two different answers, on purpose:
   *
   * - **The owner sees every room.** This is their machine; hiding rooms from
   *   the person running it would be absurd. "Membership-scoped" in
   *   ADR 260726-170125 describes the model, not an authorization rule against
   *   its owner. Owner-identity, not author kind: the same table will hold
   *   other humans once a community is joined (ADR 260727-184933 D6), and none
   *   of them is the operator of this machine.
   * - **Everybody else sees only rooms they belong to.** That boundary is real:
   *   an agent enumerating the operator's DMs with other agents is a leak, and
   *   it costs one join to prevent.
   *
   * `unreadCount` is `null` for a room the viewer is not a member of. Unread is
   * a property of a read cursor, and a non-member has none — reporting the
   * room's whole entry count instead would render every room the operator has
   * not joined as an alarming unread badge.
   *
   * **Which cursor the count is measured against depends on who is asking**
   * (team-room-home spec §D4): a person's is in `read_cursors`, an agent's is
   * the membership column. Both are read in bulk — one query for the
   * memberships, one for the person's cursors — so a sidebar holding fifty rooms
   * still costs two.
   *
   * `viewerHasPosted` says whether this viewer has ever written in the room
   * themselves — one query for the whole list ({@link RoomStore.roomsPostedInBy}),
   * and the fact that tells a room somebody has merely joined from one they have
   * taken part in.
   *
   * `participants` is carried for direct messages and is `null` for everything
   * else, per {@link RoomSummary}. A DM's mark is whoever it is with, so the
   * sidebar cannot draw one without the roster; resolving it here is two
   * queries for the whole list, where asking per room was one request each.
   *
   * **`bridge` is resolved here too, and it is one more query for the whole
   * list** ({@link BridgeStore.findBridgesByRooms}). It used to be left absent,
   * on the grounds that a list draws no bridge badge — but the sidebar now has
   * to tell a direct message somebody made by hand from one a bridged private
   * chat projects, and only this field says which (`sidebar-simplification` D2).
   * So `null` on a listed room now means "not bridged" rather than "not carried",
   * which is the honest answer and the one every other reader already assumed.
   *
   * @param viewerAuthorId - Whose rooms to list, and whose unread counts to compute.
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms.
   */
  listRooms(
    viewerAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): RoomSummary[] {
    const cursors = this.cursorsFor(viewerAuthorId);
    const visible = this.seesEveryRoom(viewerAuthorId)
      ? this.store.listRooms(filter)
      : this.store.listRoomsForMember(viewerAuthorId, filter);
    // Only the DMs are asked about, so a room of any other kind is simply
    // absent from the map and reads as `null` below — "not carried" rather
    // than "empty", which is the distinction the schema promises.
    const participants = this.roster.authorsIn(
      visible.filter((room) => room.kind === 'dm').map((room) => room.id)
    );
    // One query for the whole list, asked once here rather than per room — see
    // `RoomStore.roomsPostedInBy`. A room absent from the set is one this viewer
    // has never written in, which is a real `false` and not a missing answer:
    // the log is right here and it has been read.
    const postedIn = this.store.roomsPostedInBy(viewerAuthorId);
    const bridges = this.bridges.findBridgesByRooms(visible.map((room) => room.id));
    return visible.map((room) => {
      const cursor = cursors.get(room.id);
      return {
        ...room,
        unreadCount: cursor === undefined ? null : this.store.countUnread(room.id, cursor),
        participants: participants.get(room.id) ?? null,
        bridge: bridgeInfo(bridges.get(room.id)),
        viewerHasPosted: postedIn.has(room.id),
        // Always a number, `0` included. A dot that only appears once the next
        // republish tick lands would leave a freshly loaded cockpit blind for up
        // to ten seconds about work already running — and an ABSENT count would
        // be indistinguishable from "this server does not know", which is the
        // one thing it is never true of: the claim map is right here.
        working: this.triggers.workingCount(room.id),
      };
    });
  }

  /**
   * Every room this member belongs to, with the cursor that answers for them —
   * the bulk form of {@link RoomService.readCursorFor}.
   *
   * A room the member belongs to is always a key, cursor or no cursor, because
   * the caller distinguishes "not a member" (no unread count exists) from "has
   * read nothing" (everything is unread) and only membership can say which.
   *
   * @param authorId - The member.
   * @returns Room id to cursor, for every room they are in.
   */
  private cursorsFor(authorId: string): Map<string, number> {
    const memberships = this.store.listMembershipsFor(authorId);
    if (this.authors.getById(authorId)?.kind !== 'human') {
      return new Map(memberships.map((m) => [m.roomId, m.lastReadSeq]));
    }
    const read = this.readCursors.listForUser(authorId, 'room');
    return new Map(memberships.map((m) => [m.roomId, read.get(m.roomId) ?? 0]));
  }

  /**
   * Every thread this reader takes part in, across every room, newest first.
   *
   * The sidebar's Threads section (spec `room-messaging-design` §3), and the
   * one place a thread is reachable without first knowing which room it is in.
   *
   * **Participation is what selects a thread**: the reader wrote the root, or
   * wrote a reply. There is no follow list — that was weighed as real server
   * lift and deferred until threads get noisy enough to need the escape valve —
   * so nothing here is stored and nothing has to be kept in step.
   *
   * **The visibility boundary is the ROOM's roster, as it stands now.** A thread
   * is a relation between entries in one room's log (ADR 260728-022013), so
   * there is no second boundary to invent: the store joins on membership exactly
   * as `listRooms` does. Participation implies membership at WRITE time and
   * cannot be trusted at READ time — somebody removed from a room would
   * otherwise keep a live view of a conversation they were taken out of, on
   * rows that `getRoom` refuses to open. The owner's see-every-room privilege
   * buys nothing extra here: a thread you never spoke in is not yours to see in
   * this list.
   *
   * **Unread is measured against the cursor that answers for this reader** — a
   * person's own, an agent's membership column — which is why the store is told
   * which one to join (team-room-home spec §D4). A thread's count is the room's
   * cursor narrowed to the thread, so it is the same number the room badge is
   * measured from and it clears when the room does.
   *
   * @param viewerAuthorId - Whose threads to list.
   * @param limit - Most threads to return.
   */
  listThreads(viewerAuthorId: string, limit: number): ThreadSummary[] {
    // Anyone this install cannot name is measured against the membership
    // column: it is the one cursor that certainly exists for a member, and a
    // caller with no author row has no rows to list anyway.
    const cursor = this.authors.getById(viewerAuthorId)?.kind === 'human' ? 'user' : 'membership';
    return this.store.listThreadsForMember(viewerAuthorId, limit, cursor).map((row) => ({
      roomId: row.roomId,
      roomKind: row.roomKind as RoomKind,
      roomSlug: row.roomSlug,
      roomTitle: row.roomTitle,
      rootEntryId: row.rootEntryId,
      rootAuthorId: row.rootAuthorId,
      // Truncated here rather than in the row: a root can be as long as anyone
      // cared to type, and a sidebar draws one line of it. Cut without an
      // ellipsis — the row clamps its own text, and a server-side "…" inside a
      // box that also clamps gives you two of them.
      rootPreview: parseEntryBody(row.rootBody).text.slice(0, THREAD_PREVIEW_MAX_CHARS),
      replyCount: row.replyCount,
      unreadCount: row.unreadCount,
      lastActivityAt: row.lastActivityAt,
    }));
  }

  /**
   * One room with its roster, as this viewer may see it.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller. The owner sees any room; everybody else
   *   only the ones they belong to.
   * @returns The room, or `null` when it does not exist or the viewer may not see it.
   */
  getRoom(roomId: string, viewerAuthorId: string): RoomWithRoster | null {
    const room = this.store.getRoom(roomId);
    if (!room || !this.canSee(roomId, viewerAuthorId)) return null;
    return this.withRoster(room, viewerAuthorId);
  }

  /**
   * Which session each of this room's agents answers in.
   *
   * **Ids only, and that is the whole of it** — no session content, no working
   * directory, no status. It exists so the room's live lane can offer "Open its
   * session", which is a link; anything more would be a second way to read a
   * session, reached through a room and reviewed as neither.
   *
   * The room is resolved through {@link RoomService.requireVisibleRoom}, so a
   * room the caller cannot see throws `ROOM_NOT_FOUND` exactly as reading it
   * does. **Whether the caller may ask at all is the ROUTE's question**, not
   * this method's: `specs/room-presence` §15 deferred the mapping until there
   * was an authorization design for it, and the design is "people only", which
   * is a statement about HTTP callers rather than about room state.
   *
   * @param roomId - The room to list bindings for.
   * @param viewerAuthorId - The caller, for the visibility check.
   * @returns One binding per agent that has answered here, room-scoped.
   */
  listRoomSessions(roomId: string, viewerAuthorId: string): RoomSessionBinding[] {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    return this.store.sessionLedger
      .list()
      .filter((binding) => binding.roomId === roomId)
      .map(({ authorId, sessionId }) => ({ authorId, sessionId }));
  }

  /**
   * Patch a room's title, topic, archived flag, or — on a bridged room — its
   * `deliverNotices` override.
   *
   * **Renaming a channel moves its `#slug` with the title.** A channel's name
   * IS its slug — it is what the sidebar draws, what a person types, and the
   * only room name the server enforces as unique (§13.1) — so a rename that
   * changed only `title` would land in the database and change nothing anybody
   * could see. The new slug is derived by the same {@link slugify} creation
   * uses, though not by the same route: creating a channel may name its slug
   * outright, and renaming one never can.
   *
   * **A rename is applied before an un-archive is judged**, so a room can come
   * back under a new name. That ordering is the difference between a channel
   * whose old name was taken while it was away being recoverable and being
   * stranded for good, because a slug is only reserved while its channel is
   * live and nothing else in the product un-archives a room.
   *
   * **`deliverNotices` lives on `room_bridges`, not `rooms`** (chats-as-channels
   * spec §6.2, D-6 Q5) — a different table from every other field this method
   * patches — so it is validated and written separately from
   * {@link RoomStore.updateRoom}'s own columns. Checked FIRST, before any write:
   * a room with no bridge has no such setting to change, and refusing early
   * means a caller who sent `{ title, deliverNotices }` for an unbridged room
   * never sees a half-applied rename.
   *
   * **A system room refuses a rename or an archive from anyone but the owner**
   * (team-room-home spec D3.1). See {@link RoomService.requireSystemRoomWritable}
   * for why that is a field check here rather than the blanket `requireOperator`
   * DOR-608 forbids. The topic is deliberately NOT covered: describing what a
   * room is for is ordinary participation, and #team is a room agents live in.
   *
   * **The four turn-limit overrides are OPERATOR-only, in every room**
   * (DOR-1429) — the same gate the roster writes take, and for the same reason
   * they were corrected off `kind === 'human'`. These fields are spend
   * authority: `turnLimitsEnabled: false` removes this room's cascade guard and
   * its hourly ceiling in one write, and everything that happens next is billed
   * to the person who owns the install. A person-kind check would have been
   * enough while an install minted exactly one human author, and wrong the
   * moment a second one exists — an invited member, or a cached remote member
   * from a community (ADR 260727-184933 D6) — because either could then uncap a
   * room on somebody else's account. The install-wide twins of these fields are
   * already `operator-only` in `config-write-policy.ts`; this is the same
   * decision at the room's grain, and it is why no room capability tool exposes
   * them at all.
   *
   * Checked AFTER visibility and BEFORE any write, so a caller probing a room it
   * is not in learns 404 exactly as it would from reading it, and only somebody
   * who can genuinely see the room learns 403 `OPERATOR_ONLY`.
   *
   * **Only the limit fields tighten.** Title, topic and archive keep the gate
   * they had — `updateRoom` still has no blanket operator check, because adding
   * one breaks `createRoom`'s DM un-archive path (see
   * {@link RoomService.requireSystemRoomWritable}), and this refusal cannot
   * reach that path: it fires only on fields that call never sends.
   *
   * **An omitted override and an explicit `null` are different instructions.**
   * Absent leaves the stored value alone; `null` clears the override, putting
   * the room back to following Settings. Zod strips absent optional keys, so
   * the distinction survives all the way to `RoomStore.updateRoom`'s `set`.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param patch - The validated update request.
   * @returns The updated room with its roster.
   */
  updateRoom(roomId: string, viewerAuthorId: string, patch: UpdateRoomRequest): RoomWithRoster {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    const { deliverNotices, ...roomPatch } = patch;
    if (ROOM_TURN_LIMIT_FIELDS.some((field) => Object.hasOwn(roomPatch, field))) {
      this.requireOperator(viewerAuthorId, 'how much a room may spend on automatic replies');
    }
    this.requireSystemRoomWritable(room, viewerAuthorId, roomPatch);
    if (deliverNotices !== undefined && !this.bridges.findBridgeByRoom(roomId)) {
      throw new RoomError('NOT_A_BRIDGED_ROOM', 'This room is not bridged to an external chat');
    }
    // Resolved FIRST, because the slug this room is about to have is the one an
    // un-archive has to be judged against — not the one it is leaving behind.
    const slugPatch = this.renamedSlug(room, roomPatch.title);
    const nextSlug = slugPatch.slug ?? room.slug;
    // Un-archiving reclaims a slug the partial unique index released when the
    // room was archived. Somebody may have taken it since — refuse the same way
    // creating it would, rather than letting the raw UNIQUE violation surface
    // as a 500 the caller cannot act on. Renaming in the same patch is the way
    // out: `{ archived: false, title: 'Backend two' }` reclaims a free slug.
    if (roomPatch.archived === false && room.archived && room.kind === 'channel' && nextSlug) {
      const holder = this.store.findLiveChannelBySlug(nextSlug);
      if (holder && holder.id !== room.id) {
        throw new RoomError('SLUG_TAKEN', `A channel called #${nextSlug} already exists`);
      }
    }
    const updated = this.store.updateRoom(roomId, { ...roomPatch, ...slugPatch });
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    // Putting a room away ends what it was waiting for. An archived room takes
    // no new posts, so an answer that arrived later could not be written into it
    // anyway — and the lane must stop saying one is coming. Only on the
    // TRANSITION: re-patching an already-archived room is not a second archiving.
    if (updated.archived && !room.archived) this.triggers.abandonHolds(roomId);
    // Written AFTER the room-table update settles, so a slug conflict throws
    // before this bridge-row write ever runs — the two tables never disagree
    // about whether this call actually went through.
    if (deliverNotices !== undefined) {
      this.bridges.setDeliverNotices(roomId, deliverNotices);
    }
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return this.withRoster(updated, viewerAuthorId);
  }

  // === Membership ===

  /**
   * Add a member by author id, or by agent directory when the agent has never
   * been an author before. **Operator-only.**
   *
   * **A bridged room refuses a second agent** (chats-as-channels spec §3.4,
   * D-6 Q3). Outbound consent to the platform (`canReply` / `canInitiate`) is
   * set per BINDING, and a binding names exactly one agent — a second agent
   * added here would have no consent switch that names its own deliveries,
   * so `checkSender` would correctly deny every one of them. That produces the
   * worst shape of all: a room where one agent answers into the platform chat
   * and the other answers only into the cockpit, with nothing telling either
   * person why. The refusal is visible in two places: a `bridge_second_agent_
   * refused` notice posted into the room BEFORE this throws, and the thrown
   * `BRIDGE_SECOND_AGENT_REFUSED`.
   *
   * **A room the owner is not ON THE ROSTER of refuses a SECOND agent** — the
   * three-way rule (ADR 260814-025326), held here and not only at creation. An
   * agent may open a room with a colleague, and the owner's membership is the
   * price; without this check the price could be paid at creation and taken back
   * one call later, by adding the second agent to a room the owner had already
   * left, or to one an agent opened alone. Membership rather than visibility is
   * the whole of what is being protected — see
   * {@link RoomService.requireSeedingAllowed}, which owns that reasoning.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param input - Who to add, and optionally how they should behave.
   */
  addMember(roomId: string, viewerAuthorId: string, input: AddMemberInput): RoomRosterEntry {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'who is in a room');

    // Resolved once here and again inside `RoomRoster.add` below — harmless:
    // resolving an agent path is idempotent (it mints the author row at most
    // once and returns the same row thereafter), and threading a pre-resolved
    // author through `add` would widen a seam every other caller of
    // `RoomRoster.add` shares, for one caller.
    const candidate = this.roster.resolve(input);
    // Who the title named before this call, when there is a title that follows
    // its roster at all. Read BEFORE the add, because "was this name written by
    // us" can only be asked of the roster the name was written from.
    let priorTitleNames: string[] | null = null;
    if (candidate.kind === 'agent') {
      const roster = this.roster.list(roomId);
      if (room.kind === 'dm') priorTitleNames = dmTitleNames(roster);
      if (this.bridges.findBridgeByRoom(roomId)) {
        const existingAgent = roster.find((member) => member.author.kind === 'agent');
        // Re-adding the room's OWN bound agent is a harmless idempotent no-op
        // one call down (`RoomStore.addMember`'s `onConflictDoNothing`) — the
        // refusal is about a SECOND, DIFFERENT agent, not about this agent
        // already being here.
        if (existingAgent && existingAgent.authorId !== candidate.id) {
          this.postNotice(roomId, buildBridgeSecondAgentRefusedNotice(candidate.displayName));
          throw new RoomError(
            'BRIDGE_SECOND_AGENT_REFUSED',
            'A bridged room can hold only one agent — outbound consent is set per binding'
          );
        }
      }
      // The roster this call is about to produce. The candidate is UNIONED in
      // rather than appended, because re-adding somebody already on the roster
      // is a no-op one call down — counting them twice would refuse a call that
      // changes nothing.
      this.requireOwnerWitnessesAgents(
        [
          ...roster
            .filter((member) => member.authorId !== candidate.id)
            .map((member) => ({ authorId: member.authorId, kind: member.author.kind })),
          { authorId: candidate.id, kind: candidate.kind },
        ],
        'add'
      );
    }

    const member = this.roster.add(room, input);
    eventFanOut.broadcast('room_member_added', { roomId, authorId: member.authorId });
    this.followRosterTitle(room, priorTitleNames);
    return member;
  }

  /**
   * Re-title a group message that has just gained an agent, when its name was
   * one this product wrote rather than one a person typed (DOR-772).
   *
   * A direct message is named after who is in it, and until now that name was
   * written once and never looked at again — so a conversation called "Ana" went
   * on being called "Ana" after Kai joined it, and the sidebar row named one of
   * the two agents in it. Now the name follows the roster.
   *
   * **A name somebody chose is never touched**, which is the whole of
   * {@link isDirectMessageTitleDerived}: the rename happens only while the
   * current title is exactly what this product would have written for the roster
   * as it was a moment ago. Rename a conversation "Launch" and it stays "Launch"
   * however many agents join it.
   *
   * Broadcast like any other rename, so open cockpits move the name rather than
   * waiting for a reload.
   *
   * @param room - The room as it was before the add.
   * @param priorTitleNames - The agents the title named a moment ago, or `null`
   *   when this room's title never followed a roster (a channel, or a join that
   *   added a person).
   */
  private followRosterTitle(room: Room, priorTitleNames: readonly string[] | null): void {
    if (priorTitleNames === null) return;
    if (!isDirectMessageTitleDerived(room.title, priorTitleNames)) return;
    const title = directMessageTitle(dmTitleNames(this.roster.list(room.id)));
    if (title === '' || title === room.title) return;
    const updated = this.store.updateRoom(room.id, { title });
    if (!updated) return;
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
  }

  /**
   * Change one membership's per-room response mode. **Operator-only** — this is
   * the setting that decides when an agent answers without being addressed, so
   * an agent able to turn it up on a room-mate could manufacture a conversation.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param authorId - The member being changed.
   * @param responseMode - The new override.
   */
  updateMembership(
    roomId: string,
    viewerAuthorId: string,
    authorId: string,
    responseMode: ResponseMode
  ): RoomRosterEntry {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'how an agent answers in a room');
    return this.roster.setResponseMode(roomId, authorId, responseMode);
  }

  /**
   * Remove a member, dropping its per-room session binding with it.
   * **Operator-only.**
   *
   * **The owner cannot be taken out of a room two agents share** — the
   * three-way rule (ADR 260814-025326). This is the half of the rule that
   * refuses the OWNER, and it has to exist: a guarantee that the person is a
   * MEMBER wherever two agents talk — on the roster, with the read cursor and
   * the unread count that only membership carries — is worth nothing if the way
   * to break it is to leave afterwards. Taking an AGENT out is never refused, so
   * the room is never wedged — one agent out, and the person may go.
   *
   * **Nor out of a SYSTEM room at all** — {@link RoomService.requireSystemRoomKeepsOwner},
   * checked first because it is the narrower, unconditional refusal: the
   * three-way rule above would happily let the owner leave #team, which ships
   * seated with exactly one agent (DorkBot's fallback seat), and nothing
   * restores the membership afterwards (`ensureSystemChannel` returns an
   * existing row untouched).
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param authorId - The member being removed.
   */
  removeMember(roomId: string, viewerAuthorId: string, authorId: string): void {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'who is in a room');
    this.requireSystemRoomKeepsOwner(room, authorId);
    if (this.isOwnerAuthor(authorId)) {
      this.requireOwnerWitnessesAgents(
        this.roster
          .list(roomId)
          .filter((member) => member.authorId !== authorId)
          .map((member) => ({ authorId: member.authorId, kind: member.author.kind })),
        'remove'
      );
    }
    this.roster.remove(roomId, authorId);
    // Whatever this room was still waiting for from this agent is over: it is
    // not here to answer it. Dropped rather than left to age out, because the
    // wait can now last up to `rooms.lateReplyCeilingMinutes` and the live lane
    // would go on promising an answer for all of it. No notice — see
    // `RoomTriggerDispatcher.abandonHolds` for why the removal is its own
    // durable, visible sibling.
    this.triggers.abandonHolds(roomId, authorId);
    eventFanOut.broadcast('room_member_removed', { roomId, authorId });
  }

  /**
   * Advance a member's read cursor. Monotonic — a lower value is ignored.
   *
   * **Two cursors live behind this one method, and which one moves is decided by
   * WHO is reading** (team-room-home spec §D4). A person's place in a room is a
   * row in `read_cursors`, the same store their agent sessions and their inbox
   * use, so one person reading on two devices is one fact. An agent's is
   * `room_members.last_read_seq` — what the ambient participation loop has SHOWN
   * it (room-participation spec §8.3) — and it stays exactly where it was. They
   * are different questions about the same-looking number, and nothing here
   * reads one to answer the other.
   *
   * A person's cursor that actually moves is announced as `read_cursor` on the
   * global fan-out, so a second browser or device clears the badge on push
   * instead of on its next poll. The event carries the count the room list would
   * now draw, because a reader holding only the new cursor cannot work it out: a
   * room summary has no seq to measure against, so it could only guess zero —
   * and zero is wrong the moment something arrived after the other device
   * stopped reading.
   *
   * **A write that changes nothing says nothing.** Opening a room already read
   * is the common case, and an event per no-op would put the loudest name on the
   * stream on a fact nobody could act on.
   *
   * **An agent's cursor is announced not at all.** RP3 advances it once per
   * agent per turn through {@link RoomStore.setReadCursor} directly, which would
   * make it the most frequent event on the global stream — and nothing in the
   * cockpit draws it. `read_cursor` is the people's stream by contract, which is
   * also why `PUT /api/read-cursors/:kind/:id` refuses an agent outright.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq they have read up to.
   * @returns The membership, reporting the cursor that answers for this
   *   member — see {@link RoomRoster.list}.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember {
    this.requireVisibleRoom(roomId, authorId);
    // A membership references its author by foreign key, so a member without an
    // author row cannot happen. Resolved BEFORE the write because it is what
    // decides which cursor is being written, not a decoration on the
    // announcement: with no author row there is nobody to call a person, and the
    // membership column is the safe answer — it is where this cursor lived
    // before the split, and it is what RP3 would read back.
    const author = this.authors.getById(authorId);
    if (!author) {
      logger.warn('[rooms] a read cursor moved for a member with no author row', {
        roomId,
        authorId,
      });
      return this.roster.setReadCursor(roomId, authorId, lastReadSeq);
    }
    if (author.kind !== 'human') return this.roster.setReadCursor(roomId, authorId, lastReadSeq);

    // Membership is what makes a cursor meaningful, and the check is the same
    // one the agent path gets from `RoomRoster.setReadCursor` — stated here
    // because the person's cursor is not stored on the membership row and so
    // cannot be refused by its absence.
    const member = this.store.getMember(roomId, authorId);
    if (!member) throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');

    // The broadcast, the monotonic guard and the "did it move" comparison all
    // live in `ReadCursorService.advance` — one write path for every kind of
    // thread a person reads, so a room cannot drift from a session.
    const cursor = this.readCursors.advance(authorId, 'room', roomId, lastReadSeq, {
      unreadCount: (seq) => this.store.countUnread(roomId, seq),
    });
    // Read-cursor auto-read (spec `notification-system` task T11): reading a
    // room reads its inbox rows too, so an unread bell count and an unread room
    // never disagree. Scoped to the OPERATOR's own cursor — notifications are
    // single-operator by design (`notifications` table's own doc comment), and
    // a second human account's cursor moving is not a fact about what the
    // operator has seen. Never lets a notification-store problem fail a read
    // cursor that already moved.
    if (this.isOwnerAuthor(authorId)) {
      try {
        markRoomNotificationsRead(roomId, cursor.lastReadSeq);
      } catch (err) {
        logger.warn("[rooms] could not mark this room's notifications read", {
          roomId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ...member, lastReadSeq: cursor.lastReadSeq };
  }

  /**
   * Where one member has read up to in one room: a person's own cursor, an
   * agent's membership column.
   *
   * The read half of {@link RoomService.setReadCursor}, and the one place the
   * "which cursor answers for whom" rule is stated for a single member — the
   * list paths resolve it in bulk instead, for the query count.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @returns The cursor, or `null` when this author is not a member.
   */
  readCursorFor(roomId: string, authorId: string): number | null {
    const member = this.store.getMember(roomId, authorId);
    if (!member) return null;
    if (this.authors.getById(authorId)?.kind !== 'human') return member.lastReadSeq;
    return this.readCursors.get(authorId, 'room', roomId)?.lastReadSeq ?? 0;
  }

  // === Entries ===

  /**
   * A page of history, oldest-first.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.before - Return entries with `seq` below this.
   * @param opts.limit - Page size.
   */
  listEntries(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntry[] {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    return this.withRollups(roomId, this.store.listEntries(roomId, opts));
  }

  /**
   * Write a post: resolve its mentions against the roster, allocate its `seq`,
   * stamp its cascade provenance, and publish it to the room's readers.
   *
   * A post with no trigger starts a fresh cascade at depth 0 — which is what
   * makes a human able to re-engage a room the guard has stopped.
   *
   * **`replyTo` is what makes this a thread reply**, and it is the only way to
   * write one (ADR 260728-022013). It names an entry in THIS room; the reply
   * lands in the same log, under the same roster, spending the same budget, and
   * — the point of the change — inside the same `(room_id, cascade_root)`
   * ancestry set, so a cascade that goes through a thread is bounded by the same
   * rule as one that does not.
   *
   * @param roomId - The room.
   * @param input.authorId - Who is posting.
   * @param input.text - What they wrote.
   * @param input.sessionId - The session that produced it, if any.
   * @param input.trigger - Cascade provenance, when a trigger produced this.
   * @param input.replyTo - The entry this answers, when it is a thread reply.
   * @param input.attachmentIds - Files already uploaded into this room, in the
   *   order they should render. Resolved and refused BEFORE anything is
   *   written, then bound inside the entry's own transaction.
   * @param input.moment - The milestone this post marks, for an agent-minted
   *   moment (spec D5.1). Set by {@link RoomService.postMoment} and by nothing
   *   else: no request body carries one, which is what keeps a moment something
   *   this install observed rather than something a caller claimed. Minting one
   *   buys no extra permission — the post is written by the same path, with the
   *   same membership check, cascade stamp and turn budget behind it.
   * @param input.answersEntryId - The message this post answers, set by the
   *   dispatcher on every agent-authored reply. Distinct from `replyTo`, which
   *   picks a THREAD: a channel post has no thread and still answers something,
   *   and a room posts in arrival order whatever a message responds to.
   * @returns The committed entry.
   */
  post(
    roomId: string,
    input: {
      authorId: string;
      text: string;
      sessionId?: string;
      trigger?: PostTrigger;
      replyTo?: string;
      attachmentIds?: readonly string[];
      moment?: RoomMoment;
      answersEntryId?: string;
    }
  ): RoomEntry {
    const room = this.requireVisibleRoom(roomId, input.authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    // Seeing a room is not being in it. The owner can see every room but still
    // has to join one before speaking in it; for everybody else the visibility
    // check above already required membership, so this is a no-op.
    if (!this.store.getMember(roomId, input.authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
    // Resolved before the write, so a refusal leaves the room exactly as it was.
    const attachments = this.resolveAttachments(roomId, input.authorId, input.attachmentIds);
    const attachmentIds = attachments.map((file) => file.id);
    return this.writePost(room, input, undefined, {
      bind: (entryId, tx) => {
        const bound = this.attachments.bind(roomId, attachmentIds, entryId, tx);
        // **Asserted, not assumed.** `bind` re-checks `entry_id IS NULL`, so a
        // file that another post claimed between resolution and here simply
        // does not update — and without this check the entry would commit
        // carrying a reference to a file it does not own, which is the one
        // state the foreign key cannot catch. Throwing rolls the whole
        // transaction back, entry included, which is exactly the outcome:
        // either the message and all its files land, or none of it does.
        if (bound !== attachmentIds.length) {
          throw new RoomError(
            'ATTACHMENT_ALREADY_POSTED',
            'That file was attached to another message first'
          );
        }
      },
      attachments,
    });
  }

  /**
   * Post because the agent decided to — `post_to_room` (room-participation spec
   * §10.2), and the only caller is the rooms capability domain.
   *
   * **It is `post` with three things added and nothing removed**, which is the
   * whole design: the tool must not become a second write path. Membership, the
   * archive check, mention resolution, the cascade stamp, the SSE publish and the
   * dispatch all come from {@link RoomService.post} unchanged, so a bound that
   * holds for a person's message holds for this. Two of the three are refusals,
   * so the additions can only ever make this narrower than `post`, never wider.
   *
   * What it adds:
   *
   * - **Channels and threads only** (§2.6). In a DM the reply IS the message: the
   *   agent was unambiguously addressed, answering is obligatory, and the turn's
   *   own text already posts. A second way to say the same thing there would be a
   *   second way for it to fail, and it would buy nothing.
   * - **A turn somebody STOPPED is refused** — `TURN_WAS_STOPPED`, DOR-1313. An
   *   interrupt is delivered rather than obeyed, so a stopped turn may still be
   *   running and reach for this; the room already throws away its narration and
   *   this is the same refusal on the half the turn speaks for itself. It stands
   *   until the room gives that agent another turn there
   *   (`RoomTriggerDispatcher.stoppedHere`, where both its limits are written
   *   down).
   * - **The turn is marked as having spoken**, so the narration that turn writes
   *   back to its session is not ALSO posted (see {@link ActiveClaim.spokeViaTool}).
   *
   * What it deliberately does not add is a fresh cascade. Provenance follows the
   * turn: a post made mid-turn inherits that turn's stamp through `activeTurnFor`,
   * and a post made with nothing in flight is stamped at the ceiling under its own
   * root — silent, triggering nobody. Speaking on purpose is not a way to reset a
   * bound.
   *
   * @param roomId - The channel to post into.
   * @param input.authorId - The agent posting, resolved from its identity by the
   *   capability — never read off the tool's arguments.
   * @param input.text - What to say.
   * @param input.replyTo - The entry this answers, to land it in that thread.
   * @returns The committed entry.
   */
  postFromTool(
    roomId: string,
    input: { authorId: string; text: string; replyTo?: string }
  ): RoomEntry {
    const room = this.requireVisibleRoom(roomId, input.authorId);
    // `!== 'channel'`, never `=== 'dm'`: `rooms.kind` is a text column narrowed by
    // an unchecked cast, so an unrecognized kind takes the narrower branch
    // (`.claude/rules/room-conduct.md`).
    if (room.kind !== 'channel') {
      throw new RoomError(
        'TOOL_POST_NOT_IN_DM',
        'This is a direct message — your reply is posted for you, so there is nothing to post here.'
      );
    }
    // **A stopped turn says nothing here either** (DOR-1313). The room already
    // throws away the narration of a turn somebody stopped; this is the same
    // refusal on the other half of that turn's voice, and it is the half that
    // measurably got through — an interrupt that reached a process still
    // spawning left the turn running, and it posted its whole answer by hand
    // twenty-three seconds after the room said everything had been stopped.
    // Refused rather than silently dropped: the agent is the one holding the
    // pen, and telling it beats letting it believe it spoke.
    if (this.triggers.stoppedIn(roomId, input.authorId)) {
      logger.info('[rooms] refused a stopped turn a post of its own', {
        roomId,
        authorId: input.authorId,
      });
      throw new RoomError(
        'TURN_WAS_STOPPED',
        'This conversation was stopped, so nothing more from this turn is posted. Wait for the next message before answering here.'
      );
    }
    const entry = this.post(roomId, input);
    this.triggers.noteDeliberatePost(roomId, input.authorId);
    return entry;
  }

  /**
   * A page of one room's history for a member, newest first — `read_room_history`
   * (room-participation spec §10.3).
   *
   * **One predicate over one table**, because a thread is an entry-level relation:
   * `room_id`, the caller's join point, and optionally one `thread_root_entry_id`.
   *
   * Three scope rules, and they are the same three the room's own read paths
   * already keep:
   *
   * - **Members only.** {@link RoomService.requireVisibleRoom} plus an explicit
   *   membership check, so seeing a room is still not being in it.
   * - **A room id is not a capability.** "Not a member" and "no such room" are the
   *   same `ROOM_NOT_FOUND`, so a probe learns nothing.
   * - **Never below `joinedSeq`.** A member does not retroactively read what was
   *   said before they arrived (spec §8.3). Strictly above, matching the ambient
   *   window's own floor.
   *
   * `limit` is CLAMPED rather than refused: an agent that asks for a thousand gets
   * {@link HISTORY_PAGE_MAX}, because refusing a number is a worse answer than
   * giving the most that is sensible.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.limit - How many entries to return, clamped to
   *   {@link HISTORY_PAGE_MAX}.
   * @param opts.before - Return entries with `seq` strictly below this, for paging
   *   backwards.
   * @param opts.threadRootEntryId - Narrow to one thread's replies.
   * @returns The page, newest first.
   */
  readHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { limit: number; before?: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    const { floor } = this.requireHistoryFloor(roomId, viewerAuthorId);
    const page = this.store.listEntries(roomId, {
      afterSeq: floor,
      limit: clampHistoryLimit(opts.limit),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.threadRootEntryId !== undefined
        ? { threadRootEntryId: opts.threadRootEntryId }
        : {}),
    });
    // The store answers oldest-first within the page; the tool's contract is
    // newest-first, which is the order an agent reading back wants.
    return this.withRollups(roomId, page).reverse();
  }

  /**
   * The messages in one room that match some words, best first —
   * `search_room_history` (room-participation spec §10.3, as amended by DOR-672).
   *
   * **A caller of the message index, never a scan of its own.** There is exactly
   * one search path over these rows; a second one written here would answer the
   * same question differently — stems against substrings — and the difference
   * would be invisible until somebody compared them.
   *
   * The three scope rules are the read tool's, reused verbatim, and the index
   * gains no authority the tool did not already have: membership is resolved
   * first, the join floor rides into the query, and the coordinates that come back
   * are resolved through this room's OWN read path — so a hit the index somehow
   * held for a room this caller may not see could not be turned into a message
   * anyway.
   *
   * **A thread filter narrows what the index already ranked.** The index knows
   * nothing about threads (a projected message carries a container and an ordinal
   * and no relation), so the filter is applied to the resolved entries, over the
   * top {@link HISTORY_PAGE_MAX} matches in the room. Searching a busy channel for
   * a common word and narrowing to one thread can therefore come back thin; the
   * tool says so, and the fix if it ever matters is a column in the projection,
   * not a second scan here.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.query - The words to look for. Matched by STEM, not substring.
   * @param opts.limit - The most matches to return, clamped to
   *   {@link HISTORY_PAGE_MAX}.
   * @param opts.threadRootEntryId - Keep only matches inside this thread.
   * @returns The matching entries, best first.
   */
  searchHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { query: string; limit: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    const { floor } = this.requireHistoryFloor(roomId, viewerAuthorId);
    const wanted = clampHistoryLimit(opts.limit);
    const hits = this.findMessages({
      roomIds: [roomId],
      query: opts.query,
      // Over-fetch only when something will be filtered out afterwards, so the
      // ordinary search costs exactly what it asked for.
      limit: opts.threadRootEntryId === undefined ? wanted : HISTORY_PAGE_MAX,
      afterSeq: floor,
    });
    if (hits.length === 0) return [];

    const ranked = new Map(hits.map((hit, rank) => [hit.seq, rank]));
    const found = this.store
      .listEntriesBySeq(roomId, [...ranked.keys()])
      .filter(
        (entry) =>
          opts.threadRootEntryId === undefined || entry.threadRootEntryId === opts.threadRootEntryId
      )
      // The index ranked these by relevance and the store returned them by
      // position; relevance is the order the caller asked for.
      .sort((a, b) => (ranked.get(a.seq) ?? 0) - (ranked.get(b.seq) ?? 0))
      .slice(0, wanted);
    return this.withRollups(roomId, found);
  }

  /**
   * The floor a member may read from in a room, refusing anyone who may not read
   * it at all.
   *
   * Shared by both history tools so the three scope rules are enforced once. A
   * member row is required even for the owner, who can SEE every room on the
   * install: reading a room's log is a membership, not a visibility.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller.
   * @returns The room, and the exclusive `seq` floor — entries strictly above it
   *   are readable. The room rides along because the one caller that needs it
   *   ({@link RoomService.exportRoom}) would otherwise read it a second time to
   *   get what this method already had in its hand.
   */
  private requireHistoryFloor(
    roomId: string,
    viewerAuthorId: string
  ): { room: Room; floor: number } {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    const member = this.store.getMember(roomId, viewerAuthorId);
    // The same `ROOM_NOT_FOUND` a missing room gets, deliberately: a room id is
    // not a capability, and a distinct code here would let a caller holding an id
    // tell "exists, not yours" from "does not exist".
    if (!member) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return { room, floor: member.joinedSeq };
  }

  /**
   * A room's whole history as JSONL — `GET /api/rooms/:id/export` (DOR-1225).
   *
   * Rooms live only in SQLite, and this is the projection that pays back what
   * that costs them: a file you can grep, copy, and keep. **It is a copy and
   * never a sync target** — nothing reads one back in, and this method touches
   * no writer, so the database stays the truth.
   *
   * **A generator, because a room's log is never trimmed.** The lines come out
   * one at a time and the route writes each as it arrives, so a ten-year channel
   * is never assembled in memory before the download can start. That is also why
   * the header cannot state a count and why the last line is a `summary`: a
   * truncated download is otherwise a perfectly valid file of the messages that
   * made it, with nothing inside it saying so.
   *
   * **Membership is the gate**, exactly as it is for `read_room_history`: the
   * same {@link RoomService.requireHistoryFloor} both history tools use, so
   * seeing a room is still not being in it and "not a member" answers exactly as
   * "no such room".
   *
   * **The join floor is NOT applied to the operator exporting their own room**,
   * and that is the one deliberate difference from those tools. The floor exists
   * so a member does not retroactively read what was said before they arrived —
   * a rule about one participant's view of a shared conversation. An export is
   * not a view: it is the exit path (the community exit promise, DOR-596 C2),
   * and an owner handed a copy of their own room with the first months missing
   * has not been given their data. Everybody else — every agent, and any second
   * person — exports strictly above their own `joinedSeq`, and the file says
   * which of the two it is in `scope.joinFloorApplied` rather than leaving a
   * reader to guess from where the seqs start.
   *
   * **What this method owns is the two questions only the service can answer** —
   * who may export, and how much of the room they get. The file's shape, its
   * paging and its receipt live in `room-export.ts`, which is handed the answers
   * and never reaches back for a store.
   *
   * @param roomId - The room to copy.
   * @param viewerAuthorId - Who is asking; must be on the roster.
   * @yields The header, then every entry in ascending `seq`, then the summary.
   */
  *exportRoom(roomId: string, viewerAuthorId: string): Generator<RoomExportLine> {
    const { room, floor } = this.requireHistoryFloor(roomId, viewerAuthorId);
    const wholeRoom = this.isOwnerAuthor(viewerAuthorId);
    const resolve = createExportAuthorResolver((authorId) => this.authors.getById(authorId));

    yield* buildRoomExport({
      room,
      members: this.roster.list(roomId),
      exportedBy: resolve(viewerAuthorId),
      exportedAt: new Date().toISOString(),
      dorkosVersion: SERVER_VERSION,
      scope: { fromSeq: wholeRoom ? 0 : floor, joinFloorApplied: !wholeRoom },
      resolve,
      page: (afterSeq, limit) =>
        this.withRollups(roomId, this.store.listEntriesForExport(roomId, { afterSeq, limit })),
    });
  }

  /**
   * Refuse anyone who may not attach a file to this room, before a single byte
   * is read.
   *
   * The same two gates `post` applies, in the same order and with the same
   * answers, because an upload is the first half of a message: a caller who
   * cannot see the room gets the `ROOM_NOT_FOUND` every other room read gives —
   * never a 403, which would confirm the room exists — and an archived room
   * refuses `ROOM_ARCHIVED`. Exposed rather than duplicated in the route so the
   * upload route cannot become the one place that leaks existence.
   *
   * @param roomId - The room the file is being uploaded into.
   * @param authorId - Who is uploading.
   */
  assertCanAttach(roomId: string, authorId: string): void {
    const room = this.requireVisibleRoom(roomId, authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (!this.store.getMember(roomId, authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
  }

  /**
   * Whether this caller may READ one stored attachment.
   *
   * Two rules, and the split is the whole access model:
   *
   * - A **bound** attachment is readable by anyone who may read the entry that
   *   carries it, which is anyone who may see the room. Any other rule would
   *   let a person read a message and not the file it is about.
   * - An **unbound** attachment is readable only by whoever uploaded it, so the
   *   composer can draw its own chip and nobody can enumerate a stranger's
   *   staging area.
   *
   * @param roomId - The room.
   * @param authorId - The caller.
   * @param attachment - The row, as the route read it.
   * @returns `true` when the bytes may be served.
   */
  canReadAttachment(
    roomId: string,
    authorId: string,
    attachment: { entryId: string | null; authorId: string }
  ): boolean {
    if (attachment.entryId === null) return attachment.authorId === authorId;
    return this.canSee(roomId, authorId);
  }

  /**
   * Settle which files a post may carry, refusing before anything is written.
   *
   * Every refusal here is about the CALLER's relationship to the ids, which is
   * why it happens in the service and not in the row store: an id from another
   * room, an id somebody else uploaded, and an id already spoken for are three
   * different mistakes and get three different answers. Two of them collapse to
   * `ATTACHMENT_NOT_FOUND` on purpose — a 403 for "that is someone else's file"
   * would confirm the file exists.
   *
   * @param roomId - The room the post is being written in.
   * @param authorId - Who is posting. Only their own unbound files may be named.
   * @param attachmentIds - The ids the post named, in render order.
   * @returns The resolved attachments, in the order they were named.
   */
  private resolveAttachments(
    roomId: string,
    authorId: string,
    attachmentIds: readonly string[] | undefined
  ): RoomAttachment[] {
    if (!attachmentIds || attachmentIds.length === 0) return [];

    // The CONFIGURED limit, read now — not `ROOM_ATTACHMENT_MAX_PER_ENTRY`,
    // which is only the ceiling that limit may be set to.
    const limit = this.maxAttachmentsPerEntry();
    if (attachmentIds.length > limit) {
      throw new RoomError(
        'TOO_MANY_ATTACHMENTS',
        `A message can carry at most ${limit} ${limit === 1 ? 'file' : 'files'}`
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new RoomError('TOO_MANY_ATTACHMENTS', 'The same file was attached twice');
    }

    const unbound = new Map(
      this.attachments.listUnboundFor(roomId, attachmentIds).map((row) => [row.id, row] as const)
    );
    return attachmentIds.map((id) => {
      const row = unbound.get(id);
      if (!row) {
        // Absent from the unbound set is either "not here" or "already posted",
        // and only the second is worth its own code — a person who attached the
        // same file to two messages can act on that answer.
        const existing = this.attachments.get(roomId, id);
        if (existing?.entryId) {
          throw new RoomError('ATTACHMENT_ALREADY_POSTED', 'That file is already on a message');
        }
        throw new RoomError('ATTACHMENT_NOT_FOUND', 'No such file in this room');
      }
      // Somebody else's staging area is not readable and not postable, and the
      // answer is the same one a missing id gets.
      if (row.authorId !== authorId) {
        throw new RoomError('ATTACHMENT_NOT_FOUND', 'No such file in this room');
      }
      return {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        preview: row.preview,
        url: row.url,
      };
    });
  }

  /**
   * Write a message that arrived from somebody outside this machine, minting
   * their author on their first message and joining them to the roster in the
   * SAME transaction as that message (chats-as-channels spec §4.1–§4.2).
   *
   * The seam the inbound bridge calls. It exists rather than the bridge calling
   * {@link RoomService.post} because three of this path's properties have no
   * expression in that one:
   *
   * - **The author is minted from a platform identity, not supplied.** Nothing
   *   outside this machine may name an author id, and the identity it IS keyed
   *   on is address-free (`external-authors.ts`).
   * - **Membership is lazy.** A bridged group of two hundred projects a roster
   *   row per person who has SPOKEN, never one per person who exists (§4.2).
   *   `post` would refuse the first message of every one of them.
   * - **The join is atomic with the message.** A log holding a post from
   *   somebody its roster says was never in the room is a record that
   *   contradicts itself, and the room log is the audit trail this whole
   *   feature offers in exchange for letting strangers reach a model (§9.4).
   *
   * **Bridged rooms only.** An external author in an ordinary room would be a
   * stranger in the operator's private conversation, so the bridge row is
   * checked here rather than trusted from the caller — the same
   * refuse-before-doing shape the create path takes.
   *
   * They join by the room's own seed, which for a person is
   * `seedResponseMode`'s inert default: nothing ever auto-triggers a human, so
   * the column is a stored enum value rather than a claim about behaviour.
   *
   * @param roomId - The bridged room the chat projects into.
   * @param input.identity - Who wrote it, on which platform, through which bot.
   *   Never `null`: a message with no resolvable platform user id gets no author
   *   at all and is dropped by the caller before it reaches here (§4.1).
   * @param input.text - What they wrote, exactly as they wrote it.
   * @param input.replyTo - The entry this answers, when the platform said so.
   * @param input.mentionAugment - One extra `@`-name for the bound agent, from
   *   the platform's own bot handle (`getMe().username`, §5.4). Threaded to
   *   {@link RoomRoster.addressingCandidates} so `@botusername` resolves to the
   *   agent; `ingest` rewrites nothing, and this never touches the stored text.
   * @param input.recordRef - Runs inside the entry's OWN transaction, handed the
   *   committed entry's id. This is what makes §5.2 step 6 — the inbound
   *   external ref — atomic with the entry write (A5.6: both rows or neither),
   *   since `better-sqlite3` is synchronous and the ref shares this transaction.
   * @returns The committed entry, the author it was written as, and whether
   *   this message is what put them on the roster.
   */
  postExternal(
    roomId: string,
    input: {
      identity: ExternalAuthorIdentity;
      text: string;
      replyTo?: string;
      mentionAugment?: { agentPath: string; names: readonly string[] };
      recordRef?: (entryId: string, tx: DbTransaction) => void;
    }
  ): { entry: RoomEntry; author: AuthorRecord; joined: boolean } {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const bridge = this.bridges.findBridgeByRoom(roomId);
    if (!bridge || bridge.archivedAt !== null) {
      throw new RoomError(
        'NOT_A_BRIDGED_ROOM',
        'Only a room bridged to an external chat can hold a message from outside this machine'
      );
    }

    const author = this.authors.resolveExternal(input.identity);
    const joining = this.store.getMember(roomId, author.id) === null;
    const entry = this.writePost(
      room,
      { authorId: author.id, text: input.text, replyTo: input.replyTo },
      joining
        ? (tx) => void this.store.addMember(this.roster.externalJoin(room, author), tx)
        : undefined,
      { mentionAugment: input.mentionAugment, recordRef: input.recordRef }
    );
    // After the commit, never inside it: a broadcast is not rolled back, and a
    // roster event for a join that failed would leave every open cockpit
    // showing a member the database does not have.
    if (joining) eventFanOut.broadcast('room_member_added', { roomId, authorId: author.id });
    return { entry, author, joined: joining };
  }

  /**
   * Everything a post does once the room and the writer's standing in it have
   * been settled — shared by {@link RoomService.post} and
   * {@link RoomService.postExternal}, which settle those two things very
   * differently and agree on nothing else.
   *
   * @param room - The room, already resolved and known un-archived.
   * @param input - The post itself.
   * @param within - Extra writes to run inside the entry's own transaction,
   *   strictly BEFORE the entry is inserted, so the membership exists for the
   *   whole life of the entry and a crash can never leave a log holding a post
   *   from somebody its roster says was never in the room (chats-as-channels
   *   §4.2). Passed straight through to {@link RoomStore.appendEntry}.
   * @param opts.mentionAugment - Extra `@`-names for the bound agent, threaded to
   *   {@link RoomRoster.addressingCandidates} (chats-as-channels §5.4). Only a
   *   bridged inbound message carries one.
   * @param opts.recordRef - Runs inside the SAME transaction as the entry write,
   *   handed the entry's id once it is known — the inbound external ref (§5.2
   *   step 6), made atomic with the entry it names (A5.6). Composed with
   *   `within` rather than replacing it, so a first message both joins its author
   *   and records its ref in one transaction.
   * @param opts.bind - Runs inside the same transaction too, but on the far side
   *   of the insert — {@link RoomStore.appendEntry}'s `bind` hook, handed the
   *   entry's id. It is separate from `recordRef` rather than folded into it
   *   because the two want opposite orderings: a bridge ref has no foreign key
   *   and may be written first, while binding a `room_attachments` row points a
   *   foreign key AT the entry and fails with `FOREIGN KEY constraint failed`
   *   unless the entry is already there.
   */
  private writePost(
    room: Room,
    input: {
      authorId: string;
      text: string;
      sessionId?: string;
      trigger?: PostTrigger;
      replyTo?: string;
      moment?: RoomMoment;
      answersEntryId?: string;
    },
    within?: (tx: DbTransaction) => void,
    opts?: {
      mentionAugment?: { agentPath: string; names: readonly string[] };
      recordRef?: (entryId: string, tx: DbTransaction) => void;
      bind?: (entryId: string, tx: DbTransaction) => void;
      attachments?: RoomAttachment[];
    }
  ): RoomEntry {
    const roomId = room.id;

    // Provenance follows the TURN, not the call — and where there is no turn,
    // who is writing decides, never the shape of the call. An agent can post
    // here directly (`POST /api/rooms/:id/entries` carries no trigger), both
    // while its turn runs and from a shell with nothing in flight at all;
    // `deriveCascade` refuses a fresh cascade to either. Only a human resets the
    // count, which is what spec §6 says and what the setting's own docs promise.
    const author = this.authors.getById(input.authorId);
    const trigger = input.trigger ?? this.triggers.activeTurnFor(input.authorId);

    // Resolved ONCE, here, and both halves of the answer are kept: who this
    // message reached, and who it named but could not reach because that
    // member's agent is gone. The second half is what stops a released name
    // becoming a silent one (ADR 260801-003051) — the dispatcher writes the
    // room's answer to it below.
    const addressed = resolveAddressing(
      input.text,
      this.roster.addressingCandidates(roomId, opts?.mentionAugment)
    );
    const id = ulid();
    // The ref write shares the entry's transaction, so both land or neither does
    // (§5.2, A5.6). Composed with `within` — a bridged first message both joins
    // its author (`within`) and records its inbound ref (`recordRef`) in the one
    // transaction — and built only when there is something extra to run, so an
    // ordinary post pays nothing.
    const recordRef = opts?.recordRef;
    const transactional =
      within || recordRef
        ? (tx: DbTransaction) => {
            within?.(tx);
            recordRef?.(id, tx);
          }
        : undefined;
    // The far side of the insert, and deliberately not folded into
    // `transactional` above — see `opts.bind`. Built only when there is one, so
    // an ordinary post pays nothing here either.
    const bindAfterInsert = opts?.bind;
    const bindTransactional = bindAfterInsert
      ? (tx: DbTransaction) => bindAfterInsert(id, tx)
      : undefined;
    const entry = this.store.appendEntry(
      {
        roomId,
        id,
        authorId: input.authorId,
        kind: 'post',
        // The milestone rides beside the words, never instead of them: a moment
        // a client cannot read is a blank line in the feed.
        body: {
          text: input.text,
          ...(input.moment && { moment: input.moment }),
          ...(input.answersEntryId !== undefined && { answersEntryId: input.answersEntryId }),
        },
        mentions: addressed.mentions,
        // The per-occurrence positions of those mentions, resolved in the SAME
        // pass and stored beside them so the client draws pills without ever
        // re-parsing the body (`.claude/rules/room-conduct.md`).
        mentionSpans: addressed.spans,
        sessionId: input.sessionId ?? null,
        ...this.threadPointers(roomId, input.replyTo),
        ...deriveCascade(id, {
          trigger,
          // An author row that has vanished is treated as an agent — the
          // conservative read, since the only thing this decides is whether the
          // writer may reset a spend limit.
          authorKind: author?.kind ?? 'agent',
          maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
        }),
        createdAt: new Date().toISOString(),
      },
      transactional,
      bindTransactional
    );

    this.publishEntry(entry, opts?.attachments ?? []);
    // Never on the transaction, never before the entry is durable: a
    // notification is the least important thing this write does, and it must
    // never be able to delay or fail the post that produced it (mirrors the
    // dispatch try/catch immediately below).
    this.notifyRoomMessage(room, entry, author, addressed.mentions);
    // Trigger-only, both ways: the post reaches its readers now, and whoever it
    // addresses answers on their own schedule. Deliberately not awaited — the
    // HTTP 202 must not wait on a model call, and the reply arrives on the same
    // SSE stream as everything else when it comes.
    //
    // **A committed post must never fail because dispatching from it did.** The
    // entry above is written, published and gone; `dispatch` runs its target
    // selection SYNCHRONOUSLY, so anything it throws — a SQLite write under
    // contention, most plausibly — surfaced at the route as a 500 for a message
    // that is sitting in the log. The poster saw their own successful message
    // fail. Losing the replies to it is bad and visible in the room; losing the
    // message is worse and looks like a broken product.
    try {
      this.triggers.dispatch(room, entry, addressed.unreachable);
    } catch (err) {
      logger.error('[rooms] a committed post could not be dispatched from', {
        roomId,
        entryId: entry.id,
        authorId: input.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return entry;
  }

  /**
   * Raise `dm.received` / `mention.received` for one committed entry, when it
   * earned either (spec `notification-system` task T11, DOR-1388).
   *
   * **Never notifies the operator about their own words** — `isOwnerAuthor`
   * alone, and that is the whole check. An earlier revision also treated any
   * HUMAN author in a `dm`-kind room as the operator, reasoning that a
   * bridged private chat is always the operator's own conversation. That is
   * false: a bridged `dm` room is minted from an unclaimed chat somebody ELSE
   * started with the bot (`postExternal`), so its human party can be a real
   * collaborator, not the operator's own phone. Their `@dorian` in that room
   * has to reach the operator like any other mention, which is why this gate
   * is `isOwnerAuthor` and nothing wider.
   *
   * **A bridged echo of DorkOS's own outbound post never reaches this
   * method at all.** `isBotSender` (`adapters/telegram/inbound.ts`) drops any
   * inbound update whose sender is itself a bot account — which the bot's
   * own delivery always is — before `postExternal` ever mints an author or
   * writes an entry, so that suppression is structural and upstream of this
   * seam. What this gate does NOT catch is the operator genuinely texting
   * their own agent from their own phone: that is a real external human
   * author (`platform:` naturalKey, not `isOwnerAuthor`), and if their
   * message happens to spell their own handle it raises one `mention.received`
   * about a message they just sent themselves — accepted as the far cheaper
   * failure next to silently dropping every real collaborator's mention.
   * `dm.received` is unaffected either way: it is gated on `author.kind ===
   * 'agent'` below, so no human author, phone or stranger, can ever raise it.
   *
   * A ghost author (its row vanished, ADR 260801-003051) is skipped outright:
   * there is nobody's name to put in a title.
   *
   * **A DM that also happens to name the operator raises `dm.received` only,
   * never both.** `isDirectMessage` already says the operator was reached;
   * a redundant `mention.received` for the same entry would be a second
   * banner for one message the operator is about to open from the first.
   *
   * Never throws: called after the entry and its broadcast are already
   * durable, so a problem here must not be able to touch either.
   *
   * @param room - The room the entry landed in.
   * @param entry - The committed entry.
   * @param author - Its author, or `undefined` for a ghost.
   * @param mentions - The author ids this entry's resolved `@`-mentions name.
   */
  private notifyRoomMessage(
    room: Room,
    entry: RoomEntry,
    author: AuthorRecord | null,
    mentions: readonly string[]
  ): void {
    try {
      if (!author) return;
      if (this.isOwnerAuthor(author.id)) return;

      const mentionsOperator = mentions.some((id) => this.isOwnerAuthor(id));
      const isDirectMessage =
        room.kind === 'dm' && author.kind === 'agent' && this.isOneOnOneDmWithOperator(room.id);
      if (!isDirectMessage && !mentionsOperator) return;

      emitRoomMessageNotification({
        roomId: room.id,
        roomName: room.title,
        entryId: entry.id,
        entrySeq: entry.seq,
        ...(author.kind === 'agent' && { agentId: this.agents.byPath(author.naturalKey)?.id }),
        fromName: author.displayName,
        text: entry.body.text,
        isDirectMessage,
        // Suppressed once the entry already raised dm.received — see the
        // method doc. A mention in any OTHER room still notifies normally.
        mentionsOperator: mentionsOperator && !isDirectMessage,
        roomMuted: isDirectMessage && this.isRoomMuted(room.id),
      });
    } catch (err) {
      logger.warn('[rooms] could not evaluate whether an entry should notify', {
        roomId: room.id,
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether a `dm`-kind room is genuinely a 1:1 between the operator and one
   * agent — exactly one agent on the roster, AND the operator among its human
   * members.
   *
   * Holds whether the room is a plain two-member DM or a bridged one that has
   * also gained the operator's own external phone identity as a third, human
   * member (chats-as-channels §3.4) — a human member never changes this
   * answer, only another AGENT does, which is exactly the agent-to-agent DM
   * the three-way rule forces the owner onto (`room-conduct.md`) and the agent
   * half of this check exists to exclude.
   *
   * The operator half exists for the other edge the three-way rule leaves:
   * an agent may open a `dm` room for itself alone, with nobody else on the
   * roster at all ("Ana notes", `three-way-rule.test.ts`). One agent, zero
   * humans, is not a DM with anybody — there is nobody there to notify.
   *
   * Reads the owner check off the record `getMany` already fetched rather
   * than `isOwnerAuthor(id)`, which re-queries by id — the exact cost
   * `AuthorRegistry.isOwner`'s own doc warns a caller already holding the
   * roster should not pay (`author-registry.ts`).
   *
   * @param roomId - The room. Only ever called for a `dm`-kind room.
   */
  private isOneOnOneDmWithOperator(roomId: string): boolean {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((member) => member.authorId));
    let agentCount = 0;
    let operatorPresent = false;
    for (const member of members) {
      const record = authors.get(member.authorId);
      if (!record) continue;
      if (record.kind === 'agent') {
        agentCount += 1;
        if (agentCount > 1) return false;
      } else if (this.isOwnerRecord(record)) {
        operatorPresent = true;
      }
    }
    return agentCount === 1 && operatorPresent;
  }

  /**
   * Mark a milestone in a room — a **moment** (team-room-home spec D5.1).
   *
   * **A moment is a post.** It is written into the same log, carries the same
   * fields, and reaches readers on the same stream; what makes it one is
   * `body.moment`, which says what it marks and — the rule the whole feature
   * stands on — what real record it was read from. The feed draws it
   * differently (`MomentRow`); nothing else has to know.
   *
   * **Two ways in, and they are not the same permission.**
   * - *DorkOS itself* (no `authorId`): written by the system author, and
   *   deliberately NOT dispatched. A room where the milestone "tangerines
   *   joined your team" set two agents talking would be the over-participation
   *   `meta/agent-etiquette.md` exists to damp. It is stamped the way an
   *   un-provenanced write is stamped — at the ceiling — so nothing that ever
   *   dispatches from it can open a fresh reply budget either.
   * - *An agent* (`authorId`): straight through {@link RoomService.post}, the
   *   guarded path, unchanged. The membership check, the cascade stamp, the
   *   ancestry rule and the turn budget all apply exactly as they do to
   *   anything else that agent says. There is no second write surface and no
   *   tool: minting a moment is not a way around any of it.
   *
   * **`subjectAuthorId` is refused on the agent path**, and that is the one
   * refusal here that is about safety rather than shape. The field decides
   * whose face the feed draws beside the words; letting an agent set it would
   * let one agent publish its own sentence under another identity. DorkOS
   * writing "tangerines joined your team" is the case the field exists for, and
   * an agent that has something to say about tangerines says it as itself.
   *
   * @param roomId - The room to mark it in.
   * @param input.text - What a person reads. Written by the caller, because the
   *   detector is the only thing that knows the real numbers.
   * @param input.moment - What it marks and what it was derived from. Validated
   *   here rather than trusted: detectors build this from live data, so a
   *   sourceless moment has to fail at the seam instead of landing in the log.
   * @param input.authorId - The agent minting it, when an agent is. Omit for a
   *   moment DorkOS itself observed.
   * @param input.subjectAuthorId - Who the moment is ABOUT, when the room is
   *   speaking about somebody other than itself. System path only.
   * @returns The committed entry.
   */
  postMoment(
    roomId: string,
    input: {
      text: string;
      moment: RoomMoment;
      authorId?: string;
      subjectAuthorId?: string;
    }
  ): RoomEntry {
    const moment = RoomMomentSchema.safeParse(input.moment);
    if (!moment.success) {
      throw new RoomError(
        'INVALID_MOMENT',
        'A moment has to say what it marks and what it was derived from'
      );
    }
    if (input.text.trim().length === 0) {
      throw new RoomError('INVALID_MOMENT', 'A moment has to say something a person can read');
    }
    if (input.authorId !== undefined) {
      if (input.subjectAuthorId !== undefined) {
        throw new RoomError(
          'INVALID_MOMENT',
          'A moment an agent mints is about its author, and may not name another'
        );
      }
      return this.post(roomId, {
        authorId: input.authorId,
        text: input.text,
        moment: moment.data,
      });
    }

    const room = this.requireRoom(roomId);
    // Archived means archived for the room's own voice too — the same rule
    // `postNotice` holds, for the same reason: archiving promises a room stops
    // gaining entries.
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'post',
      body: {
        text: input.text,
        moment: moment.data,
        ...(input.subjectAuthorId && { subjectAuthorId: input.subjectAuthorId }),
      },
      // A milestone addresses nobody. Nothing is parsed out of its words,
      // because nothing wrote them to reach anyone.
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...this.threadPointers(roomId, undefined),
      // The shipped rule rather than a hand-stamped number: a non-human write
      // with no trigger behind it starts a cascade that is already spent.
      ...deriveCascade(id, {
        authorKind: 'system',
        maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
      }),
      createdAt: new Date().toISOString(),
    });
    this.publishEntry(entry);
    return entry;
  }

  /**
   * Write a `notice` — the room speaking in its own voice, authored by the
   * system author. A refused trigger lands one of these; a silently dropped
   * trigger is indistinguishable from a broken agent.
   *
   * @param roomId - The room.
   * @param body - The notice body, e.g. from `buildCascadeNotice`.
   * @param cascade - The cascade this notice belongs to, so it stays traceable.
   * @param replyTo - The entry it belongs under, when the turn it is about
   *   happened inside a thread. A refusal reported at the channel's top level
   *   while the exchange it refused is three replies deep in a thread is a
   *   notice the reader cannot connect to anything (`I3` — a refusal is visible).
   * @returns The committed entry.
   */
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade?: { root: string; depth: number },
    replyTo?: string
  ): RoomEntry {
    const room = this.requireRoom(roomId);
    // Archived means archived for the room's own voice too. `post` has always
    // refused here; a notice that slipped past would let an archived room keep
    // gaining entries, which is the one thing archiving promises it will not do.
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'notice',
      body,
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...this.threadPointers(roomId, replyTo),
      cascadeRoot: cascade?.root ?? id,
      cascadeDepth: cascade?.depth ?? 0,
      createdAt: new Date().toISOString(),
    });
    this.publishEntry(entry);
    return entry;
  }

  /**
   * How many entries each author already has in one cascade — the repeat rule's
   * input, read here so R3's trigger path does not have to know the schema.
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  turnsByAuthorInCascade(roomId: string, cascadeRoot: string): Map<string, number> {
    return this.store.turnsByAuthorInCascade(roomId, cascadeRoot);
  }

  // === Reactions ===

  /**
   * Put one emoji on one entry, or take it back.
   *
   * **This is the quietest write in the domain, and the quiet is the feature**
   * (`specs/room-messaging-design` §2.5). Look at what it does not do: it takes
   * no turn, dispatches no trigger, writes no entry, writes no notice, spends no
   * budget, starts no cascade, and does not touch `lastActivityAt` — so a room
   * full of thanks does not climb a sidebar sorted by recency, and an agent
   * being thanked is not woken up to be told. The acknowledgment reaches the
   * agent on its NEXT turn, in the room-context block it was going to be handed
   * anyway (`room-context.ts`), and never a moment sooner.
   *
   * That is also why a reaction is not `post` with a special body. A post is a
   * turn in the conversation and everything above follows from that; a reaction
   * is a person saying "seen" for free, and free has to mean free.
   *
   * The refusals, in the order they are asked and for reasons that are not
   * interchangeable:
   *
   * - **Not visible** → `ROOM_NOT_FOUND`, before anything else, so a caller
   *   holding a room id learns nothing by probing with an emoji.
   * - **Not a member** → `MEMBER_NOT_FOUND`. Seeing a room is not being in it;
   *   `post` draws the same line and this one is no looser.
   * - **Archived** → `ROOM_ARCHIVED`. Archiving promises a room gains nothing
   *   more, and a pill is something it would gain.
   * - **An agent out of allowance** → `REACTION_RATE_LIMITED`. Agents may react
   *   (ADR 260814-195522, reversing etiquette E16b); what they may not do is
   *   react without a bound, because a reaction costs nothing and so nothing else
   *   in the system would ever slow one down. People are not counted.
   * - **No such entry here** → `ENTRY_NOT_FOUND`, scoped to this room so an id
   *   from elsewhere cannot attach a reaction to a message in a room the caller
   *   cannot see.
   *
   * @param roomId - The room.
   * @param entryId - The entry being reacted to.
   * @param viewerAuthorId - Who is reacting.
   * @param emoji - The emoji, already validated by the request schema.
   * @param on - The state to land in, when the caller names one instead of
   *   flipping. `true` ensures the reaction is there and `false` ensures it is
   *   not, both of them idempotent in effect — which is what a client that may
   *   retry has to be able to ask for, because a retried flip undoes itself.
   * @returns Which way it went, and the caller's recomputed quick row.
   */
  toggleReaction(
    roomId: string,
    entryId: string,
    viewerAuthorId: string,
    emoji: string,
    on?: boolean
  ): { reacted: boolean; frequents: string[] } {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    if (!this.store.getMember(roomId, viewerAuthorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (!this.store.getEntryById(roomId, entryId)) {
      throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');
    }
    // Asked LAST of the refusals, and after the entry check, because it is the
    // only one that SPENDS something: a caller that was going to be refused for
    // any other reason must not have an allowance taken off it on the way out.
    //
    // **Only an ADDITION spends.** Taking a reaction back is never refused and
    // never charged, because a retraction is the remedy for a reaction somebody
    // regrets and an agent that cannot take one back is an agent whose mistakes
    // are permanent — and because it makes the ceiling honest to describe:
    // twenty an hour means twenty pills, not twenty clicks. Which way this call
    // goes is settled before the write, from the row state: `on: false` removes,
    // a flip removes what is standing, and `on: true` on a reaction already there
    // is a no-op a retrying client must not be charged for.
    if (this.authors.getById(viewerAuthorId)?.kind !== 'human') {
      const standing = this.reactions.has({ roomId, entryId, authorId: viewerAuthorId, emoji });
      const lands = on === false ? false : !standing;
      if (lands && !this.reactionBudget.tryReserve(roomId, viewerAuthorId)) {
        throw new RoomError(
          'REACTION_RATE_LIMITED',
          'You have used up your reactions in this room for now — say something instead, or wait.'
        );
      }
    }

    const reacted = this.reactions.set(
      { roomId, entryId, authorId: viewerAuthorId, emoji },
      new Date().toISOString(),
      on
    );
    this.publishReactions(roomId, entryId);
    return { reacted, frequents: this.reactions.frequents(viewerAuthorId) };
  }

  /**
   * One entry's reactions right now, for a reader that already holds the entry.
   *
   * @param roomId - The room.
   * @param entryId - The entry.
   */
  reactionsFor(roomId: string, entryId: string): RoomEntryReaction[] {
    return this.reactions.listForEntry(roomId, entryId);
  }

  /**
   * The current reaction state of every entry in a room's trailing window — the
   * resume half of the reaction contract.
   *
   * A resume replays entries above the cursor, and each of those arrives with
   * its own reactions. What it cannot carry is a reaction that changed on an
   * OLDER message while the reader was away: that entry is below the cursor, so
   * nothing replays it, and the reader would sit on stale pills until a reload.
   * So the handler asks for this once, after the replay.
   *
   * **EVERY entry in the window, including the ones with no reactions at all.**
   * That is not padding, it is the difference between state and a diff, and
   * skipping the empties silently loses removals: react, disconnect, take it
   * back, resume — the entry is unchanged so nothing replays it, and it has no
   * pills so a "only what still has reactions" resync says nothing about it,
   * leaving the reader showing a 👍 that {@link RoomService.reactionsFor}
   * denies. The empty event IS the correction. It costs one small frame per
   * message in the window on a resume only, which is the price of the contract
   * {@link RoomReactionEventSchema} states.
   *
   * @param roomId - The room.
   * @param historyLimit - How many trailing entries to cover; the same window a
   *   cold connect hydrates, because it is the same set of drawable messages.
   * @returns One event per entry in the window, oldest first, carrying that
   *   entry's whole current set — `[]` when it has none.
   */
  reactionResync(roomId: string, historyLimit: number): RoomReactionEvent[] {
    const entries = this.store.listEntries(roomId, { limit: historyLimit });
    const grouped = this.reactions.listFor(
      roomId,
      entries.map((entry) => entry.id)
    );
    return entries.map((entry) => ({
      type: 'reaction',
      entryId: entry.id,
      reactions: grouped.get(entry.id) ?? [],
    }));
  }

  // === Streaming ===

  /**
   * The snapshot a cold SSE connect opens with, plus the cursor its live
   * subscription resumes from.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param historyLimit - How many trailing entries to hydrate with.
   */
  snapshot(
    roomId: string,
    viewerAuthorId: string,
    historyLimit: number
  ): { room: RoomWithRoster; entries: RoomEntry[]; cursor: number } {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    const entries = this.withRollups(
      roomId,
      this.store.listEntries(roomId, { limit: historyLimit })
    );
    return {
      room: this.withRoster(room, viewerAuthorId),
      entries,
      cursor: entries.length > 0 ? entries[entries.length - 1].seq : 0,
    };
  }

  /**
   * The highest `seq` this room has issued, or 0 when it is empty. The SSE
   * handler bounds a resume cursor against it.
   *
   * @param roomId - The room.
   */
  maxSeq(roomId: string): number {
    return this.store.maxSeq(roomId);
  }

  /**
   * Every entry after a cursor — the SSE replay read. The log is never trimmed,
   * so this is always servable.
   *
   * @param roomId - The room.
   * @param afterSeq - Return entries with `seq` above this.
   */
  entriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    return this.withRollups(roomId, this.store.listEntriesAfter(roomId, afterSeq));
  }

  /**
   * Deliver an ephemeral signal — typing, presence, a receipt. Live only: it
   * never enters the log and is dropped on replay, because a room's record is
   * what another member should be able to read later.
   *
   * @param roomId - The room.
   * @param signal - The signal type, from the relay's shared vocabulary.
   * @param authorId - Who the signal is about.
   * @param presence - The working lifecycle, on a `'progress'` signal. Every
   *   publish carries the whole of it, `since` included: an ephemeral event is
   *   never replayed, so it has to be renderable by a client that connected in
   *   the middle of the work.
   *
   *   Typed as a PARTIAL here and as a whole {@link RoomPresencePayload} at the
   *   dispatcher's `publishPresence` dep, because the two producers have
   *   different floors. The dispatcher owns the claim map, so it always knows
   *   all three and is held to all three. `LocalCommunityAdapter` publishes on
   *   behalf of a `CommunityAdapter` caller, whose payload is optional field by
   *   field (a remote backend may only be able to say that somebody is working)
   *   — and inventing an `entryId` to satisfy a required type would be a worse
   *   answer than carrying less.
   */
  publishSignal(
    roomId: string,
    signal: SignalType,
    authorId: string,
    presence?: Partial<RoomPresencePayload>
  ): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal,
      authorId,
      at: new Date().toISOString(),
      ...presence,
    });
    // The bridge's presence forwarder (chats-as-channels §6.8). Deliberately
    // AFTER the broadcast, and guarded, so a bridge with nothing to forward to
    // (or a forwarder that throws) can never fail the room's own signal —
    // same shape as `publishEntry`'s guard around `onEntryCommitted`.
    if (this.onSignalPublished) {
      try {
        // The verb travels; the target does not. A bridged chat is other
        // people's surface, and the room's own durable waiting notice already
        // refuses to put "file paths and commands included" in front of
        // everybody else (ADR 260819-022127). The broadcast above is untouched:
        // that one IS this operator's cockpit.
        this.onSignalPublished(
          roomId,
          signal,
          authorId,
          presence && withoutActivityTarget(presence)
        );
      } catch (err) {
        logger.warn('[rooms] signal listener threw', {
          roomId,
          signal,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Register the chat bridge's presence forwarder (chats-as-channels §6.8),
   * called for every ephemeral signal this service fans out. At most one is
   * set; the binding subsystem wires it once the bridge presence forwarder
   * exists — the same one-listener shape as
   * {@link RoomService.setEntryCommitListener}.
   *
   * @param listener - Called with each published signal, or `undefined` to clear.
   */
  setSignalListener(
    listener:
      | ((
          roomId: string,
          signal: SignalType,
          authorId: string,
          presence?: Partial<RoomPresencePayload>
        ) => void)
      | undefined
  ): void {
    this.onSignalPublished = listener;
  }

  // === Internals ===

  /**
   * Resolve the two thread pointers an entry is written with.
   *
   * **This is where the one-level rule lives, and it is the whole of it**
   * (ADR 260728-022013). The schema permits `parent_entry_id` to name a reply;
   * the service refuses to write one, on the same reasoning 260726-170125 gave
   * and every surveyed product shares. So the depth ceiling is a policy a later
   * ADR can revisit by changing the `if` below — not a shape a migration would
   * have to undo. Opening a second level means deriving
   * `threadRootEntryId = parent.threadRootEntryId ?? parent.id` here instead of
   * throwing; nothing else in the schema has an opinion.
   *
   * Refusing beats flattening: a reader who thought they had branched twice and
   * got one branch has been lied to.
   *
   * @param roomId - The room the entry is being written into.
   * @param replyTo - The entry it answers, or undefined for a top-level entry.
   * @returns The `parentEntryId` / `threadRootEntryId` pair to persist.
   */
  private threadPointers(
    roomId: string,
    replyTo: string | undefined
  ): { parentEntryId: string | null; threadRootEntryId: string | null } {
    if (replyTo === undefined) return { parentEntryId: null, threadRootEntryId: null };
    // Scoped to this room, so an entry id from a room the caller can see cannot
    // pull a reply into a conversation it does not belong to.
    const root = this.store.getEntryById(roomId, replyTo);
    if (!root) throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');
    if (root.threadRootEntryId !== null) {
      throw new RoomError('NESTED_THREAD', 'A thread reply cannot hang off another reply');
    }
    return { parentEntryId: root.id, threadRootEntryId: root.id };
  }

  /**
   * Fetch a room or throw the typed not-found the routes map to a 404.
   *
   * Unscoped — for server-internal writes only (`postNotice`, whose author is
   * the system and is deliberately on no roster). Every request-driven path
   * uses {@link RoomService.requireVisibleRoom} instead.
   */
  private requireRoom(roomId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  /**
   * Fetch a room the caller is entitled to see, or throw.
   *
   * The single visibility rule for every request-driven path. It reports the
   * same `ROOM_NOT_FOUND` for "no such room" and "not visible to you" on
   * purpose: distinguishing them would let an agent holding a room id — and the
   * identity header is attribution, not authorization
   * (`middleware/agent-identity.ts`) — confirm that the operator's DM with
   * another agent exists by probing for a different error code.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller's author id.
   */
  private requireVisibleRoom(roomId: string, viewerAuthorId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room || !this.canSee(roomId, viewerAuthorId)) {
      throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    }
    return room;
  }

  /**
   * Whether this caller may see a room at all: the owner may see every room,
   * everybody else only the ones they belong to.
   */
  private canSee(roomId: string, viewerAuthorId: string): boolean {
    if (this.seesEveryRoom(viewerAuthorId)) return true;
    return this.store.getMember(roomId, viewerAuthorId) !== null;
  }

  /**
   * The owner sees every room; nothing on their own machine hides from them.
   *
   * This used to read `kind === 'human'`, which was only ever the same question
   * while an install minted exactly one human author. A second one — an invited
   * person — would have passed it and read every room on the install, the
   * owner's DMs with agents included.
   */
  private seesEveryRoom(viewerAuthorId: string): boolean {
    return this.isOwnerAuthor(viewerAuthorId);
  }

  /**
   * Refuse a roster write from anyone but the person who owns the install.
   *
   * Deliberately a 403 and not a 404: the caller is already a member of a room
   * it can see, so there is nothing left to hide, and telling an agent "you may
   * not" is more useful than telling it a room it just read no longer exists.
   *
   * Same correction as {@link RoomService.seesEveryRoom}: on `kind === 'human'`
   * a second person could have rewritten any roster in any room.
   *
   * @param viewerAuthorId - The caller.
   * @param what - What they tried to change, for the message.
   */
  private requireOperator(viewerAuthorId: string, what: string): void {
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
  }

  /**
   * Refuse a rename or an archive of a SYSTEM room from anyone but the owner
   * (team-room-home spec D3.1).
   *
   * **A field check, not a caller check, and that is what makes it safe to add
   * here at all.** DOR-608's open hole is that `updateRoom` has no operator
   * gate, and the reason it stays open is that adding one breaks
   * `createRoom`'s DM un-archive path — an agent legitimately re-opening its
   * own archived direct message. This refusal cannot reach that path: it fires
   * only on `wellKnown`, which no DM and no caller-created room ever carries.
   * So the hole is closed for the rooms the product cannot work without, and
   * every ordinary room behaves exactly as it did.
   *
   * **Rename and archive, not topic, and not delete.** The title is a channel's
   * address (renaming it moves the `#slug`), and archiving takes the room off
   * every list — both would break the home tab that renders #team for anybody
   * who did not ask for it. A topic is a description, and describing a shared
   * room is ordinary participation. There is no delete verb on a room at all
   * (archive is this product's reversible "put it away", spec §12.4), so
   * "nobody may delete #team" needs no code — and muting is a sidebar
   * preference in the person's own config, which never reaches this domain,
   * so the owner can still quiet the room without leaving it.
   *
   * @param room - The room being patched.
   * @param viewerAuthorId - The caller.
   * @param patch - The room-table half of the requested patch.
   */
  private requireSystemRoomWritable(
    room: Room,
    viewerAuthorId: string,
    patch: { title?: string; archived?: boolean }
  ): void {
    if (!room.wellKnown) return;
    if (patch.title === undefined && patch.archived === undefined) return;
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError(
      'SYSTEM_ROOM',
      `Only you can rename or archive ${room.slug ? `#${room.slug}` : room.title}`
    );
  }

  /**
   * Refuse taking the owner off a SYSTEM room's roster (DOR-1233 follow-up to
   * team-room-home spec D3.1).
   *
   * **The three-way rule alone does not cover this.** It refuses removing the
   * owner only once a room holds two or more agents, and #team ships seated
   * with exactly one — DorkBot's fallback seat (`ensure-team-room.ts`) — so
   * leaving #team through the ordinary Leave button was reachable with no gate
   * on it at all. And unlike an ordinary room, nothing puts the membership
   * back afterwards: `ensureSystemChannel` is idempotent on the ROOM, not on
   * its roster — once #team exists, a restart returns that same row untouched.
   * #team is the install's home tab (team-room-home spec D3.2); a home with
   * nobody home is not a state this product can recover from without editing
   * the database by hand.
   *
   * A field check on `wellKnown`, the same shape as
   * {@link RoomService.requireSystemRoomWritable} and for the same reason: it
   * cannot reach a DM or a caller-created channel, neither of which ever
   * carries the flag, so an ordinary room's Leave is untouched.
   *
   * @param room - The room being removed from.
   * @param authorId - The member being removed.
   */
  private requireSystemRoomKeepsOwner(room: Room, authorId: string): void {
    if (!room.wellKnown) return;
    if (!this.isOwnerAuthor(authorId)) return;
    throw new RoomError(
      'SYSTEM_ROOM',
      `You can't leave ${room.slug ? `#${room.slug}` : room.title} — it's your home channel`
    );
  }

  /**
   * Refuse a non-owner's attempt to seed a room with an agent that is not
   * itself — **unless the owner is in that room too** (the three-way rule,
   * ADR 260814-025326).
   *
   * A caller opening a room for itself — a DM with the owner, a scratch channel
   * — is legitimate and has always been allowed. What changed on 2026-08-13 is
   * the case beside it: **an agent may now open a room with another agent, and
   * the price is that the person is on the roster.** Agents that can only ever
   * talk to their operator cannot divide work between themselves, which is the
   * coordination this product is for.
   *
   * **What the owner's membership buys is not visibility — she already has
   * that.** {@link RoomService.seesEveryRoom} shows the owner every room on the
   * install whether or not she is on its roster, so "a conversation nobody can
   * see" was never the thing at risk. MEMBERSHIP is: only a membership carries a
   * read cursor, so only a room the owner is IN has an unread count at all
   * ({@link RoomService.cursorsFor} keys on `room_members`; a non-member's is
   * `null`, which the sidebar draws as no badge). Two agents in a room she is
   * not on the roster of would talk in a row that never lights up — visible in
   * the way a file is visible, which is not the same as being told. The rule
   * makes the person a participant rather than an auditor, and it is checked
   * here rather than promised in a prompt.
   *
   * **Only an AGENT gets that escape.** A second PERSON — a member account, in
   * an install with login on — still may not put any agent in any room, owner
   * present or not. `/api/rooms` is reachable by a member (her own rooms live
   * behind it), so without that narrowness she could conscript somebody else's
   * agents into work that spends the owner's model quota with the server
   * process's filesystem access. An agent seeding a colleague is doing the job
   * it was installed to do; a guest doing it is spending an account that is not
   * theirs. Nothing asked for the second, so nothing here grants it.
   *
   * This reads owner-identity rather than `kind === 'human'` for the same reason
   * {@link RoomService.requireOperator} does.
   *
   * **Creation is not the only door**, and this method is not the whole rule:
   * {@link RoomService.requireOwnerWitnessesAgents} holds the same invariant at
   * `addMember` and `removeMember`, because a room that passes here could
   * otherwise be walked into the forbidden shape one membership call later.
   *
   * @param creator - The author opening the room.
   * @param seeded - Every author the new roster will hold.
   */
  private requireSeedingAllowed(creator: AuthorRecord, seeded: readonly AuthorRecord[]): void {
    if (this.isOwnerAuthor(creator.id)) return;
    const conscripted = seeded.find(
      (author) => author.id !== creator.id && author.kind === 'agent'
    );
    if (!conscripted) return;
    if (creator.kind !== 'agent') {
      throw new RoomError('OPERATOR_ONLY', 'Only you can put another agent in a room');
    }
    if (seeded.some((author) => this.isOwnerAuthor(author.id))) return;
    throw new RoomError(
      'OPERATOR_ONLY',
      'Two agents can only share a room you are in — add yourself to it'
    );
  }

  /**
   * Hold the three-way rule across a membership change: **a room that holds two
   * or more agents holds the owner too** (ADR 260814-025326).
   *
   * The same invariant {@link RoomService.requireSeedingAllowed} settles at
   * creation, asked of the roster a membership call is about to produce. Both
   * are needed, and the reason is that either one alone is a door standing open:
   * a create the gate allows could be walked into an owner-less pair by adding
   * an agent afterwards, and an owner who may leave any room could empty herself
   * out of a room her two agents are talking in. Neither is a caller check —
   * both membership verbs are already `requireOperator`, so the caller here is
   * always the owner. **This refuses the owner herself**, which is the point:
   * the guarantee is about the shape of the room, not about who asked.
   *
   * It is deliberately compositional rather than provenance-based. Nothing
   * records who opened a room — `rooms` has no `created_by` column — and adding
   * one would make the rule "an AGENT-seeded pair needs a witness" while leaving
   * a pair the owner seeded and then walked out of just as unattended. Asking
   * the roster instead needs no column and covers both.
   *
   * **A property of these two write verbs, not of the data already on disk.** A
   * room that reached the forbidden shape before this rule existed keeps
   * running, keeps triggering, and is never retro-refused; nothing sweeps the
   * table. What is closed is every way to REACH that shape from here.
   *
   * **Removing an agent is never refused**, so a room is never wedged: when
   * this refuses the owner's own removal (a direct Leave — DOR-1233), the way
   * through is to take an agent out first and leave afterwards, or to archive
   * the room instead. There is still no delete (spec §12.4).
   *
   * @param roster - The roster as it will be AFTER the change.
   * @param what - What the caller was doing, for the refusal's own words.
   */
  private requireOwnerWitnessesAgents(
    roster: readonly { authorId: string; kind: AuthorKind }[],
    what: 'add' | 'remove'
  ): void {
    if (roster.filter((member) => member.kind === 'agent').length < 2) return;
    if (roster.some((member) => this.isOwnerAuthor(member.authorId))) return;
    throw new RoomError(
      'OWNER_MUST_BE_PRESENT',
      what === 'add'
        ? 'Two agents can only share a room you are in — join it first'
        : 'Two agents share this room — take one of them out before you leave it'
    );
  }

  /**
   * Refuse anything that is not a person.
   *
   * **One verb takes it now, and it used to be two.** Reactions were the other,
   * on the strength of etiquette E16b; ADR 260814-195522 reverses that, so an
   * agent may put an emoji on a message and {@link ReactionBudget} — not this
   * gate — is what bounds it. The kind check moved because the thing being
   * protected turned out to be volume, not authorship: an acknowledgment from a
   * colleague is worth having, and a hundred of them are not.
   *
   * **Agents do not stop each other.** A halt cuts every in-flight turn in a
   * room; an agent reaching for it would be electing itself referee over its
   * room-mates, which is the arbitration this domain has declined twice
   * (ADR 260726-170125). The verb belongs to the person watching.
   *
   * A 403 rather than a 404: the caller is a member of a room it can see, so
   * there is nothing left to hide, and telling an agent "this is not yours to
   * send" is more useful than pretending the entry vanished.
   *
   * An author row that has vanished is refused too — the same conservative read
   * `post` takes when it cannot find one, since the only thing this decides is
   * whether a non-person gets to act on a person's behalf.
   *
   * @param authorId - The caller.
   * @param what - What they were trying to do, for the refusal's own words.
   */
  private requirePersonAuthor(authorId: string, what: string): void {
    if (this.authors.getById(authorId)?.kind === 'human') return;
    throw new RoomError('PEOPLE_ONLY', `Only people ${what}`);
  }

  /**
   * Attach each entry's reactions AND its attachments, in one query per side
   * table for the whole page.
   *
   * **One function rather than two, because the failure mode is a path somebody
   * forgot.** Every read path takes this — the history page, the hydration
   * snapshot and the resume replay — so a reader never holds an entry without
   * holding what hangs off it. A second roll-up written beside this one would
   * be a fourth place to remember, and the first one anybody would miss.
   *
   * Chunked because the replay is unbounded by construction (a reader gone for
   * a week resumes against the whole gap) and SQLite caps how many parameters
   * one statement may bind; a page nobody can read is a worse answer than two
   * queries. Both side tables are chunked on the same boundary, so a page costs
   * exactly two queries per chunk.
   *
   * @param roomId - The room the entries belong to.
   * @param entries - The page, in whatever order the caller wants it.
   */
  private withRollups(roomId: string, entries: RoomEntry[]): RoomEntry[] {
    if (entries.length === 0) return entries;
    const pills = new Map<string, RoomEntryReaction[]>();
    const files = new Map<string, RoomAttachment[]>();
    for (let from = 0; from < entries.length; from += REACTION_LOOKUP_CHUNK) {
      const chunk = entries.slice(from, from + REACTION_LOOKUP_CHUNK);
      const ids = chunk.map((entry) => entry.id);
      for (const [entryId, reactions] of this.reactions.listFor(roomId, ids)) {
        pills.set(entryId, reactions);
      }
      for (const [entryId, attachments] of this.attachments.listFor(roomId, ids)) {
        files.set(entryId, attachments);
      }
    }
    return entries.map((entry) => ({
      ...entry,
      reactions: pills.get(entry.id) ?? [],
      attachments: files.get(entry.id) ?? [],
    }));
  }

  /** Fan one entry's whole current reaction set out to the room's readers. */
  private publishReactions(roomId: string, entryId: string): void {
    this.broadcaster.publish(roomId, {
      type: 'reaction',
      entryId,
      reactions: this.reactions.listForEntry(roomId, entryId),
    });
  }

  /**
   * Register the chat bridge's inline-delivery hook (chats-as-channels §6.1),
   * called for every committed entry. At most one is set; the binding subsystem
   * wires it once the delivery engine exists.
   *
   * @param listener - Called with each committed entry, or `undefined` to clear.
   */
  setEntryCommitListener(listener: ((entry: RoomEntry) => void) | undefined): void {
    this.onEntryCommitted = listener;
  }

  /**
   * Publish a committed entry to the room's readers and bump global activity.
   *
   * @param entry - The committed entry.
   * @param attachments - The files bound to it in the same transaction. Unlike
   *   a reaction, an attachment EXISTS at the instant the entry does, so this
   *   path carries the real refs rather than an empty list — a reader who saw
   *   the live frame and a reader who hydrated a moment later must see the same
   *   message.
   */
  private publishEntry(entry: RoomEntry, attachments: RoomAttachment[] = []): void {
    // `reactions: []` rather than omitted: an entry a millisecond old genuinely
    // has none, and a reader that had to treat "absent" and "empty" as the same
    // thing on the live path but not on the others would have two rules.
    this.broadcaster.publish(entry.roomId, {
      type: 'entry',
      seq: entry.seq,
      entry: { ...entry, reactions: [], attachments },
    });
    eventFanOut.broadcast('room_activity', {
      roomId: entry.roomId,
      seq: entry.seq,
      lastActivityAt: entry.createdAt,
    });
    // The bridge's inline fast path (chats-as-channels §6.1). Deliberately AFTER
    // the broadcast and fan-out, and guarded, so a bridge delivery can never
    // fail a commit or stall the room's own readers. The listener itself is
    // fire-and-forget; this guard is only for a synchronous throw building it.
    if (this.onEntryCommitted) {
      try {
        this.onEntryCommitted(entry);
      } catch (err) {
        logger.warn('[rooms] entry-commit listener threw', {
          roomId: entry.roomId,
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Attach the resolved roster to a room, and say which of its members the
   * reader is.
   *
   * `viewerAuthorId` is the id this call was already scoped by, so it is the
   * authoritative answer to "which one am I" rather than something a client can
   * infer. It is not necessarily ON the roster: the owner sees rooms they have
   * not joined, and a reader who is not a member has no membership to find.
   *
   * @param room - The room.
   * @param viewerAuthorId - The caller this room was resolved for.
   */
  private withRoster(room: Room, viewerAuthorId: string): RoomWithRoster {
    // One indexed lookup per room open (spec §14 budgets exactly this): a bridged
    // room carries its `deliverNotices` override so the cockpit's bridge controls
    // read their state from the room they already fetch, rather than a route of
    // their own. Absent for an unbridged room, which is the honest tell.
    const bridge = this.bridges.findBridgeByRoom(room.id);
    return {
      ...room,
      members: this.roster.list(room.id),
      viewerAuthorId,
      // Computed here rather than on a route of its own: this is the one place
      // every surface that draws a message capsule already asks for — the room
      // read, the create response, and the stream's hydration snapshot — and the
      // reader it belongs to is the id this call was already scoped by.
      reactionFrequents: this.reactions.frequents(viewerAuthorId),
      ...(bridge ? { deliverNotices: bridge.deliverNotices } : {}),
      bridge: bridgeInfo(bridge),
    };
  }

  /**
   * The `slug` half of a channel rename, as a patch fragment to spread.
   *
   * Empty for anything that is not a channel getting a new title — only a
   * channel has a name people type, so only a channel has a slug to move. That
   * guard is load-bearing: without it a direct message would be given one.
   *
   * Refuses a title with nothing sluggable in it, and one that slugs onto a name
   * another LIVE channel holds. An archived channel's slug is not reserved, so
   * it never blocks a rename; {@link updateRoom} is where that matters, because
   * it judges an un-archive against the slug the room is about to have.
   *
   * @param room - The room being patched.
   * @param title - The requested title, when the patch carries one.
   * @returns `{ slug }` when the slug moves, otherwise `{}`.
   */
  private renamedSlug(room: Room, title: string | undefined): { slug?: string } {
    if (title === undefined || room.kind !== 'channel') return {};
    const slug = slugify(title);
    if (!slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number in it'
      );
    }
    // A cosmetic rename — `#Backend` to `Backend ` — slugs to what the channel
    // is already called. Returning early skips a lookup and a no-op write; the
    // `holder.id !== room.id` test below would reach the same verdict, so this
    // is an optimisation and not the guard against self-conflict.
    if (slug === room.slug) return {};
    const holder = this.store.findLiveChannelBySlug(slug);
    if (holder && holder.id !== room.id) {
      throw new RoomError('SLUG_TAKEN', `A channel called #${slug} already exists`);
    }
    return { slug };
  }
}

/**
 * Derive a channel slug from a title: lowercase, hyphenated, trimmed to 80.
 * Returns `null` when the title has nothing sluggable in it, so the caller can
 * ask for a slug rather than inventing one nobody would recognise.
 */
function slugify(title: string): string | null {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || null
  );
}
