/**
 * How a room's stored rows are projected into what a reader is handed: a page
 * of entries with everything that hangs off them, and a room with its roster.
 *
 * Two functions, taken by every read path in the domain, and that is the
 * point — a reader must never hold an entry without its reactions and its
 * files, and a room read must never be assembled twice in two places.
 *
 * @module server/services/rooms/service/room-projection
 */
import type {
  Room,
  RoomAttachment,
  RoomBridgeInfo,
  RoomEntry,
  RoomEntryReaction,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import type { Bridge, BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { bridgedRoomFraming } from '../../relay/chat-bridge/room-context-framing.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomCore } from './room-core.js';
import type { RoomRoster } from '../room-roster.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

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
export function bridgeInfo(bridge: Bridge | null | undefined): RoomBridgeInfo | null {
  if (!bridge) return null;
  return {
    visibility: bridgedRoomFraming(bridge).visibility,
    platformTitle: bridge.platformTitle,
  };
}

/** Rows in, what a reader is handed out. */
export class RoomProjection {
  private readonly reactions: ReactionStore;
  private readonly attachments: AttachmentRowStore;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  private readonly triggers: RoomTriggerDispatcher;

  constructor(core: RoomCore) {
    this.reactions = core.reactions;
    this.attachments = core.attachments;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.triggers = core.triggers;
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
  withRollups(roomId: string, entries: RoomEntry[]): RoomEntry[] {
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
  withRoster(room: Room, viewerAuthorId: string): RoomWithRoster {
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
      // Here for the same reason `reactionFrequents` is, and it buys more: this
      // one method feeds the room read, the create response AND the stream's
      // hydration snapshot, so every way of arriving at a room arrives with its
      // working rows already drawn. Presence was ephemeral-only before, which
      // meant a room opened mid-turn showed nothing until the dispatcher's next
      // republish — up to ten seconds of a room that looked idle while an agent
      // was working in it. A live read of the claim map, so it costs no query.
      workingAgents: this.triggers.workingIn(room.id),
      ...(bridge ? { deliverNotices: bridge.deliverNotices } : {}),
      bridge: bridgeInfo(bridge),
    };
  }
}
