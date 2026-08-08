/**
 * The one room every install has: **#team**, the home the cockpit opens on
 * (team-room-home spec D3.1), and the membership that decides who answers when
 * you type in it without addressing anybody (D3.4).
 *
 * The boot-time counterpart of `ensureDorkBot` — the same shape of promise
 * ("this install must have this entity") and the same discipline: idempotent,
 * safe on every boot, and never able to fail a boot. What makes it idempotent
 * is a well-known key on the room row (`rooms.well_known = 'team'`) rather than
 * the channel's name: a slug moves with a rename, and a hook keyed on one would
 * open a second #team the first time somebody renamed the first.
 *
 * **Its roster is you and your agents.** The owner is seeded when the room is
 * opened; every registered agent joins with the channel default `engaged`,
 * backfilled here at boot and added on the spot when a new agent is created
 * (the `agent-created` seam in `index.ts` calls {@link joinTeamRoom}).
 *
 * **One of them holds `always` — the room's fallback seat.** "Type in #team
 * without addressing anybody and your default agent answers" is a membership on
 * an ordinary room — no routing layer, no home-composer path on the server, and
 * nothing here that the cascade guard or the turn budget does not already bound.
 * {@link syncDefaultAgent} owns that one membership; {@link watchDefaultAgent}
 * moves it when the setting moves.
 *
 * D3.4 has a second half this file does NOT implement, and looking for it here
 * is the wrong place: neither a post that names another agent nor a reply an
 * agent writes may spend the default agent's turn. `always` alone cannot
 * express that, so `addressing.ts`'s `standDownFallbackSeat` filters the seat
 * out at dispatch. Both halves read the SAME marker — the seat this file
 * records on `rooms.fallback_seat_author_id` — so change one and read the
 * other; they are one behaviour in two places.
 *
 * **Leaving is not a thing that happens to you.** Unregistering an agent does
 * NOT drop its #team membership, and nothing here removes one: an author row is
 * retired, never deleted, so the room keeps every message that agent wrote and
 * keeps attributing it correctly. A gone agent stops being addressable
 * (`RoomRoster` reads liveness per author) and stops taking turns, which is the
 * whole of what "it left" needs to mean. Removing the row would strand its
 * history under an unknown member for the sake of a shorter roster.
 *
 * @module server/services/rooms/ensure-team-room
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { DORKBOT_AGENT_NAME } from '../mesh/ensure-dorkbot.js';
import { CHANNEL_RESPONSE_MODE } from './room-roster.js';
import type { RoomService } from './room-service.js';

/**
 * The key #team answers to for the life of the install. Never derived from the
 * slug, so renaming the channel cannot orphan it.
 */
export const TEAM_ROOM_KEY = 'team';

/** How #team is opened. Used on creation only — a later edit is the person's. */
const TEAM_ROOM_SEED = {
  slug: 'team',
  topic: 'You and every agent you run, in one place.',
} as const;

/**
 * The mode that makes one agent answer a message nobody addressed.
 *
 * Half of D3.4: "posting in #team reaches your default agent" is a membership
 * setting on an ordinary room, not a routing layer. The mode is what ADDRESSING
 * selects the seat with; it is not what identifies the seat, because a person
 * may set any agent to it. See {@link syncDefaultAgent} for what owns both.
 */
const DEFAULT_AGENT_RESPONSE_MODE: ResponseMode = 'always';

/** One registered agent, as the team room needs to see it. */
export interface TeamAgent {
  /** The agent's name — the value `config.agents.defaultAgent` names. */
  name: string;
  /** Its directory, which is how a room membership names an agent. */
  path: string;
}

