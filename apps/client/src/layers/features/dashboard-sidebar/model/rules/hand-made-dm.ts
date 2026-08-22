/**
 * One door to an agent: which direct messages are a session in disguise, and
 * what the agent's own row says about them (`sidebar-simplification` D2).
 *
 * A 1:1 direct message with an agent runs in that agent's own directory on that
 * agent's own runtime, and its log holds the agent's final words and none of its
 * work. It was the same conversation the agent's row opens, listed a second time
 * under a second name — so Library stops listing it, and the agent's row carries
 * whatever it had to say.
 *
 * Nothing is archived, moved or migrated: these rooms simply stop being drawn in
 * Direct messages.
 *
 * **The whole way back to one of these rooms, because taking a row away is only
 * safe if the rest of it holds:**
 *
 * 1. **Today**, whenever it has something for the operator. A room they have
 *    been in is eligible by the ordinary interaction rule; one they have never
 *    opened — the line an agent started itself — is eligible on its directed
 *    unread alone (`select-today-items.ts`, reason `today:dm-suppressed-unread`).
 *    That row is the room's own row, so clicking it opens the conversation, not
 *    the session.
 * 2. **A notification**, for the same message, through the one notification
 *    system (DOR-1388) — which is what reaches somebody who is not looking at
 *    the panel at all.
 * 3. **The agent's row carries a dot** while its suppressed DM has a directed
 *    unread. A secondary signal on purpose: clicking the agent still opens its
 *    session, because that is the one door. The dot says "there is something
 *    over here"; Today is where it is.
 * 4. **⌘K and the agent's profile** find it any time, unread or not.
 *
 * Every step but the last is gated on the unread, so a read conversation goes
 * quiet everywhere at once rather than lingering in one surface.
 *
 * @module features/dashboard-sidebar/model/rules/hand-made-dm
 */
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarUnread } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import type { MuteIndex } from './apply-mute-rules';
import { deriveUnreadSignal } from './derive-unread-signal';

/** How many people a one-to-one holds: the operator, and the one agent. */
const ONE_TO_ONE_ROSTER_SIZE = 2;

/**
 * The stable handle of the one agent a hand-made 1:1 direct message is with, or
 * `null` when this room is not one.
 *
 * Three things must all be true, and each rules out a room that is genuinely a
 * second place rather than a second door:
 *
 * - **It is a direct message.** A channel is a room whatever its roster.
 * - **Its roster is one agent and the operator, and nobody else.** Two agents is
 *   a group message — a conversation with no session behind it.
 * - **It is not bridged.** A bridged private chat is a Telegram or Slack chat
 *   projected in; its other end is a person somewhere else, and there is no
 *   session that is the same conversation. It keeps its row.
 *
 * An agent that opened the line itself (`relay_notify_user`) is this same shape
 * and follows the same rule, on purpose: the point is that the agent already has
 * a row, not that the operator started it.
 *
 * @param room - The room to judge.
 */
export function oneToOneDmAgentRef(room: RoomSummary): string | null {
  if (room.kind !== 'dm') return null;
  // Absent and `null` both mean "not bridged" — `GET /api/rooms` resolves this
  // field for every room it lists, and a fixture that omits it is describing an
  // ordinary room.
  if (room.bridge != null) return null;
  const roster = room.participants;
  if (roster == null || roster.length !== ONE_TO_ONE_ROSTER_SIZE) return null;
  const agents = roster.filter((author) => author.kind === 'agent');
  const people = roster.filter((author) => author.kind === 'human');
  if (agents.length !== 1 || people.length !== 1) return null;
  return agents[0].agentRef ?? null;
}

/**
 * Agent `projectPath` by the handle a roster names it with — one hash per agent,
 * built once per rebuild.
 *
 * @param state - The snapshot.
 */
function pathByAgentRef(state: SidebarState): Map<string, string> {
  return new Map(state.agents.map((agent) => [agentAuthorRef(agent.path), agent.path]));
}

/**
 * The agent whose row stands for this direct message, or `null` when no row
 * does.
 *
 * **A DM whose agent is not on the fleet keeps its row.** The suppression is a
 * trade — one list instead of two — and it is only a trade while the surviving
 * list holds the conversation. An agent that has been unregistered has no row to
 * carry the dot, so hiding its line would be the one thing this rule must never
 * do: take a conversation off the panel with nothing left standing for it.
 *
 * @param room - The room to judge.
 * @param byRef - Agent paths by handle, from {@link pathByAgentRef}.
 */
function suppressedDmAgentPath(
  room: RoomSummary,
  byRef: ReadonlyMap<string, string>
): string | null {
  const ref = oneToOneDmAgentRef(room);
  return ref === null ? null : (byRef.get(ref) ?? null);
}

/** Both answers Library needs about hand-made 1:1 direct messages. */
export interface SuppressedDmIndex {
  /**
   * What each agent's suppressed 1:1 direct message has for the operator, by
   * agent path — the dot the agent's row draws instead of a row of its own.
   *
   * Only rooms with something to say are in it: an agent absent from the map has
   * nothing waiting. The signal is the room's own ({@link deriveUnreadSignal}
   * over a DM, so it is directed by nature), which is what makes the dot on the
   * row and the badge the room would have drawn one fact rather than two
   * derivations of it.
   */
  unreadByAgentPath: ReadonlyMap<string, SidebarUnread>;
  /** Whether Library's Direct messages section leaves this room out. */
  isSuppressed: (room: RoomSummary) => boolean;
}

/**
 * Judge every room once, and answer both questions off that one pass.
 *
 * One index rather than two predicates, because both readers need the same
 * agent-handle map and hashing the fleet per row is what the model's rebuild
 * budget is spent on (G8).
 *
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets. Muting the conversation silences the
 *   dot exactly as it silenced the row (BC-40), and an `@mention` still pierces.
 */
export function indexSuppressedDms(state: SidebarState, mutes: MuteIndex): SuppressedDmIndex {
  const byRef = pathByAgentRef(state);
  const suppressed = new Set<string>();
  const unreadByAgentPath = new Map<string, SidebarUnread>();
  for (const room of state.rooms) {
    const path = suppressedDmAgentPath(room, byRef);
    if (path === null) continue;
    suppressed.add(room.id);
    // **One agent cannot have two of these, so "first one wins" never chooses.**
    // The server matches a direct message on its exact member set and answers
    // with the room that already exists (`RoomService.createRoom`), so
    // {operator, Ana} is one room on this machine. The guard is here because a
    // Map would otherwise be written twice on a wire response nobody promised
    // could not carry two — not because a rule is being applied.
    if (room.archived || unreadByAgentPath.has(path)) continue;
    const signal = deriveUnreadSignal({
      unreadCount: room.unreadCount,
      directed: true,
      mentionCount: state.mentions[room.id],
      muted: mutes.rooms.has(room.id),
    });
    if (signal.tier !== 'none') unreadByAgentPath.set(path, signal);
  }
  return { unreadByAgentPath, isSuppressed: (room) => suppressed.has(room.id) };
}
