/**
 * An agent's direct message IS its row: which direct messages are an agent's
 * Direct chat, and what that agent's row says about it.
 *
 * A one-to-one direct message with an agent is that agent's Direct chat (rule
 * S12, DOR-2997): the room keeps the log, and the agent's standing chat is what
 * opens. So the Direct messages section draws the AGENT — its face, its name,
 * its menu, its live state — in the room's place, and pressing it opens the
 * Direct chat. One row per agent, and never a second one for its sessions.
 *
 * A direct message with more than one agent, with a person, or with an agent no
 * longer on the fleet stays a room row: there is no agent row that could stand
 * for it, and taking a conversation off the panel with nothing left standing
 * for it is the one thing this rule must never do.
 *
 * @module features/dashboard-sidebar/model/rules/agent-direct-messages
 */
import { agentAuthorRef, oneToOneDmAgentRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarUnread } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import type { MuteIndex } from './apply-mute-rules';
import { deriveUnreadSignal } from './derive-unread-signal';

/** Both answers the sections need about agents' direct messages. */
export interface AgentDmIndex {
  /**
   * Each agent's one-to-one direct message, by agent path.
   *
   * **One agent cannot have two of these.** The server matches a direct
   * message on its exact member set and answers with the room that already
   * exists, so {operator, Ana} is one room on this machine; the first one wins
   * only because a map has to pick.
   */
  roomByAgentPath: ReadonlyMap<string, RoomSummary>;
  /**
   * What each agent's direct message has for the operator, by agent path —
   * what the agent's row draws wherever it is filed.
   *
   * Only rooms with something to say are in it. The signal is the room's own
   * ({@link deriveUnreadSignal} over a DM, so it is directed by nature), which
   * is what makes the agent row's count and the badge the room would have
   * drawn one fact rather than two.
   */
  unreadByAgentPath: ReadonlyMap<string, SidebarUnread>;
  /** The agent whose row stands for this room, or `null` when none does. */
  agentPathOf: (room: RoomSummary) => string | null;
}

/**
 * Judge every live room once, and answer all three questions off that pass.
 *
 * One index rather than three predicates, because every reader needs the same
 * agent-handle map and hashing the fleet per row is what the model's rebuild
 * budget is spent on.
 *
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets. Muting the conversation silences the
 *   count exactly as it silenced the room, and an @mention still pierces.
 */
export function indexAgentDms(state: SidebarState, mutes: MuteIndex): AgentDmIndex {
  const pathByRef = new Map(state.agents.map((agent) => [agentAuthorRef(agent.path), agent.path]));
  const roomByAgentPath = new Map<string, RoomSummary>();
  const agentByRoom = new Map<string, string>();
  const unreadByAgentPath = new Map<string, SidebarUnread>();
  for (const room of state.rooms) {
    if (room.archived) continue;
    const ref = oneToOneDmAgentRef(room);
    const path = ref === null ? undefined : pathByRef.get(ref);
    if (path === undefined || roomByAgentPath.has(path)) continue;
    roomByAgentPath.set(path, room);
    agentByRoom.set(room.id, path);
    const signal = deriveUnreadSignal({
      unreadCount: room.unreadCount,
      directed: true,
      mentionCount: state.mentions[room.id],
      muted: mutes.rooms.has(room.id) || mutes.agents.has(path),
    });
    if (signal.tier !== 'none') unreadByAgentPath.set(path, signal);
  }
  return {
    roomByAgentPath,
    unreadByAgentPath,
    agentPathOf: (room) => agentByRoom.get(room.id) ?? null,
  };
}
