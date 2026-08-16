/**
 * The team roster — one read of every identity on this install, and what one of
 * those identities is part of.
 *
 * **Two reads and no write path, and that is the decision rather than an
 * omission** (ADR 260806-222535): the roster is a projection over `authors` and
 * the mesh cache, every id it returns already existed, and a write surface would
 * fork a third identity model beside two the repo has already converged on.
 * Identities are created where they were always created — an author by the rooms
 * domain, an agent by the mesh.
 *
 * `GET /api/team/:memberId/rooms` joined it later (spec `profile-unification`
 * §3.2) and belongs here rather than under `/api/rooms` because the id in that
 * path is a ROSTER id: half the time it is a mesh manifest ULID, which the rooms
 * domain has no business knowing about. The router stays a router — the
 * translation lives in `services/identity/member-rooms.ts`.
 *
 * Thin by the route rule: it resolves today's owner account, hands the
 * registries to {@link aggregateTeamRoster} and {@link listMemberRooms} as
 * reads, and serializes what comes back.
 *
 * @module routes/team
 */
import { Router, type Request, type Response } from 'express';
import { logError, logger } from '../lib/logger.js';
import { sendError } from '../lib/route-utils.js';
import type { AuthorRegistry } from '../services/rooms/author-registry.js';
import {
  aggregateTeamRoster,
  type TeamAgentSource,
  type TeamClaimSource,
  type TeamRoomSource,
} from '../services/identity/aggregate-team.js';
import { listMemberRooms } from '../services/identity/member-rooms.js';
import type { RoomStore } from '../services/rooms/room-store.js';
import { AGENT_IDENTITY_HEADER, getRequestAgentIdentity } from '../middleware/agent-identity.js';

/** The mesh reads this router needs, narrowed to them. */
export interface TeamMeshReader {
  listWithHealth(filters?: Record<string, never>): TeamAgentSource[];
  /**
   * The registry's project directories, which `listWithHealth()` strips.
   *
   * A SECOND read rather than a reach into the registry behind the mesh: both
   * are already-public, already-cheap listings of the same small table, and
   * joining them here keeps the strip that protects every OTHER consumer of the
   * mesh exactly where it is. The roster is the operator's own cockpit, so it is
   * entitled to the path (spec `profile-unification` §3.1); a room is not, and
   * nothing about that changes here.
   */
  listWithPaths(): Array<{ id: string; projectPath: string }>;
}

/** The room reads this router needs, narrowed to them. */
export type TeamRoomsReader = Pick<RoomStore, 'listRoomsForMember' | 'listMembersForRooms'>;

/** What the roster router reads. Every dependency is a reader; none of them writes. */
export interface TeamRouterDeps {
  /** The rooms domain's author registry — the people on this install. */
  authors: Pick<AuthorRegistry, 'listActive'>;
  /**
   * The room store, for `GET /:memberId/rooms`.
   *
   * Required, unlike {@link TeamRouterDeps.meshCore}: the rooms subsystem is
   * built unconditionally at boot, so an optional dependency here would only
   * buy a degradation path that nothing can reach and every reader would have
   * to keep believing.
   */
  rooms: TeamRoomsReader;
  /**
   * The mesh registry, when it started. Absent is a degraded roster (a
   * `warnings[]` entry), never a failed request — the person reading the page
   * is still on it.
   */
  meshCore?: TeamMeshReader;
  /**
   * `RoomService.listActiveClaims()` — every room turn in flight right now.
   *
   * The one signal that says an agent is WORKING rather than merely seen
   * recently.
   */
  activeClaims: () => TeamClaimSource[];
  /**
   * Every room, archived ones included, for naming the room a claim is held in.
   *
   * Called only when a claim exists, so an idle install never runs it.
   */
  listRooms: () => TeamRoomSource[];
  /**
   * Project directory → the newest session `updatedAt` there, across every
   * runtime (`listRecentSessions().agentActivity`).
   */
  sessionActivity: () => Promise<Record<string, string>>;
  /** `readOwnerAccount()` — the account that owns this install, or `null`. */
  ownerAccount: () => { id: string; name: string } | null;
  /** The owner's address, looked up by user id. */
  ownerEmail: (userId: string) => string | null;
  /** `config.profile.displayName`. */
  configDisplayName: () => string | null;
  /** `config.agents.defaultAgent`. */
  defaultAgentName: () => string | null;
}

/**
 * Create the team roster router.
 *
 * @param deps - The registries and config readers the roster aggregates.
 * @returns Express Router serving `GET /api/team`.
 */
