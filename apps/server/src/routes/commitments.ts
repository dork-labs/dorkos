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
import { Router, type Request, type Response } from 'express';
import {
  CreateCommitmentRequestSchema,
  ListCommitmentsQuerySchema,
  UpdateCommitmentRequestSchema,
} from '@dorkos/shared/commitment-schemas';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
import { parseBody, sendError } from '../lib/route-utils.js';
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
   * @param req - The request.
   * @param res - The response, carrying the resolved caller.
   */
  isOwner(req: Request, res: Response): boolean;
}

/** The HTTP status for each refusal. */
const STATUS: Record<CommitmentErrorCode, number> = {
  NOT_FOUND: 404,
  NOT_YOURS: 403,
  NOTHING_TO_CHANGE: 400,
  CONFLICT: 409,
  PAST_DUE: 400,
  NO_AGENT: 403,
  UNKNOWN_AGENT: 404,
};

/** Answer a {@link CommitmentError} with its status, or rethrow. */
function sendRefusal(res: Response, err: unknown): void {
  if (!(err instanceof CommitmentError)) throw err;
  sendError(res, STATUS[err.code], err.message, err.code);
}

/** The refusal for a person who is not this install's owner. */
const NOT_YOUR_AGENT = 'Only the owner of this agent can change its commitments.';

/**
 * Who is changing a commitment over HTTP: the agent its token names, or a
 * person. A machine whose identity did not verify is never read as a person,
 * and a person must own the agent: every agent on this install belongs to its
 * owner (the team roster's `ownerId` rule), so that is the owner bar.
 */
function actorOf(
  req: Request,
  res: Response,
  deps: CommitmentRouterDeps
): CommitmentActor | undefined {
  const identity = getRequestAgentIdentity(res);
  if (identity && !identity.inactive) {
    const agentId = deps.agentIdForPath(identity.agentPath);
    if (agentId) return { kind: 'agent', agentId };
  }
  if (presentsAgentIdentity(req, res)) {
    sendError(res, 403, 'This agent could not be identified, so nothing changed.', 'NO_AGENT');
    return undefined;
  }
  if (!deps.isOwner(req, res)) {
    sendError(res, 403, NOT_YOUR_AGENT, 'NOT_YOURS');
    return undefined;
  }
  return { kind: 'person' };
}

/**
 * The router for `/api/commitments`: list and change.
 *
 * @param deps - The service and the Mesh lookups.
 */
export function createCommitmentsRouter(deps: CommitmentRouterDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const query = parseBody(ListCommitmentsQuerySchema, req.query, res);
    if (!query) return;
    const { limit, ...filter } = query;
    const list = deps.service.list(filter, limit);
    const owner = deps.isOwner(req, res);
    return res.json({
      commitments: owner ? list : list.map((c) => ({ ...c, sourceSessionId: null })),
    });
  });

  router.patch('/:id', (req, res) => {
    const body = parseBody(UpdateCommitmentRequestSchema, req.body ?? {}, res);
    if (!body) return;
    const actor = actorOf(req, res, deps);
    if (!actor) return;
    try {
      return res.json(deps.service.update(actor, req.params.id, body));
    } catch (err) {
      return sendRefusal(res, err);
    }
  });

  return router;
}

/**
 * The router for `/api/agents/:id/commitments`: a person adds a promise for an
 * agent. Mounted before the agents router so this path is answered here.
 *
 * @param deps - The service and the Mesh lookups.
 */
export function createAgentCommitmentsRouter(deps: CommitmentRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.post('/', (req: Request<{ id: string }>, res) => {
    if (presentsAgentIdentity(req, res)) {
      return sendError(
        res,
        403,
        'Agents record their own promises with commitment_add.',
        'NOT_A_PERSON'
      );
    }
    if (!deps.isOwner(req, res)) return sendError(res, 403, NOT_YOUR_AGENT, 'NOT_YOURS');
    const body = parseBody(CreateCommitmentRequestSchema, req.body ?? {}, res);
    if (!body) return;
    const agentId = req.params.id;
    if (!deps.agentExists(agentId)) {
      return sendError(res, 404, 'No agent on the team has that id.', 'UNKNOWN_AGENT');
    }
    try {
      return res.status(201).json(deps.service.create(agentId, body));
    } catch (err) {
      return sendRefusal(res, err);
    }
  });

  return router;
}
