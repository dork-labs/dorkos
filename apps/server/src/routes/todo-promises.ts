/**
 * To-do routes (spec `heartbeats` §12): what agents promised.
 *
 * - `GET /api/todo-promises` — anyone reads every agent's list (filters
 *   `agentId`, `state`, `to`, `limit`). Only the owner sees the source chat.
 * - `POST /api/agents/:id/todo-promises` — the owner adds one for an agent. Agents
 *   record their own with `todo_promise_add`, so a caller presenting an agent
 *   identity is refused here.
 * - `PATCH /api/todo-promises/:id` — a person closes one or moves its date. Agents
 *   change their own with `todo_promise_update`, which the permission gate decides,
 *   so a caller presenting an agent identity is refused here (DOR-3936).
 * - `POST /api/todo-promises/:id/confirm` — the person answers "was it kept?" with Yes or Not
 *   yet (DOR-3034). A person only, like the change above.
 *
 * Every rule lives in `TodoPromiseService`; this file reads the caller and maps
 * refusals to status codes.
 *
 * @module routes/todo-promises
 */
import { Hono, type Context } from 'hono';
import {
  ConfirmTodoPromiseRequestSchema,
  CreateTodoPromiseRequestSchema,
  ListTodoPromisesQuerySchema,
  UpdateTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { presentsProgramCredential } from '../lib/caller-authority.js';
import { todoRefusal } from './todos.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { type TodoPromiseActor, type TodoPromiseService } from '../services/todos/index.js';
import type { TodoConfirm } from '../services/todos/notice/todo-confirm.js';

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
   * Whether this caller is the person who owns this install. Only the owner
   * sees which chat a promise was made in (`sourceSessionId`): chats are
   * owner-only everywhere else too.
   *
   * @param facts - The request's facts, carrying the resolved caller.
   */
  isOwner(facts: RequestFacts): boolean;
  /**
   * Whether this request proves the owner in person: the owner's own session cookie
   * (`personProof`). Once an owner account exists, only then does a change carry `person`
   * authority (DOR-3088); the open gate `isOwner` passes with login off is not proof, since any
   * program here can reach it.
   *
   * @param facts - The request's facts, carrying the resolved caller.
   */
  personProven(facts: RequestFacts): boolean;
  /**
   * Whether this install has an owner account. When it has none, nobody can be proven, and a
   * person at this computer writes as the person (DOR-3832). A failed lookup must read as an
   * owner, so this fails closed.
   */
  ownerExists(): boolean;
  /** Takes a person's answer to "was it kept?" (DOR-3034). */
  confirm: Pick<TodoConfirm, 'answer'>;
}

/** The refusal for a person who is not this install's owner. */
const NOT_YOUR_AGENT = 'Only the owner of this agent can change its to-dos.';

/**
 * Who is changing a to-do over HTTP: a person who owns the agent, or a refusal.
 *
 * Agents are refused here, verified or not, as on the add route and `/api/todos`: they change
 * their own promises with `todo_promise_update`, which the permission gate decides. This route
 * runs no permission check, so letting an agent's token through would let it skip a Blocked
 * To-dos area (DOR-3936, Security M1). A person must own the agent: every agent on this install
 * belongs to its owner (the team roster's `ownerId` rule), so that is the owner bar.
 *
 * @returns The actor, or the refusal to answer with.
 */
function actorOf(
  c: Context<ApiEnv>,
  deps: TodoPromiseRouterDeps
): { actor: TodoPromiseActor } | { refused: Response } {
  const facts = honoRequestFacts(c);
  if (presentsAgentIdentity(facts)) {
    return {
      refused: problem(c, 'person_only', {
        detail: 'Agents change their own promises with todo_promise_update.',
      }),
    };
  }
  if (!deps.isOwner(facts))
    return { refused: problem(c, 'owner_only', { detail: NOT_YOUR_AGENT }) };
  return { actor: personOf(facts, deps) };
}

