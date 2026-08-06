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
import { aggregateTeamRoster, type TeamAgentSource } from '../services/identity/aggregate-team.js';

/** The mesh read this router needs, narrowed to it. */
export interface TeamMeshReader {
  listWithHealth(filters?: Record<string, never>): TeamAgentSource[];
}

/** What the roster router reads. Every dependency is a reader; none of them writes. */
export interface TeamRouterDeps {
  /** The rooms domain's author registry — people, and who the operator is. */
  authors: Pick<AuthorRegistry, 'listActive' | 'isOwner'>;
  /**
   * The mesh registry, when it started. Absent is a degraded roster (a
   * `warnings[]` entry), never a failed request — the person reading the page
   * is still on it.
   */
  meshCore?: TeamMeshReader;
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
      // Resolved per request rather than captured: an install becomes owned
      // partway through its life (the enable-login flow), so a value read at
      // boot would leave this endpoint believing forever that nobody owns it.
      const owner = deps.ownerAccount();
      const mesh = deps.meshCore;

      const roster = await aggregateTeamRoster({
        listPeople: () => deps.authors.listActive('human'),
        listAgents: () => {
          if (!mesh) throw new Error('The agent registry is not running.');
          return mesh.listWithHealth();
        },
        isOwnerAuthor: (authorId) => deps.authors.isOwner(authorId, owner?.id ?? null),
        account: () => (owner ? { name: owner.name, email: deps.ownerEmail(owner.id) } : null),
        configDisplayName: () => deps.configDisplayName(),
        defaultAgentName: () => deps.defaultAgentName(),
      });

      return res.json(roster);
    } catch (err) {
      logger.error('[Team] roster read failed', logError(err));
      return sendError(res, 500, 'Failed to read the team roster', 'TEAM_ROSTER_FAILED');
    }
  });

  return router;
}
