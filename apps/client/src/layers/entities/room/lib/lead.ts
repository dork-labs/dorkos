/**
 * Who leads a channel: the agent member that answers a person's message nobody
 * else is answering (DOR-2823).
 *
 * @module entities/room/lib/lead
 */
import type { RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';

/** The least a room has to carry for its lead to be resolved. */
export type RoomLeadInput = Pick<RoomWithRoster, 'kind' | 'members'> & {
  leadAuthorId?: string | null;
  bridge?: RoomWithRoster['bridge'];
};

/**
 * The roster entry of the room's lead, or `null` when it has none.
 *
 * **Resolved against the roster, never trusted on its own.** The id is only a
 * lead while it names an agent who is still a member here: a lead that has just
 * been taken out of the room, or a stale id in a cached read, draws nothing
 * rather than a name nobody can find in the list below it. A direct message has
 * no lead at all — its one agent answers everything said there anyway. Nor
 * does a channel connected to an outside chat: its agent answers @mentions
 * only, so a lead id left over from before it was connected answers nothing.
 *
 * @param room - The room, with its roster read.
 */
export function roomLead(room: RoomLeadInput): RoomRosterEntry | null {
  if (room.kind !== 'channel') return null;
  if (room.bridge != null) return null;
  const id = room.leadAuthorId ?? null;
  if (id === null) return null;
  return (
    room.members.find((member) => member.authorId === id && member.author.kind === 'agent') ?? null
  );
}

/**
 * The members a channel's lead may be chosen from: its agents, retired ones
 * excepted.
 *
 * A retired agent answers nothing (DOR-2095), so offering it as the one that
 * answers when nobody else does would offer a silence.
 *
 * @param members - The room's roster.
 */
export function leadCandidates(members: readonly RoomRosterEntry[]): RoomRosterEntry[] {
  return members.filter(
    (member) => member.author.kind === 'agent' && member.author.retired !== true
  );
}
