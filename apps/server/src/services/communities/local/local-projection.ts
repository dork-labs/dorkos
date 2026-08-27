/**
 * The row-to-port projection for local rooms: `Room`, `RoomEntry` and
 * `RoomRosterEntry` as the `CommunityAdapter` speaks them.
 *
 * Kept beside the adapter rather than inside it for the reason `room-rows.ts` is
 * kept beside `room-store.ts`: one file is the behavior, the other is the
 * shapes, and interleaving them means reading a mapping table to follow a
 * stream.
 *
 * **One field is dropped on the way out, and it is deliberate.**
 * `AuthorRecord.naturalKey` — an agent's absolute directory — never leaves the
 * server at all; the roster the service hands us has already projected it away
 * through {@link toAuthorRef}, which is why nothing here has to remember to.
 *
 * `workspaceId` used to be the other one. It is gone from `Room` entirely (spec
 * `project-rooms` §3.1, DOR-1591): a room's own files are a repo under the
 * DorkOS data directory, recorded in a `room-repo.json` sidecar and cached in
 * `room_repos`, and that binding is even more local than the column it replaced
 * — an absolute path on this machine — so it never approaches this projection.
 * The decision the old note cited (spec `community-adapter` §Decisions, OQ3)
 * still holds; there is simply no longer a field to keep off the wire.
 *
 * @module server/services/communities/local/local-projection
 */
import type {
  CommunityEntry,
  CommunityMember,
  CommunityPresencePayload,
  CommunityRef,
  CommunityRoom,
  CommunityRoomEvent,
  CommunityThreadSummary,
} from '@dorkos/shared/community-adapter';
import type {
  Room,
  RoomEntry,
  RoomPresencePayload,
  RoomRosterEntry,
  RoomSignalEvent,
} from '@dorkos/shared/room-schemas';
import { mintLocalCursor } from './local-cursor.js';

/**
 * Project one room.
 *
 * @param community - The community this adapter serves.
 * @param room - The stored room.
 * @param unreadCount - How many entries the connected identity has not read, or
 *   `null` when it is not a member — the port's "not applicable here", which is
 *   exactly the semantic `RoomSummary.unreadCount` already carries. Never `0`
 *   for a room whose unread cannot be computed: a silent room and an
 *   uncomputable one are different states.
 */
export function toCommunityRoom(
  community: CommunityRef,
  room: Room,
  unreadCount: number | null
): CommunityRoom {
  return {
    community,
    roomId: room.id,
    kind: room.kind,
    title: room.title,
    slug: room.slug,
    topic: room.topic,
    archived: room.archived,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    unreadCount,
  };
}

/**
 * Project one entry.
 *
 * `depth` is derived rather than stored, and it can be: the service refuses a
 * reply whose parent is itself a reply, so an entry is either top-level or one
 * level down and there is no third case to represent. The day a later ADR opens
 * a second level, `threadDepth` stops being `1` and this derivation is what
 * changes with it.
 *
 * @param community - The community this adapter serves.
 * @param entry - The stored entry.
 * @param thread - The rolled-up thread summary, when this entry is a root that
 *   has replies.
 */
export function toCommunityEntry(
  community: CommunityRef,
  entry: RoomEntry,
  thread?: CommunityThreadSummary
): CommunityEntry {
  return {
    community,
    roomId: entry.roomId,
    id: entry.id,
    authorId: entry.authorId,
    text: entry.body.text,
    mentions: [...entry.mentions],
    parentEntryId: entry.parentEntryId,
    threadRootEntryId: entry.threadRootEntryId,
    depth: entry.threadRootEntryId === null ? 0 : 1,
    ...(thread ? { thread } : {}),
    cursor: mintLocalCursor(community, entry.roomId, entry.seq),
    createdAt: entry.createdAt,
  };
}

/**
 * Project one roster row.
 *
 * `role` is `null` for everybody and `ownerMemberId` is `null` for everybody,
 * because this backend declares `roles.supported: false` and
 * `agentAdmission: 'none'`. Neither is a placeholder waiting to be filled in:
 * one machine with one operator has nobody to rank and nobody to vouch to.
 *
 * @param community - The community this adapter serves.
 * @param member - The membership, with its author already resolved.
 */
export function toCommunityMember(
  community: CommunityRef,
  member: RoomRosterEntry
): CommunityMember {
  return {
    community,
    memberId: member.authorId,
    kind: member.author.kind,
    displayName: member.author.displayName,
    // The roster's own answer, which already accounts for a member whose agent
    // is gone: it carries a handle on its row and no longer answers to it.
    handle: member.author.handle,
    ...(member.author.emoji ? { emoji: member.author.emoji } : {}),
    ...(member.author.color ? { color: member.author.color } : {}),
    ...(member.author.imageUrl ? { imageUrl: member.author.imageUrl } : {}),
    role: null,
    responseMode: member.responseMode,
    ownerMemberId: null,
    joinedAt: member.joinedAt,
  };
}

/**
 * Project one live signal, in each direction.
 *
 * The two envelopes say the same thing with the subject in a different place:
 * the room event names the author once, at the top, while the port's frame names
 * the emitter at the top AND lets the presence payload say who the work is
 * about. Locally those are one person, so `authorId` fills both — a subscriber
 * reading only `payload.memberId` and one reading only `memberId` must not
 * disagree about who is working.
 *
 * A payload rides ONLY when the room event carries a `state`. A bare `typing`
 * signal has no lifecycle, and an empty `payload: {}` would claim a presence
 * that is not there.
 *
 * **`activity` is not carried, and that is a decision rather than an omission**
 * (ADR 260819-022127). A room's presence signal can say what the turn is doing,
 * and the target it names — a file's basename, a command's first line, a search
 * pattern — is this operator's own work. `CommunityPresencePayloadSchema` has no
 * field for one either, so a future adapter cannot start carrying it by
 * accident; a test pins the absence.
 *
 * @param event - The room's own signal frame.
 */
export function toCommunitySignal(
  event: RoomSignalEvent
): Extract<CommunityRoomEvent, { type: 'signal' }> {
  return {
    type: 'signal',
    signal: event.signal,
    memberId: event.authorId,
    at: event.at,
    ...(event.state
      ? {
          payload: {
            state: event.state,
            memberId: event.authorId,
            ...(event.entryId ? { entryId: event.entryId } : {}),
            ...(event.since ? { since: event.since } : {}),
          },
        }
      : {}),
  };
}

/**
 * Project a port presence payload onto the rooms envelope's own three fields.
 *
 * `memberId` is deliberately not among them: on the rooms side who-is-working is
 * the event's `authorId`, and carrying it twice on the wire would let the two
 * copies disagree. Neither is `activity`, inbound: a remote backend cannot claim
 * a verb this machine's claim map did not produce, which is the same
 * claim-gating gap `LocalCommunityAdapter.publishSignal` documents about itself.
 *
 * @param payload - The port's presence payload.
 */
export function toRoomPresence(payload: CommunityPresencePayload): Partial<RoomPresencePayload> {
  return {
    state: payload.state,
    ...(payload.entryId ? { entryId: payload.entryId } : {}),
    ...(payload.since ? { since: payload.since } : {}),
  };
}
