/**
 * The state every room collaborator reads, built once and shared by all of
 * them.
 *
 * `RoomService` used to be one class holding these nineteen fields and every
 * method that touches them. The fields did not change when it was split; what
 * changed is that they now live in one place the collaborators are handed,
 * rather than in one class the collaborators would have had to be. Each
 * collaborator copies out the handful it uses, so its own methods still read
 * `this.store` and `this.authors` exactly as they did.
 *
 * **The roster and the trigger dispatcher are built here, not injected.** Both
 * are derived from the same {@link RoomServiceDeps}, and the dispatcher writes
 * back through the service — a reply is a post like any other — so it takes
 * three hooks rather than a store. They are only ever called after
 * construction.
 *
 * @module server/services/rooms/service/room-core
 */
import type { RoomPresencePayload } from '@dorkos/shared/room-schemas';
import type { RoomContextCanvas } from '@dorkos/shared/additional-context';
import type { ReadCursorService } from '../../core/read-cursor-service.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import {
  bridgedRoomFraming,
  topicNamesForEntries,
} from '../../relay/chat-bridge/room-context-framing.js';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { RoomLimitsResolver } from '../limits/room-limits.js';
import type { ReactionBudget } from '../reactions/reaction-budget.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import { roomScope, type CanvasDocumentStore, type CanvasService } from '../../canvas/index.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomAgentLookup } from '../room-errors.js';
import { RoomRoster } from '../room-roster.js';
import type { RoomStore } from '../room-store.js';
import type { RoomBroadcaster } from '../room-stream.js';
import { RoomTriggerDispatcher, type RoomTriggerWriter } from '../room-trigger.js';
import type { RoomEntryIndexer, RoomMessageFinder, RoomServiceDeps } from './room-service-deps.js';

/** Everything a room collaborator may read, resolved once at construction. */
export interface RoomCore {
  readonly store: RoomStore;
  /** Reactions on this room's entries — durable state, never a turn. */
  readonly reactions: ReactionStore;
  /** The documents on this room's shared canvas. */
  readonly canvasDocuments: CanvasDocumentStore;
  /** The one writer every canvas on this machine goes through. */
  readonly canvas: CanvasService;
  /** How many emoji an agent may still land in one room this hour. */
  readonly reactionBudget: ReactionBudget;
  /** Words in, entry coordinates out. The message index, behind its port. */
  readonly findMessages: RoomMessageFinder;
  /** Entries out, the moment they are committed. The write half of that port. */
  readonly indexEntry: RoomEntryIndexer;
  /** The rows behind this room's attachments, never the bytes. */
  readonly attachments: AttachmentRowStore;
  readonly authors: AuthorRegistry;
  readonly broadcaster: RoomBroadcaster;
  readonly roster: RoomRoster;
  readonly triggers: RoomTriggerDispatcher;
  /**
   * What bounds automatic replies in one room. Read per write, so a change in
   * Settings or on the room takes effect on the very next message.
   */
  readonly limitsFor: RoomLimitsResolver;
  /** The live `uploads.maxFiles`. Read per post, so a change takes effect. */
  readonly maxAttachmentsPerEntry: () => number;
  readonly maxPostsPerTurn: () => number;
  /** The live `rooms.maxCanvasOpsPerTurn`. Read per operation, never captured. */
  readonly maxCanvasOpsPerTurn: () => number;
  /** The room's own shared checkout, or `null` when it has no files. */
  readonly roomRepoPath: (roomId: string) => string | null;
  /** The clock a canvas edit lock is judged against. Absent means `Date.now`. */
  readonly canvasNow?: () => number;
  /** Whether an author is the install's owner. Read per check, never captured. */
  readonly isOwnerAuthor: (authorId: string) => boolean;
  /** The record-based twin of {@link RoomCore.isOwnerAuthor}. */
  readonly isOwnerRecord: (record: AuthorRecord) => boolean;
  /**
   * Whether an author's words are the operator's own — the owner, plus any
   * platform identity they have declared to be them (DOR-1778). Attribution,
   * never authority; see {@link RoomServiceDeps.isOwnerVoice}.
   */
  readonly isOwnerVoice: (authorId: string) => boolean;
  readonly bridges: BridgeStore;
  /** Where the PEOPLE in a room have read up to. Never an agent's cursor. */
  readonly readCursors: ReadCursorService;
  /**
   * The mesh agent table, keyed by directory — read only to resolve a posting
   * agent's `agents.id` for a notification payload (spec `notification-system`
   * task T11). Every other agent lookup in this domain goes through
   * {@link RoomCore.authors} or {@link RoomCore.roster}.
   */
  readonly agents: RoomAgentLookup;
  /** Whether the operator has muted a room. Read per post, never captured. */
  readonly isRoomMuted: (roomId: string) => boolean;
}

/**
 * The `canvas` section of one room's turn context, or `null` when the room has
 * nothing on its table (spec `room-canvas` §6.1).
 *
 * Built here rather than in `RoomCanvasService` because what the context
 * carries is a decision about the PROMPT — labels only, no content — and the
 * service's job is the table. The handle it names each author by is the roster's
 * own, so an agent reading this section can address whoever put something there
 * with the same string the members line uses.
 *
 * @param deps - Everything the service was constructed from.
 * @param roomId - The room taking a turn.
 * @returns The section, or `null`.
 */