/** What the team room needs from the rest of the server. */
export interface TeamRoomDeps {
  /** The wired room service. */
  service: RoomService;
  /**
   * The install owner's author id, resolved per call rather than captured: an
   * install becomes owned partway through its life (the enable-login flow), and
   * a value read at boot would leave this hook writing as a stranger afterwards.
   */
  operatorAuthorId: () => string;
  /**
   * Every registered agent. Read at boot to backfill the roster, so an install
   * that predates this hook — or one whose agents were registered while it was
   * off — still finds its whole team in the room. Read again on every
   * default-agent reconcile, because that setting names an agent by NAME and
   * only the registry can turn one into a directory.
   */
  agents: () => readonly TeamAgent[];
  /**
   * `config.agents.defaultAgent` — the agent unaddressed #team posts reach.
   * Read per call, never captured: the whole point of {@link watchDefaultAgent}
   * is that changing it in Settings takes effect without a restart.
   */
  defaultAgentName: () => string | null;
}

/**
 * Somewhere that says when settings changed. Declared here rather than imported
 * from `config-manager.ts` for the reason `runtime-registry.ts` declares its
 * own: this module needs one verb, and depending on the manager would drag the
 * whole singleton into every test that drives a room.
 */
export interface TeamRoomConfigSource {
  /**
   * Subscribe to settings writes.
   *
   * @param listener - Called with the top-level sections a write touched.
   * @returns An unsubscribe function.
   */
  onChange(listener: (change: { sections: readonly string[] }) => void): () => void;
}

/**
 * Open #team if it is not already there, make sure every registered agent is in
 * it, and point the `always` membership at the current default agent.
 *
 * Must run AFTER `ensureDorkBot`, which is what puts DorkBot in the agent
 * registry: on a fresh install DorkBot is the only agent, and joining it here is
 * what makes day one a conversation rather than an empty room.
 *
 * **Never throws.** A boot that could not open #team is an install whose home
 * tab has nothing to render, which is a degraded cockpit and not a broken
 * server — and a hook that could take the process down would make one bad room
 * row cost every other subsystem too. Each agent joins under its own guard for
 * the same reason: one unregistered directory must not cost the rest of the
 * roster.
 *
 * @param deps - The service, the owner, the agents to seat, and the default.
 * @returns The room, or `null` when it could not be opened.
 */
