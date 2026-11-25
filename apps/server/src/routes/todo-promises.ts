/**
 * To-do routes (spec `heartbeats` §12): a person changing what agents promised.
 *
 * - `PATCH /api/todo-promises/:id` — a person closes one or moves its date. Agents
 *   change their own with `todo_promise_update`, which the permission gate decides,
 *   so a caller presenting an agent identity is refused here (DOR-3936).
 * - `POST /api/todo-promises/:id/confirm` — the person answers "was it kept?" with Yes or Not
 *   yet (DOR-3034). A person only, like the change above.
 *
 * Reading the list and adding one for an agent are `todos.view_promises` and
 * `todos.add_promise_for_agent`, which the capability mount serves
 * (`services/todos/todo-http-capabilities.ts`).
 *
 * Every rule lives in `TodoPromiseService`; this file reads the caller and maps
 * refusals to status codes.
 *
 * @module routes/todo-promises
 */
import { Hono, type Context } from 'hono';
import {
  ConfirmTodoPromiseRequestSchema,
  UpdateTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { todoRefusal } from './todos.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { capabilityRequestFacts } from './capability-dispatch.js';
import { type TodoPromiseActor, type TodoPromiseService } from '../services/todos/index.js';
import {
  promisePersonOf,
  type TodoPromiseOwnerChecks,
} from '../services/todos/todo-http-capabilities.js';
import type { TodoConfirm } from '../services/todos/notice/todo-confirm.js';

/** What the to-do routes need: the service, the owner checks and the "was it kept?" answer. */
export interface TodoPromiseRouterDeps extends TodoPromiseOwnerChecks {
  /** The to-dos service. */
  service: Pick<TodoPromiseService, 'update'>;
  /** Takes a person's answer to "was it kept?" (DOR-3034). */
  confirm: Pick<TodoConfirm, 'answer'>;
}

/** The refusal for a person who is not this install's owner. */
const NOT_YOUR_AGENT = 'Only the owner of this agent can change its to-dos.';

/**
 * Who is changing a to-do over HTTP: a person who owns the agent, or a refusal.
 *
 * Agents are refused here, verified or not, as on `/api/todos`: they change
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
  // The same answers the capability doors read, so the two cannot drift.
  const request = capabilityRequestFacts(facts);
  if (!deps.isOwner(request))
    return { refused: problem(c, 'owner_only', { detail: NOT_YOUR_AGENT }) };
  return { actor: promisePersonOf(request, deps) };
}

/**
 * The routes for `/api/todo-promises`: change and confirm.
 *
 * @param deps - The service and the owner checks.
 * @returns The routes, to mount at `/api/todo-promises`.
 */
export function createTodoPromisesRoutes(deps: TodoPromiseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

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