export function createTeamRouter(deps: TeamRouterDeps): Router {
  const router = Router();

  // GET /api/team — the roster. Per-source degradation in the ADR-0310
  // envelope: `{ members, warnings? }`, always 200 when the request itself is
  // well-formed, `warnings` omitted entirely when every source read cleanly.
  router.get('/', async (_req, res) => {
    try {
      const mesh = deps.meshCore;

      // Every dependency goes over as a THUNK, and that is the contract rather
      // than a style: `aggregateTeamRoster` reads each one inside its own
      // degradation envelope, so a locked database or a corrupt `config.json`
      // costs exactly what that read knew and the roster still answers 200. Any
      // value resolved HERE, before the call, would be a 500 again — which is
      // what five of these were.
      //
      // It also gets freshness right for free: an install becomes owned partway
      // through its life (the enable-login flow), so the account is read per
      // request and never captured.
      const roster = await aggregateTeamRoster({
        listPeople: () => deps.authors.listActive('human'),
        listAgentAuthors: () => deps.authors.listActive('agent'),
        listAgents: () => {
          if (!mesh) throw new Error('The agent registry is not running.');
          // The public listing strips the project directory; the profile needs
          // it. Joined here, from the mesh's own paths listing, so the strip
          // that keeps `/Users/…` out of a shared room stays exactly where it
          // is and this one entitled reader puts it back for itself.
          const pathById = new Map(mesh.listWithPaths().map((a) => [a.id, a.projectPath]));
          return mesh.listWithHealth().map((agent) => {
            const projectPath = pathById.get(agent.id);
            return projectPath ? { ...agent, projectPath } : agent;
          });
        },
        listClaims: () => deps.activeClaims(),
        listRooms: () => deps.listRooms(),
        sessionActivity: () => deps.sessionActivity(),
        account: () => {
          const owner = deps.ownerAccount();
          if (!owner) return null;
          return { id: owner.id, name: owner.name, email: deps.ownerEmail(owner.id) };
        },
        configDisplayName: () => deps.configDisplayName(),
        defaultAgentName: () => deps.defaultAgentName(),
      });

      return res.json(roster);
    } catch (err) {
      // Nothing the roster reads reaches here — every source is caught inside
      // the aggregation. This is the backstop for the response itself failing,
      // and it stays, because "unreachable" is a claim about today's code.
      logger.error('[Team] roster read failed', logError(err));
      return sendError(res, 500, 'Failed to read the team roster', 'TEAM_ROSTER_FAILED');
    }
  });

  // GET /api/team/:memberId/rooms — where one roster member can be found (spec
  // `profile-unification` §3.2). 404 means "no member by that id"; a member who
  // is simply in no rooms gets a 200 and an empty list, because those are
  // different sentences on a profile.
  router.get('/:memberId/rooms', (req, res) => {
    // **People only, and this one is a boundary rather than a policy.** The
    // route takes ANY member's id, so an agent that could call it would read
    // the titles of every DM the operator has with every other agent — the
    // exact enumeration `RoomStore.listRoomsForMember` exists to prevent, walked
    // around by asking about somebody else. `read-cursors` refuses agents the
    // same way and with the same code. 403 rather than 404: there is nothing to
    // hide about the route existing.
    if (callerIsAgent(req, res)) {
      return sendError(res, 403, 'Only people read a profile', 'PEOPLE_ONLY');
    }

    // Express 5 types a param as `string | string[]`; a single-segment param
    // never arrives as an array, and a non-string is simply not a member id.
    const memberId = typeof req.params.memberId === 'string' ? req.params.memberId : '';
    try {
      const rooms = listMemberRooms(memberId, {
        listPeople: () => deps.authors.listActive('human'),
        listAgentAuthors: () => deps.authors.listActive('agent'),
        listRoomsForAuthor: (authorId) => deps.rooms.listRoomsForMember(authorId),
        listMembersForRooms: (roomIds) => deps.rooms.listMembersForRooms(roomIds),
        isRegisteredAgent: (id) => knowsAgent(deps.meshCore, id),
      });
      if (rooms === null) {
        return sendError(res, 404, 'No member with that id', 'MEMBER_NOT_FOUND');
      }
      return res.json(rooms);
    } catch (err) {
      // Unlike the roster, this read has ONE answer and no sources to trade off,
      // so a failure is a failure. An empty list would be a lie — "you are in no
      // rooms" is a sentence a profile draws, and it must never mean "the
      // database did not answer".
      logger.error('[Team] member rooms read failed', logError(err));
      return sendError(res, 500, 'Failed to read this member’s rooms', 'MEMBER_ROOMS_FAILED');
    }
  });

  return router;
}

/**
 * Whether a machine is calling.
 *
 * The same test `readCallerAuthority` uses, and for its reason: a header that
 * did NOT resolve — a revoked or expired agent token — still means an agent is
 * on the other end, and a person in the cockpit never sends one at all. Asking
 * the header rather than `resolveCaller` also keeps this route off the room
 * service singleton, which `resolveCaller` reaches through and which would MINT
 * an author row as a side effect of a read.
 *
 * @param req - The incoming request, for the raw header.
 * @param res - The response carrying the middleware's resolved identity.
 */
function callerIsAgent(req: Request, res: Response): boolean {
  return (
    getRequestAgentIdentity(res) !== undefined || req.headers[AGENT_IDENTITY_HEADER] !== undefined
  );
}

/**
 * Whether the mesh has an agent registered under this id.
 *
 * The half of "is this member real" that `authors` cannot answer: an agent gets
 * its author row the first time it is in a room, so a freshly registered one is
 * on the roster with no row at all.
 *
 * A mesh that is absent or unreadable answers `false`, which turns that one case
 * into a 404 rather than an empty list. That is the honest trade: without the
 * registry there is nothing left that can tell an unknown id from a new agent,
 * and a 404 says "I could not place this" while `{ rooms: [] }` would claim to
 * know.
 */
function knowsAgent(mesh: TeamMeshReader | undefined, memberId: string): boolean {
  if (!mesh) return false;
  try {
    return mesh.listWithHealth().some((agent) => agent.id === memberId);
  } catch (err) {
    logger.warn('[Team] agent registry unreadable while placing a member id', logError(err));
    return false;
  }
}
