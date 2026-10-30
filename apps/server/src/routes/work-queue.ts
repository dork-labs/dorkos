/**
 * Work queue routes (DOR-3462): a person sees, adds to, orders and pauses an
 * agent's queue. Agents use their own tools, so a caller presenting an agent
 * identity is refused on every route here, and a person must own the install.
 *
 * - `GET /api/agents/:id/work-queue` — the queue.
 * - `PATCH /api/agents/:id/work-queue` — turn it on or off, its target and daily cap.
 * - `PUT /api/work-queues/stop` — stop every queue, or lift that.
 * - `PUT /api/agents/:id/work-queue/order` — the order of what is waiting.
 * - `POST /api/agents/:id/work-queue/items` — add an item.
 * - `DELETE /api/agents/:id/work-queue/items/:itemId` — remove a waiting item.
 * - `POST /api/agents/:id/work-queue/items/:itemId/requeue` — queue an ended item again.
 *
 * @module routes/work-queue
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  AddWorkItemRequestSchema,
  ReorderWorkQueueRequestSchema,
  SetWorkQueuesStoppedRequestSchema,
  UpdateWorkQueueRequestSchema,
} from '@dorkos/shared/work-queue-schemas';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import {
  WorkQueueError,
  type WorkQueueErrorCode,
  type WorkQueueService,
} from '../services/work-queue/work-queue-service.js';

/** What the work queue routes need. */
export interface WorkQueueRouterDeps {
  /** The work queue service. */
  service: Pick<
    WorkQueueService,
    'read' | 'add' | 'remove' | 'update' | 'reorder' | 'requeue' | 'setAllStopped'
  >;
  /**
   * Whether an agent with this Mesh id is on the team.
   *
   * @param agentId - The Mesh id.
   */
  agentExists(agentId: string): boolean;
  /**
   * Whether this caller is the person who owns this install.
   *
   * @param facts - The request's facts, carrying the resolved caller.
   */
  isOwner(facts: RequestFacts): boolean;
}

/** The HTTP status for each refusal. */
const STATUS: Record<WorkQueueErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  NOT_YOURS: 403,
  NOT_QUEUED: 409,
  NOT_ENDED: 409,
  FULL: 409,
  BAD_CWD: 400,
};

/** Answer a {@link WorkQueueError} with its status, or rethrow. */
function refusal(c: Context<ApiEnv>, err: unknown): Response {
  if (!(err instanceof WorkQueueError)) throw err;
  return c.json(errorBody(err.message, err.code), STATUS[err.code]);
}

/**
 * The route for `/api/work-queues`: the one stop on every queue, a person's only.
 *
 * @param deps - The service and the checks.
 * @returns The routes, to mount at `/api/work-queues`.
 */
export function createWorkQueuesStopRoutes(deps: WorkQueueRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.put('/stop', (c) => {
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts) || !deps.isOwner(facts)) {
      return c.json(errorBody('Only the owner can stop every queue.', 'NOT_YOURS'), 403);
    }
    const body = SetWorkQueuesStoppedRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    deps.service.setAllStopped(body.data.stopped);
    return c.json(body.data);
  });
  return router;
}

/**
 * The routes for `/api/agents/:id/work-queue`.
 *
 * @param deps - The service and the checks.
 * @returns The routes, to mount at `/api/agents/:id/work-queue`.
 */
export function createWorkQueueRoutes(deps: WorkQueueRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** The route's agent id, or the refusal: a person who owns it, and a real agent. */
  function agentIdOf(c: Context<ApiEnv>): { agentId: string } | { refused: Response } {
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts)) {
      return {
        refused: c.json(errorBody('Agents use their own work queue tools.', 'NOT_A_PERSON'), 403),
      };
    }
    if (!deps.isOwner(facts)) {
      return {
        refused: c.json(errorBody('Only the owner can open this queue.', 'NOT_YOURS'), 403),
      };
    }
    // Mounted under `/api/agents/:id/work-queue`: the parent path's parameter.
    const agentId = c.req.param('id') as string;
    if (!deps.agentExists(agentId)) {
      return { refused: c.json(errorBody('No agent on the team has that id.', 'NOT_FOUND'), 404) };
    }
    return { agentId };
  }

  router.get('/', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    return c.json(deps.service.read(caller.agentId));
  });

  router.patch('/', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    const body = UpdateWorkQueueRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    return c.json(deps.service.update(caller.agentId, body.data));
  });

  router.put('/order', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    const body = ReorderWorkQueueRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    return c.json(deps.service.reorder(caller.agentId, body.data.itemIds));
  });

  router.post('/items', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    const body = AddWorkItemRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      return c.json(deps.service.add({ kind: 'person' }, caller.agentId, body.data), 201);
    } catch (err) {
      return refusal(c, err);
    }
  });

  router.delete('/items/:itemId', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    try {
      deps.service.remove({ kind: 'person' }, c.req.param('itemId'));
      return c.body(null, 204);
    } catch (err) {
      return refusal(c, err);
    }
  });

  router.post('/items/:itemId/requeue', (c) => {
    const caller = agentIdOf(c);
    if ('refused' in caller) return caller.refused;
    try {
      return c.json(deps.service.requeue(c.req.param('itemId')));
    } catch (err) {
      return refusal(c, err);
    }
  });

  return router;
}
