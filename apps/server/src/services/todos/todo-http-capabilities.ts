/**
 * The to-do doors the app reads and the owner's "add a promise" (DOR-4978), as capabilities the
 * mount serves on their REST paths (ADR 261123-170830):
 *
 * - `todos.view_list` — `GET /api/todos`: a view's to-dos, the hidden done count and the badge.
 * - `todos.view_card` — `GET /api/todos/{id}`: one to-do for its card, and its latest turn's chat.
 * - `todos.view_promises` — `GET /api/todo-promises`: every agent's promises.
 * - `todos.add_promise_for_agent` — `POST /api/agents/{id}/todo-promises`: the owner records a
 *   promise for an agent.
 *
 * The reads are open to anyone in the space, agents included, in the To-dos area like the agents'
 * own list tools; which chat a promise was made in (`sourceSessionId`) is shown only to the owner.
 * Adding a promise is person-only (`http.audience: 'person'`): an agent records its own with
 * `todo_promise_add`, which carries its turn's power.
 *
 * The owner checks read the HTTP request (`context.request`), as the hand routes did: whether a
 * request proves the owner depends on how it was signed in, not only on who. A call with no
 * request (in-process) is never the owner.
 *
 * Two domains of their own in the `todos.` namespace, beside the agents' tools in
 * `todo-capabilities.ts` and `todo-promise-capabilities.ts`, never one of their ids: the reads of
 * to-dos are behind `DORKOS_TODOS_ENABLED` like the agents' to-do tools, the promise doors are not.
 *
 * Every one marks a calling agent's turn when what it hands back holds a stranger's words
 * (`markTurnIfOutside`, DOR-4666), as the agents' own to-do tools do.
 *
 * @module services/todos/todo-http-capabilities
 */
import { z } from 'zod';
import {
  CreateTodoPromiseRequestSchema,
  ListTodoPromisesQuerySchema,
  ListTodoPromisesResponseSchema,
  TodoPromiseSchema,
} from '@dorkos/shared/todo-promise-schemas';
import {
  ListTodosQuerySchema,
  ListTodosResponseSchema,
  TodoCardSchema,
} from '@dorkos/shared/todo-schemas';
import {
  type CapabilityHandlerContext,
  type CapabilityRequestFacts,
} from '../core/capabilities/index.js';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../core/capabilities/capability-definition.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { TodoPromiseError, type TodoPromiseService } from './todo-promise-service.js';
import type { TodoPromiseActor } from './todo-promise-types.js';
import type { TodoService } from './todo-service.js';
import { markTurnIfOutside } from './todo-word-marks.js';

/**
 * The owner checks a person's promise doors make on a request, read from what the server worked
 * out about it (`CapabilityRequestFacts`, built in `routes/capability-dispatch.ts`), never its headers.
 */
export interface TodoPromiseOwnerChecks {
  /**
   * Whether this caller is the person who owns this install. Only the owner sees which chat a
   * promise was made in (`sourceSessionId`): chats are owner-only everywhere else too.
   *
   * @param request - What the server worked out about the request.
   */
  isOwner(request: CapabilityRequestFacts): boolean;
  /**
   * Whether this request proves the owner in person: the owner's own session cookie
   * (`personProof`). Once an owner account exists, only then does a change carry `person`
   * authority (DOR-3088); the open gate `isOwner` passes with login off is not proof, since any
   * program here can reach it.
   *
   * @param request - What the server worked out about the request.
   */
  personProven(request: CapabilityRequestFacts): boolean;
  /**
   * Whether this install has an owner account. When it has none, nobody can be proven, and a
   * person at this computer writes as the person (DOR-3832). A failed lookup must read as an
   * owner, so this fails closed.
   */
  ownerExists(): boolean;
}

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The app's to-do reads; present while `DORKOS_TODOS_ENABLED` is on. */
    todoViewDeps?: {
      /** Lists and reads to-dos. */
      todos: Pick<TodoService, 'list' | 'get'>;
      /** The chat a to-do's latest turn ran in, or null; absent when turns aren't wired. */
      workSessionOf?(todoId: string): string | null;
      /** Whether a to-do's stored words came from outside the team (DOR-4666). */
      carriesOutsideWords?(id: string): boolean;
    };
    /** The promise reads and the owner's "add a promise". */
    todoPromiseHttpDeps?: TodoPromiseOwnerChecks & {
      /** The to-dos service. */
      service: Pick<TodoPromiseService, 'create' | 'list'>;
      /**
       * Whether an agent with this Mesh id is on the team.
       *
       * @param agentId - The Mesh id.
       */
      agentExists(agentId: string): boolean;
      /** Whether a promise's stored words came from outside the team (DOR-4666). */
      carriesOutsideWords?(id: string): boolean;
    };
  }
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
 * `person` authority the way promises do is a follow-up (DOR-4837).
 *
 * @param request - What the server worked out about the request.
 * @param deps - The owner checks.
 * @returns The person actor.
 */