/**
 * The person behind a request that already passed the agent and owner checks: proven by the
 * owner's session, or the only person there is (DOR-3832). That takes both an install with no
 * owner account and a request the gate's own classifier places at this computer
 * (`isAtThisComputer`: this machine, or a container's published port) that carries no program
 * credential: no owner alone is not enough, so a request from another device, or a program
 * sending a key, stays the stranger bound.
 *
 * Not the same rule as `/api/todos`: there `ownerless` widens only what an unproven person may
 * change (`todo-policy`), and its writes keep the stranger bound. Whether to-dos should carry
 * `person` authority the way promises do is a follow-up (DOR-4837), not this route.
 */
function personOf(
  facts: RequestFacts,
  deps: TodoPromiseRouterDeps
): Extract<TodoPromiseActor, { kind: 'person' }> {
  const proven = deps.personProven(facts);
  if (proven) return { kind: 'person', proven };
  // Where the request came from first: the owner lookup fails closed on its own. A key, token or
  // bearer is a program, not the app, as in `requirePersonAtThisComputer`.
  const ownerless =
    isAtThisComputer(facts) && !presentsProgramCredential(facts) && !deps.ownerExists();
  return { kind: 'person', proven, ownerless };
}

/**
 * The routes for `/api/todo-promises`: list and change.
 *
 * @param deps - The service, the agent lookup and the owner checks.
 * @returns The routes, to mount at `/api/todo-promises`.
 */
export function createTodoPromisesRoutes(deps: TodoPromiseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const query = ListTodoPromisesQuerySchema.safeParse(readQuery(c));
    if (!query.success) return validationProblem(c, query.error);
    const { limit, ...filter } = query.data;
    const list = deps.service.list(filter, limit);
    const owner = deps.isOwner(honoRequestFacts(c));
    return c.json({
      todoPromises: owner ? list : list.map((item) => ({ ...item, sourceSessionId: null })),
    });
  });

  router.patch('/:id', (c) => {
    const body = UpdateTodoPromiseRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
    const caller = actorOf(c, deps);
    if ('refused' in caller) return caller.refused;
    try {
      return c.json(deps.service.update(caller.actor, c.req.param('id'), body.data));
    } catch (err) {
      return todoRefusal(c, err);
    }
  });

  // Any owner of this install may answer: one install is one person until spaces ship, and the
  // same owner bar as PATCH holds. An agent caller is refused (DOR-3034).
  router.post('/:id/confirm', (c) => {
    const body = ConfirmTodoPromiseRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
    const caller = actorOf(c, deps);
    if ('refused' in caller) return caller.refused;
    try {
      return c.json(deps.confirm.answer(caller.actor, c.req.param('id'), body.data.answer));
    } catch (err) {
      return todoRefusal(c, err);
    }
  });

  return router;
}

/**
 * The routes for `/api/agents/:id/todo-promises`: a person adds a promise for an
 * agent. The agents group registers nothing on this path, so it is answered here.
 *
 * @param deps - The service, the agent lookup and the owner checks.
 * @returns The routes, to mount at `/api/agents/:id/todo-promises`.
 */
export function createAgentTodoPromisesRoutes(deps: TodoPromiseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/', (c) => {
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts)) {
      return problem(c, 'person_only', {
        detail: 'Agents record their own promises with todo_promise_add.',
      });
    }
    if (!deps.isOwner(facts)) return problem(c, 'owner_only', { detail: NOT_YOUR_AGENT });
    const body = CreateTodoPromiseRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
    // Mounted under `/api/agents/:id/todo-promises`: the parent path's parameter.
    const agentId = c.req.param('id') as string;
    if (!deps.agentExists(agentId)) {
      return problem(c, 'not_found', { detail: 'No agent on the team has that id.' });
    }
    try {
      return c.json(deps.service.create(agentId, body.data, personOf(facts, deps)), 201);
    } catch (err) {
      return todoRefusal(c, err);
    }
  });

  return router;
}