function canvasContextFor(deps: RoomServiceDeps, roomId: string): RoomContextCanvas | null {
  const documents = deps.canvasDocuments.list(roomScope(roomId));
  if (documents.length === 0) return null;
  return {
    viewers: deps.broadcaster.subscriberCount(roomId),
    documents: documents.map((row) => {
      const author = deps.authors.getById(row.authorId);
      const url =
        row.content.type === 'url' || row.content.type === 'browser' ? row.content.url : undefined;
      return {
        id: row.id,
        type: row.contentType,
        title: row.title,
        ...(url !== undefined ? { url } : {}),
        author: author?.handle ?? author?.displayName ?? 'Unknown',
        pinned: row.pinned,
        lastChangedAt: row.lastTouchedAt,
      };
    }),
  };
}

/**
 * The three ways the trigger dispatcher reaches back into the service that
 * owns it.
 *
 * Bound methods rather than the store, because a reply is a post like any
 * other — mentions and provenance included — and the room's ephemeral channel
 * is the service's to name. `publishPresence` in particular is bound by the
 * caller so the one signal name presence may use is not a decision the
 * dispatcher can get wrong.
 */
export interface RoomWriteBack extends RoomTriggerWriter {
  /** Fan a working agent's progress out on the room's ephemeral channel. */
  publishPresence(roomId: string, authorId: string, presence: RoomPresencePayload): void;
}

/**
 * Resolve the shared state one room service runs on.
 *
 * @param deps - Everything the service was constructed from.
 * @param writeBack - How the dispatcher reaches back into that service.
 * @returns The state every collaborator is handed.
 */
export function createRoomCore(deps: RoomServiceDeps, writeBack: RoomWriteBack): RoomCore {
  const roster = new RoomRoster({
    store: deps.store,
    authors: deps.authors,
    agents: deps.agents,
    readCursors: deps.readCursors,
  });
  const triggers = new RoomTriggerDispatcher({
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
      const bridge = deps.bridges.findBridgeByRoom(roomId);
      return bridge ? bridgedRoomFraming(bridge) : null;
    },
    topicNamesFor: (entryIds) => topicNamesForEntries(deps.bridges, entryIds),
    attachmentsFor: (roomId, entryIds) => deps.attachments.listFor(roomId, entryIds),
    // What is on this room's table, as LABELS — never a document's contents.
    // Resolved per turn, so an agent reads the table as it stands when its turn
    // starts rather than as it stood when this service was built. `null` for a
    // room with nothing on it, which renders no section at all.
    canvasFor: (roomId) => canvasContextFor(deps, roomId),
    runner: deps.turns,
    ...(deps.worktrees ? { worktrees: deps.worktrees } : {}),
    budget: deps.budget,
    limitsFor: deps.limitsFor,
    engagedWindow: deps.engagedWindow,
    collect: deps.collect,
    responseGate: deps.responseGate,
    holdCeilingMs: deps.holdCeilingMs,
    writer: {
      post: (roomId, input) => writeBack.post(roomId, input),
      postNotice: (roomId, body, cascade, replyTo) =>
        writeBack.postNotice(roomId, body, cascade, replyTo),
    },
    publishPresence: (roomId, authorId, presence) =>
      writeBack.publishPresence(roomId, authorId, presence),
    // Deliberately NOT `room_activity`, which is the other event a room's work
    // makes the sidebar redraw for. That one fires on a committed entry and
    // carries the `seq` its reader orders the list by; a claim has no entry and
    // no `seq`, so borrowing the name would have meant either a lie in the
    // payload or a second meaning for its consumer to disambiguate
    // (room-presence spec §6).
    publishWorkingCount: (roomId, working) =>
      eventFanOut.broadcast('room_presence', { roomId, working }),
  });
  return {
    store: deps.store,
    reactions: deps.reactions,
    canvasDocuments: deps.canvasDocuments,
    canvas: deps.canvas,
    reactionBudget: deps.reactionBudget,
    findMessages: deps.findMessages,
    indexEntry: deps.indexEntry,
    attachments: deps.attachments,
    authors: deps.authors,
    broadcaster: deps.broadcaster,
    roster,
    triggers,
    limitsFor: deps.limitsFor,
    maxAttachmentsPerEntry: deps.maxAttachmentsPerEntry,
    maxPostsPerTurn: deps.maxPostsPerTurn,
    maxCanvasOpsPerTurn: deps.maxCanvasOpsPerTurn,
    roomRepoPath: deps.roomRepoPath,
    ...(deps.canvasNow ? { canvasNow: deps.canvasNow } : {}),
    isOwnerAuthor: deps.isOwnerAuthor,
    isOwnerRecord: deps.isOwnerRecord,
    isOwnerVoice: deps.isOwnerVoice,
    bridges: deps.bridges,
    readCursors: deps.readCursors,
    agents: deps.agents,
    isRoomMuted: deps.isRoomMuted,
  };
}
