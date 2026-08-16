/**
 * The team roster — one read of every identity on this install.
 *
 * `GET /api/team` and nothing else. **There is no POST, no PATCH and no write
 * path here, and that is the decision rather than an omission** (ADR
 * 260806-222535): the roster is a projection over `authors` and the mesh cache,
 * every id it returns already existed, and a write surface would fork a third
 * identity model beside two the repo has already converged on. Identities are
 * created where they were always created — an author by the rooms domain, an
 * agent by the mesh.
 *
 * Thin by the route rule: it resolves today's owner account, hands the two
 * registries to {@link aggregateTeamRoster} as reads, and serializes what comes
 * back.
 *
 * @module routes/team
 */
import { Router } from 'express';
import { logError, logger } from '../lib/logger.js';
import { sendError } from '../lib/route-utils.js';
import type { AuthorRegistry } from '../services/rooms/author-registry.js';
import {
  aggregateTeamRoster,
  type TeamAgentSource,
  type TeamClaimSource,
  type TeamRoomSource,
} from '../services/identity/aggregate-team.js';

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

/** What the roster router reads. Every dependency is a reader; none of them writes. */
export interface TeamRouterDeps {
  /** The rooms domain's author registry — the people on this install. */
  authors: Pick<AuthorRegistry, 'listActive'>;
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

  return router;
}
