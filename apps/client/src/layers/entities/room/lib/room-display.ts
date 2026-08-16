/**
 * Pure display helpers for rooms and the people in them.
 *
 * @module entities/room/lib/room-display
 */
import type { AuthorRef, Room, RoomRosterEntry, RoomSummary } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';

/** A room object with just enough on it to render a title. */
type TitleableRoom = Pick<Room, 'kind' | 'slug' | 'title'>;

/**
 * A room's bare name, with no mark in front of it.
 *
 * This is the form to render wherever a {@link RoomAvatar} sits beside the name
 * — the mark already draws the `#`, and printing it again gives you `# #general`.
 * Anywhere the name stands alone in text, use {@link roomDisplayTitle}.
 *
 * @param room - The room to name.
 */
export function roomName(room: TitleableRoom): string {
  if (room.kind === 'channel' && room.slug) return room.slug;
  return room.title;
}

/**
 * What a room is called in prose — a tooltip, an `aria-label`, a toast, the
 * browser tab.
 *
 * A channel reads as its `#slug`, because that is the name people type and the
 * one the server enforces as unique. Everything else reads as its title.
 *
 * @param room - The room to name.
 */
export function roomDisplayTitle(room: TitleableRoom): string {
  const name = roomName(room);
  return room.kind === 'channel' && room.slug ? `#${name}` : name;
}

/**
 * How many participants a group conversation names before it starts counting.
 * Three fits a sidebar row; the fourth is what would truncate mid-word.
 */
const NAMED_PARTICIPANTS = 3;

/**
 * What to call a direct message, from the people in it.
 *
 * One name is a one-to-one. Beyond that it reads as a list, and past
 * {@link NAMED_PARTICIPANTS} it names the first few and counts the rest — a
 * sidebar row is one line, and a title long enough to need an ellipsis tells a
 * reader less than "and 3 others" does.
 *
 * A title is a label, not an identity: the server matches a conversation on its
 * member set (`RoomService.createRoom`), so renaming one later never splits it
 * and two DMs can share a name without confusing anything but a person.
 *
 * **The title does not follow the roster.** It is written once, when the
 * conversation is opened, and `POST /api/rooms/:id/members` has shipped since
 * R1 — so a room called `Ana` can already hold three agents, and this function
 * is never re-run to notice. Keeping the roster and the title in step is R6b's,
 * where adding an agent to a room becomes something the cockpit can do.
 *
 * @param names - The participants' display names, in the order they were picked.
 * @returns The title, or an empty string for no names — which the caller should
 *   never reach, because a conversation with nobody in it is not one.
 */
export function directMessageTitle(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= NAMED_PARTICIPANTS) {
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  const rest = names.length - NAMED_PARTICIPANTS;
  return `${names.slice(0, NAMED_PARTICIPANTS).join(', ')} and ${rest} ${
    rest === 1 ? 'other' : 'others'
  }`;
}

/**
 * Who a direct message is with.
 *
 * A DM holds the operator and one or more agents, and this answers with the
 * first agent on the roster — picked by `kind` rather than by position, because
 * matching on a rendered name never was a promise.
 *
 * "The first agent" is only an answer because the server orders a roster
 * deterministically (`RoomStore.listMembers`): oldest membership first, author
 * id breaking the tie that every seeded roster has. Nothing here re-sorts, so
 * the sidebar and the open room's header name the same agent.
 *
 * **This is the fallback path, not the one the sidebar walks.** `RoomAvatar`
 * prefers the resolved faces its caller hands it, which draw a group
 * conversation as a stack rather than as its first member (sidebar-groups,
 * DOR-580). This answers the single counterpart for a caller that has resolved
 * nothing — which then gets a letter, because the emoji on an `AuthorRef` is a
 * server-side render cache that is empty for any agent without a stored one.
 *
 * @param participants - The DM's roster, as `RoomSummary.participants` carries
 *   it. `null` (a channel, or a payload that predates the field) and a roster
 *   with no agent on it both answer `null`, which is the caller's cue
 *   to fall back to the room itself.
 */
export function dmCounterpart(
  participants: readonly AuthorRef[] | null | undefined
): AuthorRef | null {
  return participants?.find((author) => author.kind === 'agent') ?? null;
}

/**
 * The color that stands for one participant, everywhere.
 *
 * Hashed from the opaque author id, so an author reads as the same color in
 * every room and across reloads without the server having to pick one.
 *
 * @param authorId - The author's opaque id.
 */
export function authorColor(authorId: string): string {
  return hashToHslColor(authorId);
}

/**
 * Whether an unread badge should be drawn for a room.
 *
 * `unreadCount` is `null` when the caller is not a member of the room, which is
 * "not applicable" and not zero. Collapsing the two would badge every room the
 * operator has only ever looked at.
 *
 * @param room - The room summary from the list.
 */
export function hasUnread(room: RoomSummary): boolean {
  return room.unreadCount !== null && room.unreadCount > 0;
}

/**
 * Whether an author sits on a room's roster right now.
 *
 * The one check every "can this reader write here" gate needs — the composer
 * (`RoomComposer`), a message's reactions and its thread panel all read a room
 * they may not be a member of (the owner sees every room on the install,
 * DOR-1233), and posting or reacting is `MEMBER_NOT_FOUND` for a non-member on
 * the server regardless of what the client offers. One function so all three
 * ask the roster the same way, rather than each re-deriving it from whichever
 * proxy happens to be in scope (`unreadCount`, `lastReadSeq`, …).
 *
 * @param members - The room's roster, as `RoomWithRoster` carries it.
 * @param viewerAuthorId - The caller's own author id, as the server resolved it.
 */
export function isRoomMember(
  members: readonly Pick<RoomRosterEntry, 'author'>[],
  viewerAuthorId: string
): boolean {
  return members.some((member) => member.author.id === viewerAuthorId);
}

/** Proper names for the platforms a bridged room or member can come from. */
const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
};

/**
 * What to call a platform in prose — the second half of an origin mark
 * ("Miguel · Telegram") and a bridge badge's expanded copy.
 *
 * Capitalizes anything not in the known list rather than showing a raw
 * lowercase identifier, so a platform this client does not recognize yet
 * still reads as a proper name and not as internal plumbing.
 *
 * @param platform - The origin's `platform` string, e.g. `'telegram'`.
 */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}