export function promisePersonOf(
  request: CapabilityRequestFacts,
  deps: Pick<TodoPromiseOwnerChecks, 'personProven' | 'ownerExists'>
): Extract<TodoPromiseActor, { kind: 'person' }> {
  const proven = deps.personProven(request);
  if (proven) return { kind: 'person', proven };
  // The owner's held Wi-Fi sign-in may give an agent no work (`mayGiveAgentWork`).
  if (request.heldWifiOwner) return { kind: 'person', proven, held: true };
  // Where the request came from first: the owner lookup fails closed on its own. A key, token or
  // bearer is a program, not the app, as in `requirePersonAtThisComputer`.
  const ownerless = request.atThisComputerWithoutProgramKey && !deps.ownerExists();
  return { kind: 'person', proven, ownerless };
}

/** Narrow the bag, throwing if the registry was composed without it. */
function viewDepsOf(deps: CapabilityDeps): NonNullable<CapabilityDeps['todoViewDeps']> {
  if (!deps.todoViewDeps) throw new Error('To-dos are unavailable.');
  return deps.todoViewDeps;
}

/** Narrow the bag, throwing if the registry was composed without it. */
function promiseDepsOf(deps: CapabilityDeps): NonNullable<CapabilityDeps['todoPromiseHttpDeps']> {
  if (!deps.todoPromiseHttpDeps) throw new Error('To-dos are unavailable.');
  return deps.todoPromiseHttpDeps;
}

/** The To-dos area, as the agents' own to-do tools are in. */
const AREA_NOTE = 'reads to-dos the agents’ own list tools already read';

/** The to-do reads; registered while `DORKOS_TODOS_ENABLED` is on, like the agents' tools. */
export const todoViewDomain: CapabilityDomain = {
  name: 'todos',
  assertDeps: viewDepsOf,
  capabilities: [
    defineCapability({
      id: 'todos.view_list',
      title: 'Open a to-do list',
      description:
        'To-dos for a view (assigned to the person by default), open first, with how many done ' +
        'ones the view hides and the rail badge.',
      tier: 'observe',
      area: 'todos',
      areaNote: AREA_NOTE,
      // `showDone` arrives as the query string's word; the shared schema's transform has no JSON
      // Schema, so the word is read here.
      input: z.object({
        ...ListTodosQuerySchema.shape,
        showDone: z.enum(['true', 'false']).optional().describe('Include done and declined ones.'),
      }),
      output: ListTodosResponseSchema,
      surfaces: { http: { method: 'get', path: '/api/todos' } },
      invoke: async (deps, { showDone, ...filter }, context) => {
        const view = viewDepsOf(deps);
        const list = view.todos.list({
          ...filter,
          ...(showDone === undefined ? {} : { showDone: showDone === 'true' }),
        });
        markIfInTurn(
          context,
          list.todos.map((todo) => todo.id),
          view.carriesOutsideWords
        );
        return list;
      },
    }),
    defineCapability({
      id: 'todos.view_card',
      title: 'Open a to-do',
      description:
        'One to-do, read with the same reach as the list, and the chat its latest turn ran in. A ' +
        "to-do's card in a Direct chat draws from this.",
      tier: 'observe',
      area: 'todos',
      areaNote: AREA_NOTE,
      input: z.object({ id: z.string().min(1).describe('The to-do.') }),
      output: TodoCardSchema,
      surfaces: { http: { method: 'get', path: '/api/todos/{id}' } },
      invoke: async (deps, input, context) => {
        const view = viewDepsOf(deps);
        const todo = view.todos.get(input.id);
        if (!todo) {
          throw new CapabilityToolError({ code: 'TODO_NOT_FOUND', error: 'No to-do has that id.' });
        }
        markIfInTurn(context, [todo.id], view.carriesOutsideWords);
        return { ...todo, workSessionId: view.workSessionOf?.(todo.id) ?? null };
      },
    }),
  ],
};

