/**
 * The one room every install has: **#team**, the home the cockpit opens on
 * (team-room-home spec D3.1).
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
import type { Room } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
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
   * Every registered agent's directory. Read at boot to backfill the roster, so
   * an install that predates this hook — or one whose agents were registered
   * while it was off — still finds its whole team in the room.
   */
  agentPaths: () => readonly string[];
}

/**
 * Open #team if it is not already there, then make sure every registered agent
 * is in it.
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
 * @param deps - The service, the owner, and the agents to seat.
 * @returns The room, or `null` when it could not be opened.
 */
export function ensureTeamRoom(deps: TeamRoomDeps): Room | null {
  const room = openTeamRoom(deps);
  if (!room) return null;
  for (const agentPath of deps.agentPaths()) {
    seatAgent(deps, room, agentPath);
  }
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
 * Never throws, for the reason {@link ensureTeamRoom} gives: a room join is not
 * allowed to fail somebody's agent creation.
 *
 * @param deps - The service and the owner. The agent list is not read here.
 * @param agentPath - The new agent's directory.
 */
export function joinTeamRoom(deps: Omit<TeamRoomDeps, 'agentPaths'>, agentPath: string): void {
  const room = openTeamRoom(deps);
  if (!room) return;
  seatAgent(deps, room, agentPath);
}

/**
 * The room, opened once and returned forever after. Degrades to `null` with a
 * warning naming what was lost.
 *
 * @param deps - The service and the owner.
 */
function openTeamRoom(deps: Omit<TeamRoomDeps, 'agentPaths'>): Room | null {
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
 * floor an existing member already has.
 *
 * @param deps - The service and the owner.
 * @param room - The team room.
 * @param agentPath - The agent's directory.
 */
function seatAgent(deps: Omit<TeamRoomDeps, 'agentPaths'>, room: Room, agentPath: string): void {
  try {
    deps.service.addMember(room.id, deps.operatorAuthorId(), { agentPath });
  } catch (err) {
    logger.warn('[Rooms] could not seat an agent in the team room', {
      agentPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
