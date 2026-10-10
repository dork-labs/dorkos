/**
 * The quiet line over a channel's composer when no agent is in it (DOR-2823).
 *
 * @module widgets/room-view/ui/NoAgentHint
 */
import type { RoomWithRoster } from '@/layers/entities/room';

/** What {@link NoAgentHint} needs to decide whether it has anything to say. */
export interface NoAgentHintProps {
  /** The room on screen, with its roster read. */
  room: RoomWithRoster;
  /** Whether the room has any messages yet. An empty room's own empty state already says this. */
  hasEntries: boolean;
  /** Open the room panel's agent picker, the same one the empty state opens. */
  onAddAgents: () => void;
}

/**
 * Whether a room should show the "no agent is in this channel" hint.
 *
 * Only a local channel a person can post in, with no agent on its roster. A
 * direct message always has its agent, and a channel bridged to an outside chat
 * answers on that platform's terms. A Community room never reaches this
 * surface: it renders through `RemoteCommunitySurface`.
 *
 * @param room - The room on screen.
 */
export function showsNoAgentHint(room: RoomWithRoster): boolean {
  if (room.kind !== 'channel') return false;
  if (room.bridge != null) return false;
  if (room.archived) return false;
  return !room.members.some((member) => member.author.kind === 'agent');
}

/**
 * Say why nothing answers in a channel with no agent in it.
 *
 * **Shown by the app, never written into the room.** The server used to store
 * this as a notice under a person's message, and a stored line bumped unread
 * counts in channels where people only talk among themselves. Here it is a
 * property of the roster, so it goes the moment an agent joins and costs
 * nobody a badge. The server still logs why nobody was picked.
 *
 * @param props - The room, whether it has messages, and the add-agents action.
 */
export function NoAgentHint({ room, hasEntries, onAddAgents }: NoAgentHintProps) {
  if (!hasEntries || !showsNoAgentHint(room)) return null;
  return (
    <p className="text-muted-foreground shrink-0 px-4 pb-1 text-xs" data-testid="no-agent-hint">
      No agent is in this channel to answer.{' '}
      <button
        type="button"
        onClick={onAddAgents}
        className="text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        Add one
      </button>{' '}
      to get answers here.
    </p>
  );
}