export function ensureTeamRoom(deps: TeamRoomDeps): Room | null {
  const room = openTeamRoom(deps);
  if (!room) return null;
  // Guarded like every other read that leaves this module: the agent registry
  // is a subsystem that can be down, and a boot must not die because it was.
  let registered: readonly TeamAgent[] = [];
  try {
    registered = deps.agents();
  } catch (err) {
    logger.warn('[Rooms] could not read the agent registry to fill the team room', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const agent of registered) {
    seatAgent(deps, room, agent.path);
  }
  syncDefaultAgent(deps, room);
  return room;
}

/**
 * Seat a newly created agent in #team, opening the room first if it somehow is
 * not there yet.
 *
 * Called from the `agent-created` seam, which every creation path funnels
 * through — the HTTP routes, the MCP `create_agent` tool, and the marketplace
 * agent install. A new agent is in your team room by the time you can look at
 * it, without a restart.
 *
 * It reconciles the default agent too, and that is not belt-and-braces: creating
 * the first real agent on an install whose configured default is missing from
 * disk ADOPTS it as the default (`agent-creator.ts`), and that settings write
 * can land before the mesh registry has the agent — so the change listener sees
 * a name it cannot resolve to a directory. This call runs after the agent is
 * seated, which is the moment the name resolves.
 *
 * Never throws, for the reason {@link ensureTeamRoom} gives: a room join is not
 * allowed to fail somebody's agent creation.
 *
 * @param deps - The service, the owner, and the default-agent setting.
 * @param agentPath - The new agent's directory.
 */
export function joinTeamRoom(deps: TeamRoomDeps, agentPath: string): void {
  const room = openTeamRoom(deps);
  if (!room) return;
  seatAgent(deps, room, agentPath);
  syncDefaultAgent(deps, room);
}

/**
 * Keep the `always` membership on whoever the default-agent setting currently
 * names, without a restart.
 *
 * The setting is the user-visible knob for "who answers when I just type", so
 * changing it in Settings has to move the membership that implements it — the
 * same reason the default-runtime setting is watched rather than read once
 * (`runtime-registry.ts`).
 *
 * @param deps - The service, the owner, the agents, and the default-agent setting.
 * @param source - Where settings changes are announced.
 * @returns An unsubscribe function.
 */
export function watchDefaultAgent(deps: TeamRoomDeps, source: TeamRoomConfigSource): () => void {
  return source.onChange((change) => {
    if (!change.sections.includes('agents')) return;
    const room = openTeamRoom(deps);
    if (room) syncDefaultAgent(deps, room);
  });
}

/**
 * The room, opened once and returned forever after. Degrades to `null` with a
 * warning naming what was lost.
 *
 * @param deps - The service and the owner.
 */
function openTeamRoom(deps: Pick<TeamRoomDeps, 'service' | 'operatorAuthorId'>): Room | null {
  try {
    const { room, created } = deps.service.ensureSystemChannel(
      TEAM_ROOM_KEY,
      TEAM_ROOM_SEED,
      deps.operatorAuthorId()
    );
    if (created) logger.info('[Rooms] Opened your team room at #%s', room.slug ?? TEAM_ROOM_KEY);
    return room;
  } catch (err) {
    logger.warn('[Rooms] could not open the team room', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Put one agent on the roster with the channel default response mode.
 *
 * Re-adding an agent that is already a member is a no-op insert one call down
 * (`RoomStore.addMember` conflicts do nothing), so the boot backfill costs a
 * write that changes nothing and — crucially — never moves the `joinedSeq`
 * floor an existing member already has. It still ANSWERS with the membership,
 * which is how {@link syncDefaultAgent} turns an agent directory into the author
 * id a response mode is keyed on.
 *
 * @param deps - The service and the owner.
 * @param room - The team room.
 * @param agentPath - The agent's directory.
 * @returns The agent's author id, or `null` when it could not be seated.
 */
function seatAgent(
  deps: Pick<TeamRoomDeps, 'service' | 'operatorAuthorId'>,
  room: Room,
  agentPath: string
): string | null {
  try {
    return deps.service.addMember(room.id, deps.operatorAuthorId(), { agentPath }).authorId;
  } catch (err) {
    logger.warn('[Rooms] could not seat an agent in the team room', {
      agentPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Move #team's fallback seat onto the agent the default-agent setting names,
 * and off whoever was holding it.
 *
 * **It touches exactly two memberships, both of them by identity.** The seat is
 * recorded on the room (`rooms.fallback_seat_author_id`), so this knows which
 * member it handed `always` to last time and demotes that one — never "whoever
 * currently holds `always`". Reading the mode as the marker was wrong in both
 * directions: a person who sets Nova to "Everything" from the room's member menu
 * means it, and would have had that choice silently reverted on the next boot,
 * while their Nova would also have been mistaken for the seat at dispatch and
 * stood down when somebody else was named. Every other membership in #team is
 * left exactly as the person left it.
 *
 * **A registry that cannot name the default agent means "cannot answer", not
 * "there is no default".** A boot whose mesh failed to start lists no agents at
 * all, and demoting the seat on that evidence would leave #team silently
 * swallowing what a person types until the next healthy boot — a much worse
 * outcome than one boot's stale seat. So an unresolvable default leaves the
 * roster exactly as the last healthy boot left it.
 *
 * The one mode it overrules is a `silent` or `mention-only` on the seat itself,
 * and deliberately: the setting says this is the agent that answers, and a
 * #team where typing reaches nobody is the failure this whole path prevents.
 *
 * Never throws — same contract as everything else in this module.
 *
 * @param deps - The service, the owner, the agents, and the default-agent setting.
 * @param room - The team room.
 */
function syncDefaultAgent(deps: TeamRoomDeps, room: Room): void {
  const defaultPath = resolveDefaultAgentPath(deps);
  if (!defaultPath) {
    logger.warn('[Rooms] no default agent resolves yet; leaving the team room seat as it was');
    return;
  }
  // Seated rather than looked up: the default agent may be registered and not
  // yet a member (a fresh registry, or a name that only just started resolving),
  // and `addMember` is the one call that answers with an author id either way.
  // A `null` here is the degraded case above, not an empty seat.
  const seatAuthorId = seatAgent(deps, room, defaultPath);
  if (!seatAuthorId) return;

  let roster: readonly RoomRosterEntry[];
  try {
    roster = deps.service.getRoom(room.id, deps.operatorAuthorId())?.members ?? [];
  } catch (err) {
    logger.warn('[Rooms] could not read the team room roster', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const byId = new Map(roster.map((member) => [member.authorId, member]));

  const previous = room.fallbackSeatAuthorId ?? null;
  if (previous && previous !== seatAuthorId) {
    const outgoing = byId.get(previous);
    // Only if it still holds what this function gave it. A person who has since
    // silenced the old default chose that, and it is not this write's to undo.
    if (outgoing?.responseMode === DEFAULT_AGENT_RESPONSE_MODE) {
      setResponseMode(deps, room, outgoing, CHANNEL_RESPONSE_MODE);
    }
  }

  const incoming = byId.get(seatAuthorId);
  if (incoming) setResponseMode(deps, room, incoming, DEFAULT_AGENT_RESPONSE_MODE);
  if (previous === seatAuthorId) return;
  try {
    deps.service.setFallbackSeat(room.id, deps.operatorAuthorId(), seatAuthorId);
  } catch (err) {
    logger.warn('[Rooms] could not record the team room seat', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The directory of the agent unaddressed posts should reach: the one the
 * setting names, DorkBot when it names nobody registered here, and `null` on an
 * install with no agents at all.
 *
 * The fallback is what makes the promise survive a stale setting. An agent named
 * in `config.agents.defaultAgent` can be renamed, unregistered, or moved to
 * another machine, and reading the value literally would leave #team with
 * nobody answering — a room that silently swallows what you type. DorkBot is
 * always there (`ensureDorkBot` runs first on every boot), so it is the answer
 * that cannot go missing.
 *
 * `null` never means "nobody is the default" — it means this install cannot say
 * who is right now, which {@link syncDefaultAgent} treats as a reason to change
 * nothing. Both reads reach out of this module (the agent registry, the settings
 * store) and are guarded for the reason the whole file is: neither of them may
 * take a boot down.
 *
 * @param deps - The agents and the default-agent setting.
 */
function resolveDefaultAgentPath(
  deps: Pick<TeamRoomDeps, 'agents' | 'defaultAgentName'>
): string | null {
  try {
    const agents = deps.agents();
    const configured = deps.defaultAgentName()?.trim();
    const named = configured ? agents.find((agent) => agent.name === configured) : undefined;
    const fallback = agents.find((agent) => agent.name === DORKBOT_AGENT_NAME);
    return (named ?? fallback)?.path ?? null;
  } catch (err) {
    logger.warn('[Rooms] could not read the default agent', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Move one membership's response mode, skipping the write when it is already
 * there so a boot that changes nothing writes nothing.
 *
 * @param deps - The service and the owner.
 * @param room - The team room.
 * @param member - The membership being moved.
 * @param mode - What it should be.
 */
function setResponseMode(
  deps: Pick<TeamRoomDeps, 'service' | 'operatorAuthorId'>,
  room: Room,
  member: RoomRosterEntry,
  mode: ResponseMode
): void {
  if (member.responseMode === mode) return;
  try {
    deps.service.updateMembership(room.id, deps.operatorAuthorId(), member.authorId, mode);
    logger.info('[Rooms] %s now answers %s in the team room', member.author.displayName, mode);
  } catch (err) {
    logger.warn('[Rooms] could not set a response mode in the team room', {
      authorId: member.authorId,
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
