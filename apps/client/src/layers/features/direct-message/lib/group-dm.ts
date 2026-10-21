/**
 * Who a group DM's right panel can be about (DOR-3075).
 *
 * @module features/direct-message/lib/group-dm
 */
import { agentAuthorRef, oneToOneDmAgentRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/** One agent in a group DM, ready for the panel's member picker. */
export interface GroupDmMember {
  /** The member's author id in this room. */
  authorId: string;
  /** The agent's directory, which the panel's tabs are scoped by. */
  agentPath: string;
  /** The agent's name, as the room knows it. */
  displayName: string;
  /** The agent's emoji, when the room has one cached. */
  emoji?: string;
  /** The agent's colour, when the room has one cached. */
  color?: string;
}

/**
 * Whether a room is a group DM: a direct message that is not one person with
 * one agent. A bridged DM is a Telegram or Slack chat, not a group DM.
 *
 * @param room - The room on screen.
 */
export function isGroupDm(room: RoomSummary): boolean {
  return room.kind === 'dm' && room.bridge == null && oneToOneDmAgentRef(room) === null;
}

/**
 * The agents in a group DM the panel can be scoped to, in roster order.
 *
 * A roster names an agent by a handle derived from its directory, never the
 * directory itself, so each is turned back through the fleet's listing. An
 * agent the fleet does not list, and one no longer on the team, is left out:
 * there is no profile, computer or session of theirs to show.
 *
 * @param room - A group DM.
 * @param fleet - The fleet's agents, or undefined while it has not answered.
 */
export function groupDmMembers(
  room: RoomSummary,
  fleet: readonly AgentPathEntry[] | undefined
): GroupDmMember[] {
  if (!fleet || !room.participants) return [];
  const pathByRef = new Map(
    fleet.map((entry) => [agentAuthorRef(entry.projectPath), entry.projectPath])
  );
  const members: GroupDmMember[] = [];
  for (const author of room.participants) {
    if (author.kind !== 'agent' || author.retired || author.agentRef === undefined) continue;
    const agentPath = pathByRef.get(author.agentRef);
    if (agentPath === undefined) continue;
    members.push({
      authorId: author.id,
      agentPath,
      displayName: author.displayName,
      ...(author.emoji ? { emoji: author.emoji } : {}),
      ...(author.color ? { color: author.color } : {}),
    });
  }
  return members;
}
