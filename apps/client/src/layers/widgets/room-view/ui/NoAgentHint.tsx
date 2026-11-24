/**
 * The quiet line over a conversation's composer when nobody in it will answer:
 * a channel with no agent in it (DOR-2823), or a direct message whose every
 * agent has left the team (DOR-2365).
 *
 * @module widgets/room-view/ui/NoAgentHint
 */
import type { RoomRosterEntry, RoomWithRoster } from '@/layers/entities/room';

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
 * channel bridged to an outside chat answers on that platform's terms. A
 * Community room never reaches this surface: it renders through
 * `RemoteCommunitySurface`. A direct message has its own line
 * ({@link retiredDirectMessageAgents}).
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
 * The agents of a direct message none of which will answer, or `null` when one
 * of them still can.
 *
 * A direct message keeps an agent that was unregistered, drawn as retired
 * (DOR-2095), because the conversation is named by who is in it. When every
 * agent in it is retired, a message posted there reaches nobody, and the only
 * word about it used to arrive after the person had already written one.
 *
 * @param room - The room on screen.
 */
export function retiredDirectMessageAgents(room: RoomWithRoster): RoomRosterEntry[] | null {
  if (room.kind !== 'dm' || room.archived) return null;
  const agents = room.members.filter((member) => member.author.kind === 'agent');
  if (agents.length === 0) return null;
  return agents.every((member) => member.author.retired === true) ? agents : null;
}

/** The "Add …" link both lines end on. */
function AddAgentLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      {label}
    </button>
  );
}

const HINT_CLASS = 'text-muted-foreground shrink-0 px-4 pb-1 text-xs';

/**
 * Say why nothing answers in a channel with no agent in it, or in a direct
 * message whose agents have all left the team.
 *
 * **Shown by the app, never written into the room.** The server used to store
 * this as a notice under a person's message, and a stored line bumped unread
 * counts in channels where people only talk among themselves. Here it is a
 * property of the roster, so it goes the moment an agent joins and costs
 * nobody a badge. The server still logs why nobody was picked.
 *
 * The direct-message line shows whether or not the conversation has messages
 * yet: the empty state there invites the person to say something, which is the
 * wrong advice when nobody is left to read it. The composer and the history
 * both stay; adding an agent brings the answers back.
 *
 * @param props - The room, whether it has messages, and the add-agents action.
 */
export function NoAgentHint({ room, hasEntries, onAddAgents }: NoAgentHintProps) {
  const retired = retiredDirectMessageAgents(room);
  if (retired !== null) {
    const [only] = retired;
    const who = retired.length === 1 && only ? only.author.displayName : 'These agents';
    return (
      // `break-words`: an agent's name is whatever it was given, and a long one
      // must wrap on a phone rather than push the line off the screen.
      <p className={`${HINT_CLASS} break-words`} data-testid="no-agent-hint">
        {who} {retired.length === 1 ? 'is' : 'are'} no longer on your team.{' '}
        <AddAgentLink onClick={onAddAgents} label="Add an agent" /> to get answers.
      </p>
    );
  }
  if (!hasEntries || !showsNoAgentHint(room)) return null;
  return (
    <p className={HINT_CLASS} data-testid="no-agent-hint">
      No agent is in this channel to answer. <AddAgentLink onClick={onAddAgents} label="Add one" />{' '}
      to get answers here.
    </p>
  );
}
