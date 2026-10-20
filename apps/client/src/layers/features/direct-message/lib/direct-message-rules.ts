/**
 * The pure rules behind the DM view (DOR-3074): which face of an agent's
 * Direct chat is on screen, which channels the person and the agent share, and
 * what an agent's card says about it right now.
 *
 * @module features/direct-message/lib/direct-message-rules
 */
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { MemberRoom, TeamAgentActivity } from '@dorkos/shared/team-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';

/**
 * How a chat is drawn.
 *
 * - `off` — as a session, exactly as before: the experiment is off, or this
 *   chat is not an agent's Direct chat.
 * - `dm` — as a direct message with the agent.
 * - `session` — as the working session behind that DM, asked for by the
 *   `?view=session` param.
 */
export type DirectMessageMode = 'off' | 'dm' | 'session';

/**
 * Decide how a chat is drawn.
 *
 * @param input.enabled - Whether the DM view experiment is on.
 * @param input.isDirect - Whether this chat is an agent's Direct chat.
 * @param input.view - The route's `view` param.
 */
export function directMessageMode(input: {
  enabled: boolean;
  isDirect: boolean;
  view?: 'session';
}): DirectMessageMode {
  if (!input.enabled || !input.isDirect) return 'off';
  return input.view === 'session' ? 'session' : 'dm';
}

/** A channel the person and an agent are both in, ready to link to. */
export interface SharedChannel {
  /** The room id, what the link opens. */
  id: string;
  /** How it reads: `#slug`, or the title when it has none. */
  label: string;
}

/** How many shared channels the DM header names before it counts the rest. */
export const SHARED_CHANNELS_VISIBLE = 3;

/**
 * The channels the person and the agent are both in, newest activity first.
 *
 * The agent's side is its roster rooms (`GET /api/team/:id/rooms`). The
 * person's side is every room listed with an unread count, because only a
 * member has a read cursor: the owner can SEE rooms they are not in, and a
 * channel they never joined is not one they share. Direct messages are left
 * out, and so is the DM under this chat.
 *
 * @param agentRooms - The agent's rooms, newest activity first.
 * @param viewerRooms - The rooms this person can see.
 * @param exclude - A room id never to list (the DM itself).
 */
export function sharedChannels(
  agentRooms: readonly MemberRoom[] | undefined,
  viewerRooms: readonly RoomSummary[] | undefined,
  exclude?: string | null
): SharedChannel[] {
  if (!agentRooms || !viewerRooms) return [];
  const viewerIn = new Set(
    viewerRooms
      .filter((room) => room.kind === 'channel' && !room.archived && room.unreadCount !== null)
      .map((room) => room.id)
  );
  return agentRooms
    .filter((room) => room.kind === 'channel' && room.id !== exclude && viewerIn.has(room.id))
    .map((room) => ({ id: room.id, label: room.slug ? `#${room.slug}` : room.name }));
}

/**
 * Split the shared channels into the ones named and the count of the rest.
 *
 * @param channels - Every shared channel, in order.
 * @param max - How many to name.
 */
export function splitSharedChannels(
  channels: readonly SharedChannel[],
  max: number = SHARED_CHANNELS_VISIBLE
): { visible: SharedChannel[]; more: number } {
  return { visible: channels.slice(0, max), more: Math.max(0, channels.length - max) };
}

/**
 * The one line an agent's card says about what it is doing.
 *
 * Working in a room names the room, the way the app names it everywhere else
 * (`#slug` for a channel) when the caller can, else as the roster named it.
 * Otherwise the last time it did anything, when that is known. An agent that
 * has never run says nothing, rather than a line about nothing.
 *
 * @param activity - The roster's account of the agent, or undefined when the
 *   roster has not answered.
 * @param labelFor - How this client names a room by id, when it knows it.
 */
export function agentStatusLine(
  activity: TeamAgentActivity | undefined,
  labelFor?: (roomId: string) => string | undefined
): string | null {
  if (!activity) return null;
  if (activity.working) {
    const room = labelFor?.(activity.working.roomId) ?? activity.working.roomName;
    return room ? `Working in ${room}` : 'Working';
  }
  if (activity.lastActiveAt) {
    const ago = formatRelativeTime(activity.lastActiveAt);
    // Mid-sentence, so "Just now" and "Yesterday" drop their capital; a day or
    // a month name keeps its own.
    const said = /^(Just now|Yesterday)/.test(ago) ? ago[0]!.toLowerCase() + ago.slice(1) : ago;
    return `Idle · last active ${said}`;
  }
  return null;
}