/**
 * Whether the caller owns this install; an agent, or a call with no HTTP request, never does.
 *
 * @param deps - The owner checks.
 * @param context - The call.
 */
export function callerIsOwner(
  deps: Pick<TodoPromiseOwnerChecks, 'isOwner'>,
  context: CapabilityHandlerContext
): context is CapabilityHandlerContext & { request: CapabilityRequestFacts } {
  if (context.agentIdentityPresented || context.identity) return false;
  return context.request !== undefined && deps.isOwner(context.request);
}

/**
 * Mark a calling agent's turn when what it gets back holds a stranger's words (DOR-4666), only
 * when there is a turn to mark: a call with neither a session nor a server principal has none.
 *
 * @param context - The call.
 * @param ids - The to-dos handed back.
 * @param carriesOutsideWords - Whether a to-do's stored words came from outside the team.
 */
export function markIfInTurn(
  context: CapabilityHandlerContext,
  ids: readonly string[],
  carriesOutsideWords: ((id: string) => boolean) | undefined
): void {
  if (context.sessionId === undefined && context.serverPrincipal === undefined) return;
  markTurnIfOutside(context, ids, carriesOutsideWords);
}

/** The promise read and the owner's "add a promise"; on every server that runs to-dos. */
export const todoPromiseHttpDomain: CapabilityDomain = {
  name: 'todos',
  assertDeps: promiseDepsOf,
  capabilities: [
    defineCapability({
      id: 'todos.view_promises',
      title: 'Open what agents promised',
      description:
        "Every agent's promises: open first (soonest due first), then kept, missed and dropped, " +
        'newest first. `overdue` is worked out on read. Only the owner sees the chat each was ' +
        'made in.',
      tier: 'observe',
      area: 'todos',
      areaNote: AREA_NOTE,
      input: z.object(ListTodoPromisesQuerySchema.shape),
      output: ListTodoPromisesResponseSchema,
      surfaces: { http: { method: 'get', path: '/api/todo-promises' } },
      invoke: async (deps, input, context) => {
        const promises = promiseDepsOf(deps);
        const { limit, ...filter } = input;
        const list = promises.service.list(filter, limit);
        markIfInTurn(
          context,
          list.map((item) => item.id),
          promises.carriesOutsideWords
        );
        return {
          todoPromises: callerIsOwner(promises, context)
            ? list
            : list.map((item) => ({ ...item, sourceSessionId: null })),
        };
      },
    }),
    defineCapability({
      id: 'todos.add_promise_for_agent',
      title: 'Add a promise for an agent',
      description:
        'The owner records something an agent promised: what, to whom, and when it is due. ' +
        'Agents record their own with `todo_promise_add`.',
      tier: 'act',
      area: null,
      areaNote: 'a person’s own record of an agent’s promise; agents use todo_promise_add',
      input: CreateTodoPromiseRequestSchema.extend({
        agentId: z.string().min(1).describe('The Mesh id of the agent that promised it.'),
      }),
      output: TodoPromiseSchema,
      surfaces: {
        http: {
          method: 'post',
          path: '/api/agents/{id}/todo-promises',
          params: { id: 'agentId' },
          success: 201,
          audience: 'person',
        },
      },
      invoke: async (deps, { agentId, ...promise }, context) => {
        const promises = promiseDepsOf(deps);
        if (!callerIsOwner(promises, context)) {
          throw new CapabilityToolError({
            code: 'TODO_PROMISE_OWNER_ONLY',
            error: 'Only the owner of this agent can change its to-dos.',
          });
        }
        if (!promises.agentExists(agentId)) {
          throw new CapabilityToolError({
            code: 'TODO_AGENT_NOT_FOUND',
            error: 'No agent on the team has that id.',
          });
        }
        try {
          const made = promises.service.create(
            agentId,
            promise,
            promisePersonOf(context.request, promises)
          );
          // Only a person reaches here, so nothing is marked; the call is classed as the rest.
          markIfInTurn(context, [made.id], promises.carriesOutsideWords);
          return made;
        } catch (error) {
          // A person meets only a past date here; anything else is a fault.
          if (error instanceof TodoPromiseError && error.code === 'PAST_DUE') {
            throw new CapabilityToolError({ code: 'TODO_PROMISE_PAST_DUE', error: error.message });
          }
          throw error;
        }
      },
    }),
  ],
};
