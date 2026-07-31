/**
 * Buzz's nouns, projected onto the port's.
 *
 * Every function here is total and pure: an event in, a port DTO out, no I/O and
 * no cache. Three of the projections lose something Buzz has, and each loss is
 * argued at the function rather than left for a reader to discover from a
 * surprising value.
 *
 * @module server/services/communities/buzz/buzz-projection
 */
import type {
  CommunityCursor,
  CommunityEntry,
  CommunityMember,
  CommunityRef,
  CommunityRoleDescriptor,
  CommunityRoom,
} from '@dorkos/shared/community-adapter';
import type { AuthorKind, RoomKind } from '@dorkos/shared/room-schemas';
import { mintBuzzCursor, type BuzzPosition } from './buzz-cursor.js';
import { hasMarker, tagValue, threadTags, type NostrEvent } from './buzz-protocol.js';

/**
 * Buzz's five channel roles (`crates/buzz-core/src/channel.rs:108-120`).
 *
 * `bot` declares `administers: false` and no rank, which is Buzz's own position:
 * their git policy layer says Bot is "a designation (what it is), not a
 * permission tier (what it can do)". It is also the counter-example the port
 * cites for having no role ordering, and it survives contact with the real
 * vocabulary — which is the whole point of building this adapter.
 */
export const BUZZ_ROLES: CommunityRoleDescriptor[] = [
  { id: 'owner', label: 'Owner', administers: true, isOwner: true },
  { id: 'admin', label: 'Admin', administers: true },
  { id: 'member', label: 'Member', administers: false },
  { id: 'guest', label: 'Guest', administers: false },
  { id: 'bot', label: 'Bot', administers: false },
];

/** The declared role ids, for rejecting anything a relay invents. */
const ROLE_IDS = new Set(BUZZ_ROLES.map((role) => role.id));

/**
 * Project a relay-signed kind-39000 channel metadata event onto a room.
 *
 * **Three fields are weaker than they look, and say so here rather than in a bug
 * report.**
 *
 * - `slug` is always `null`. Buzz addresses a channel by a UUID and its `name` is
 *   freely editable with no uniqueness constraint
 *   (`handlers/side_effects.rs:1398-1410`), so there is no slug to report. That
 *   is what `roomAddressing: 'opaque-id'` declares.
 * - `createdAt` is the metadata event's own timestamp, not the channel's birth.
 *   Buzz re-signs 39000 on every metadata and membership change
 *   (`side_effects.rs:999-1108`), and puts no creation time in the tag set, so
 *   this is the oldest honest answer available on the wire.
 * - `lastActivityAt` is the same value for the same reason: the metadata event
 *   is the newest fact this projection has been handed. A caller sorting a
 *   cross-community list on it gets Buzz rooms ordered by metadata recency, not
 *   by conversation. Reporting the newest message instead would cost one query
 *   per room per listing, and inventing a value would be worse than an honest
 *   coarse one.
 *
 * @param community - The community this room belongs to.
 * @param event - The kind-39000 event.
 */
export function toCommunityRoom(community: CommunityRef, event: NostrEvent): CommunityRoom | null {
  const roomId = tagValue(event, 'd');
  if (!roomId) return null;
  const timestamp = toIso(event.created_at);
  return {
    community,
    roomId,
    kind: toRoomKind(tagValue(event, 't')),
    title: tagValue(event, 'name') || roomId,
    slug: null,
    topic: tagValue(event, 'topic') ?? tagValue(event, 'about') ?? null,
    archived: hasMarker(event, 'archived'),
    createdAt: timestamp,
    lastActivityAt: timestamp,
    // `readCursor: 'none'` — there is no cursor to count against, and `null`
    // means "not applicable here", never "nothing unread".
    unreadCount: null,
  };
}

/**
 * Project a kind-9 channel message onto an entry.
 *
 * **Ancestry comes from the NIP-10 marked form only.** Buzz's ingest establishes
 * a parent from a tag only when it carries a marker (`ingest.rs:563-597`), so an
 * unmarked `e` tag never made this event a reply on the way in and must not make
 * it one on the way out. A tag marked `reply` with no `root` beside it is its own
 * root, which is Buzz's own rule (`ingest.rs:597-601`).
 *
 * `depth` is reported as `0` for a top-level entry and `1` for anything with an
 * ancestor, because the wire does not carry the depth column Buzz keeps
 * server-side (`crates/buzz-db/src/thread.rs:19-42`). Under
 * `threadDepth: 'unbounded'` that is a floor, not a claim of one-level nesting:
 * the ancestry itself — `parentEntryId` distinct from `threadRootEntryId` — is
 * what carries the shape, and it is preserved exactly.
 *
 * @param community - The community this entry belongs to.
 * @param roomId - The room it was read from.
 * @param event - The kind-9 event.
 * @param cursor - The cursor that resumes after it, minted by the caller that
 *   knows the emission order.
 */
