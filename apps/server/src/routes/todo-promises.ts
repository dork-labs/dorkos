/**
 * To-do routes (spec `heartbeats` §12): what agents promised.
 *
 * - `GET /api/todo-promises` — anyone reads every agent's list (filters
 *   `agentId`, `state`, `to`, `limit`). Only the owner sees the source chat.
 * - `POST /api/agents/:id/todo-promises` — the owner adds one for an agent. Agents
 *   record their own with `todo_promise_add`, so a caller presenting an agent
 *   identity is refused here.
 * - `PATCH /api/todo-promises/:id` — the promising agent or a person closes one or
 *   moves its date; another agent is refused (`NOT_YOURS`).
 *
 * Every rule lives in `TodoPromiseService`; this file reads the caller and maps
 * refusals to status codes.
 *
 * @module routes/todo-promises
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CreateTodoPromiseRequestSchema,
  ListTodoPromisesQuerySchema,
  UpdateTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';
import { callerAgentId } from '../services/todos/caller.js';
import { marksOf } from '../services/core/turn-power/turn-levels.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import {
  TodoPromiseError,
  type TodoPromiseActor,
  type TodoPromiseErrorCode,
  type TodoPromiseService,
} from '../services/todos/index.js';

/** What the to-do routes need. */
export interface TodoPromiseRouterDeps {
  /** The to-dos service. */
  service: Pick<TodoPromiseService, 'create' | 'update' | 'list'>;
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
  /**
   * Whether this request proves the owner in person: the owner's own session cookie
   * (`personProof`). Only then does a change carry `person` authority (DOR-3088); the open gate
   * `isOwner` passes with login off is not proof, since any program here can reach it.
   *
   * @param facts - The request's facts, carrying the resolved caller.
   */
  personProven(facts: RequestFacts): boolean;
}

/** The HTTP status for each refusal. */
const STATUS: Record<TodoPromiseErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  NOT_YOURS: 403,
  NOTHING_TO_CHANGE: 400,
  CONFLICT: 409,
  PAST_DUE: 400,
  NO_AGENT: 403,
  UNKNOWN_AGENT: 404,
  TOO_MANY: 429,
};

/** Answer a {@link TodoPromiseError} with its status, or rethrow. */
function refusal(c: Context<ApiEnv>, err: unknown): Response {
  if (!(err instanceof TodoPromiseError)) throw err;
  return c.json(errorBody(err.message, err.code), STATUS[err.code]);
}

/** The refusal for a person who is not this install's owner. */
const NOT_YOUR_AGENT = 'Only the owner of this agent can change its to-dos.';

/**
 * Who is changing a to-do over HTTP: the agent its token names, or a
 * person. A machine whose identity did not verify is never read as a person,
 * and a person must own the agent: every agent on this install belongs to its
 * owner (the team roster's `ownerId` rule), so that is the owner bar.
 *
 * @returns The actor, or the refusal to answer with.
 */
function actorOf(
  c: Context<ApiEnv>,
  deps: TodoPromiseRouterDeps
): { actor: TodoPromiseActor } | { refused: Response } {
  const facts = honoRequestFacts(c);
  const caller = callerAgentId(facts.agentIdentity, deps.agentIdForPath);
  if (caller.ok) {
    // Over HTTP there is no session to read a level from, so only the agent's running marks travel.
    const marks = marksOf(undefined, facts.agentIdentity?.agentPath);
    return { actor: { kind: 'agent', agentId: caller.agentId, marks } };
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
  return { actor: { kind: 'person', proven: deps.personProven(facts) } };
}

/**
 * The routes for `/api/todo-promises`: list and change.
 *
 * @param deps - The service and the Mesh lookups.
 * @returns The routes, to mount at `/api/todo-promises`.
 */
export function createTodoPromisesRoutes(deps: TodoPromiseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const query = ListTodoPromisesQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    const { limit, ...filter } = query.data;
    const list = deps.service.list(filter, limit);
    const owner = deps.isOwner(honoRequestFacts(c));
    return c.json({
      todoPromises: owner ? list : list.map((item) => ({ ...item, sourceSessionId: null })),
    });
  });

  router.patch('/:id', (c) => {
    const body = UpdateTodoPromiseRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
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
 * The routes for `/api/agents/:id/todo-promises`: a person adds a promise for an
 * agent. The agents group registers nothing on this path, so it is answered here.
 *
 * @param deps - The service and the Mesh lookups.
 * @returns The routes, to mount at `/api/agents/:id/todo-promises`.
 */
export function createAgentTodoPromisesRoutes(deps: TodoPromiseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/', (c) => {
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts)) {
      return c.json(
        errorBody('Agents record their own promises with todo_promise_add.', 'NOT_A_PERSON'),
        403
      );
    }
    if (!deps.isOwner(facts)) return c.json(errorBody(NOT_YOUR_AGENT, 'NOT_YOURS'), 403);
    const body = CreateTodoPromiseRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    // Mounted under `/api/agents/:id/todo-promises`: the parent path's parameter.
    const agentId = c.req.param('id') as string;
    if (!deps.agentExists(agentId)) {
      return c.json(errorBody('No agent on the team has that id.', 'UNKNOWN_AGENT'), 404);
    }
    try {
      const assigner = { kind: 'person', proven: deps.personProven(facts) } as const;
      return c.json(deps.service.create(agentId, body.data, assigner), 201);
    } catch (err) {
      return refusal(c, err);
    }
  });

  return router;
}
