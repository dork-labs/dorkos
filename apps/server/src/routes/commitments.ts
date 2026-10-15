/**
 * Commitment routes (spec `heartbeats` §12): what agents promised.
 *
 * - `GET /api/commitments` — anyone reads every agent's list (filters
 *   `agentId`, `state`, `to`, `limit`). Only the owner sees the source chat.
 * - `POST /api/agents/:id/commitments` — the owner adds one for an agent. Agents
 *   record their own with `commitment_add`, so a caller presenting an agent
 *   identity is refused here.
 * - `PATCH /api/commitments/:id` — the promising agent or a person closes one or
 *   moves its date; another agent is refused (`NOT_YOURS`).
 *
 * Every rule lives in `CommitmentService`; this file reads the caller and maps
 * refusals to status codes.
 *
 * @module routes/commitments
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CreateCommitmentRequestSchema,
  ListCommitmentsQuerySchema,
  UpdateCommitmentRequestSchema,
} from '@dorkos/shared/commitment-schemas';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import {
  CommitmentError,
  type CommitmentActor,
  type CommitmentErrorCode,
  type CommitmentService,
} from '../services/commitments/index.js';

/** What the commitment routes need. */
export interface CommitmentRouterDeps {
  /** The commitments service. */
  service: Pick<CommitmentService, 'create' | 'update' | 'list'>;
  /**
   * Whether an agent with this Mesh id is on the team.
   *
   * @param agentId - The Mesh id.
   */
  agentExists(agentId: string): boolean;
  /**
   * The Mesh id of the agent living at a home folder, or undefined.
   *
   * @param agentPath - The agent's home folder.
   */
  agentIdForPath(agentPath: string): string | undefined;
  /**
   * Whether this caller is the person who owns this install. Only the owner
   * sees which chat a promise was made in (`sourceSessionId`): chats are
   * owner-only everywhere else too.
   *
   * @param facts - The request's facts, carrying the resolved caller.
   */
  isOwner(facts: RequestFacts): boolean;
}

/** The HTTP status for each refusal. */
const STATUS: Record<CommitmentErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  NOT_YOURS: 403,
  NOTHING_TO_CHANGE: 400,
  CONFLICT: 409,
  PAST_DUE: 400,
  NO_AGENT: 403,
  UNKNOWN_AGENT: 404,
};

/** Answer a {@link CommitmentError} with its status, or rethrow. */
function refusal(c: Context<ApiEnv>, err: unknown): Response {
  if (!(err instanceof CommitmentError)) throw err;
  return c.json(errorBody(err.message, err.code), STATUS[err.code]);
}

/** The refusal for a person who is not this install's owner. */
const NOT_YOUR_AGENT = 'Only the owner of this agent can change its commitments.';

/**
 * Who is changing a commitment over HTTP: the agent its token names, or a
 * person. A machine whose identity did not verify is never read as a person,
 * and a person must own the agent: every agent on this install belongs to its
 * owner (the team roster's `ownerId` rule), so that is the owner bar.
 *
 * @returns The actor, or the refusal to answer with.
 */
function actorOf(
  c: Context<ApiEnv>,
  deps: CommitmentRouterDeps
): { actor: CommitmentActor } | { refused: Response } {
  const facts = honoRequestFacts(c);
  const identity = facts.agentIdentity;
  if (identity && !identity.inactive) {
    const agentId = deps.agentIdForPath(identity.agentPath);
    if (agentId) return { actor: { kind: 'agent', agentId } };
  }
  if (presentsAgentIdentity(facts)) {
    return {
      refused: c.json(
        errorBody('This agent could not be identified, so nothing changed.', 'NO_AGENT'),
        403
      ),
    };
  }
  if (!deps.isOwner(facts)) return { refused: c.json(errorBody(NOT_YOUR_AGENT, 'NOT_YOURS'), 403) };
  return { actor: { kind: 'person' } };
}

/**
 * The routes for `/api/commitments`: list and change.
 *
 * @param deps - The service and the Mesh lookups.
 * @returns The routes, to mount at `/api/commitments`.
 */
export function createCommitmentsRoutes(deps: CommitmentRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const query = ListCommitmentsQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    const { limit, ...filter } = query.data;
    const list = deps.service.list(filter, limit);
    const owner = deps.isOwner(honoRequestFacts(c));
    return c.json({
      commitments: owner ? list : list.map((item) => ({ ...item, sourceSessionId: null })),
    });
  });

  router.patch('/:id', (c) => {
    const body = UpdateCommitmentRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const caller = actorOf(c, deps);
    if ('refused' in caller) return caller.refused;
    try {
      return c.json(deps.service.update(caller.actor, c.req.param('id'), body.data));
    } catch (err) {
      return refusal(c, err);
    }
  });

  return router;
}

/**
 * The routes for `/api/agents/:id/commitments`: a person adds a promise for an
 * agent. The agents group registers nothing on this path, so it is answered here.
 *
 * @param deps - The service and the Mesh lookups.
 * @returns The routes, to mount at `/api/agents/:id/commitments`.
 */
export function createAgentCommitmentsRoutes(deps: CommitmentRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/', (c) => {
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts)) {
      return c.json(
        errorBody('Agents record their own promises with commitment_add.', 'NOT_A_PERSON'),
        403
      );
    }
    if (!deps.isOwner(facts)) return c.json(errorBody(NOT_YOUR_AGENT, 'NOT_YOURS'), 403);
    const body = CreateCommitmentRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    // Mounted under `/api/agents/:id/commitments`: the parent path's parameter.
    const agentId = c.req.param('id') as string;
    if (!deps.agentExists(agentId)) {
      return c.json(errorBody('No agent on the team has that id.', 'UNKNOWN_AGENT'), 404);
    }
    try {
      return c.json(deps.service.create(agentId, body.data), 201);
    } catch (err) {
      return refusal(c, err);
    }
  });

  return router;
}