export function toCommunityEntry(
  community: CommunityRef,
  roomId: string,
  event: NostrEvent,
  cursor: CommunityCursor
): CommunityEntry {
  const marked = threadTags(event).filter((tag) => tag.marker === 'root' || tag.marker === 'reply');
  const root = marked.find((tag) => tag.marker === 'root');
  const reply = marked.find((tag) => tag.marker === 'reply');
  const parentEntryId = reply?.eventId ?? root?.eventId ?? null;
  const threadRootEntryId = root?.eventId ?? reply?.eventId ?? null;

  return {
    community,
    roomId,
    id: event.id,
    authorId: event.pubkey,
    text: event.content,
    // Buzz carries mentions as `p` tags on the message.
    mentions: event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1]!),
    parentEntryId,
    threadRootEntryId,
    depth: threadRootEntryId === null ? 0 : 1,
    cursor,
    createdAt: toIso(event.created_at),
  };
}

/**
 * Project a relay-signed kind-39002 roster event onto its members.
 *
 * The tags are the NIP-29 `["p", pubkey, relay_url, role]` form, with an empty
 * relay URL because the canonical relay is the signer
 * (`side_effects.rs:1092-1107`).
 *
 * **`displayName` is derived from the pubkey, not fetched.** A person's name
 * lives in a separate kind-0 profile event, and resolving one per member would
 * turn every roster read into N round trips for a render cache. An abbreviated
 * key is what a Nostr client shows before profiles load, and it is honest about
 * being an identifier rather than a name.
 *
 * **`joinedAt` is the roster event's timestamp.** Buzz does not put a per-member
 * join time in the tag set, so this is when the relay last re-signed the roster —
 * the same shape of approximation `createdAt` makes on a room, and stated for the
 * same reason.
 *
 * @param community - The community these members belong to.
 * @param event - The kind-39002 event.
 */
export function toCommunityMembers(community: CommunityRef, event: NostrEvent): CommunityMember[] {
  const joinedAt = toIso(event.created_at);
  const members: CommunityMember[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'p' || !tag[1]) continue;
    const role = tag[3] && ROLE_IDS.has(tag[3]) ? tag[3] : 'member';
    members.push({
      community,
      memberId: tag[1],
      kind: toAuthorKind(role),
      displayName: abbreviate(tag[1]),
      role,
      // Buzz's NIP-OA owner attestation binds an agent key to the human key that
      // vouches for it, but the proof rides the AUTH handshake, not the roster —
      // so a roster row cannot say who vouched for it, and guessing would be
      // worse than `null`. `agentAdmission: 'none'` declares the same thing.
      ownerMemberId: null,
      joinedAt,
    });
  }
  return members;
}

/**
 * Mint the cursor for an entry at a position.
 *
 * A convenience over {@link mintBuzzCursor} so a caller projecting a page does
 * not have to reach for two modules.
 *
 * @param community - The community the entry belongs to.
 * @param roomId - The room the entry belongs to.
 * @param position - The position the cursor resumes after.
 */
export function cursorFor(
  community: CommunityRef,
  roomId: string,
  position: BuzzPosition
): CommunityCursor {
  return mintBuzzCursor(community, roomId, position);
}

/**
 * Buzz's channel type, as a room kind.
 *
 * `forum` and `workflow` are channels: both hold a conversation many people can
 * read, which is the whole of what `'channel'` means here. Collapsing them loses
 * nothing the port models.
 *
 * @param channelType - The `t` tag's value.
 */
function toRoomKind(channelType: string | undefined): RoomKind {
  return channelType === 'dm' ? 'dm' : 'channel';
}

/**
 * A member's author kind, from its role.
 *
 * `bot` is Buzz's own marker for a non-human participant, which is exactly the
 * distinction `AuthorKind` draws. Nothing on a Buzz roster is `'system'` — that
 * is a room's own voice, and a relay has none.
 *
 * @param role - The declared role id.
 */
function toAuthorKind(role: string): AuthorKind {
  return role === 'bot' ? 'agent' : 'human';
}

/**
 * Abbreviate a pubkey for display: first and last four hex characters.
 *
 * @param pubkey - The 64-character hex key.
 */
function abbreviate(pubkey: string): string {
  return pubkey.length <= 12 ? pubkey : `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

/**
 * Unix seconds as an ISO 8601 string.
 *
 * @param seconds - Unix seconds.
 */
function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
