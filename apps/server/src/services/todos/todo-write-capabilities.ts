/**
 * A person's to-do writes (DOR-4978), as capabilities the mount serves on the paths the app
 * always used (ADR 261123-170830):
 *
 * - `todos.add_as_person`: `POST /api/todos` (201): the person makes a to-do.
 * - `todos.change_as_person`: `PATCH /api/todos/{id}`: mark it done or declined, reopen, edit,
 *   move or reassign it.
 * - `todos.change_promise`: `PATCH /api/todo-promises/{id}`: close an agent's promise or move its
 *   date.
 * - `todos.confirm_promise`: `POST /api/todo-promises/{id}/confirm`: answer "was it kept?".
 *
 * ## Who may call them
 *
 * Only a person (`http.audience: 'person'`): an agent makes and changes to-dos with `todo_add`
 * and `todo_update`, and its promises with `todo_promise_update`, which carry its turn's power and
 * its To-dos setting. The registry refuses everyone else `person_only` before a handler runs, and
 * an app window with no session yet is asked for the owner's step-up instead
 * (`http/person-session-refusal.ts`), so nothing is written first.
 *
 * Each is `person-held` (ADR 261125-114705, decision 3): the app makes these from any device on
 * purpose (DOR-5070), and the mount holds them to the Wi-Fi hold. What the handler reads is only
 * the mount's yes/no answers (`context.request`): a held device never proves the owner, and is
 * named as the owner's held sign-in, which gets the no-owner allowance and nothing more: finish,
 * reopen, note or reorder a to-do assigned to the person (`todo-policy`). It may make a to-do for
 * the person, but never give an agent work: an agent's to-do, or a change or answer on an agent's
 * promise, is refused `person_only` (`mayGiveAgentWork`, Security 2026-11-25).
 *
 * Refusals keep the hand routes' codes and sentences (`todo-refusals.ts`).
 *
 * @module services/todos/todo-write-capabilities
 */
import { z } from 'zod';
import {
  ConfirmTodoPromiseRequestSchema,
  TodoPromiseSchema,
  UpdateTodoPromiseRequestSchema,
} from '@dorkos/shared/todo-promise-schemas';
import {
  CreateTodoRequestSchema,
  TodoSchema,
  UpdateTodoRequestSchema,
} from '@dorkos/shared/todo-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import type { TodoConfirm } from './notice/todo-confirm.js';
import type { TodoActor } from './todo-authority.js';
import {
  callerIsOwner,
  markIfInTurn,
  promisePersonOf,
  type TodoPromiseOwnerChecks,
} from './todo-http-capabilities.js';
import { PERSON_ASSIGNER, type TodoPromiseService } from './todo-promise-service.js';
import { throwTodoRefusal } from './todo-refusals.js';
import type { TodoAssignee, TodoService, TodoSource } from './todo-service.js';
import { titleIsFromSource, type TodoSourceFacts } from './todo-source.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** A person's to-do writes; present while `DORKOS_TODOS_ENABLED` is on. */
    todoWriteDeps?: {
      /** Makes and changes to-dos. */
      todos: Pick<TodoService, 'create' | 'update'>;
      /**
       * Whether this install has an owner account; when it doesn't, nobody can be proven. A failed
       * lookup must read as an owner, so the no-owner allowance fails closed.
       */
      ownerExists(): boolean;
      /** A source message's author, room and marks, read by the server. */
      readSource(entryId: string): TodoSourceFacts | undefined;
      /** Whether a to-do's stored words came from outside the team (DOR-4666). */
      carriesOutsideWords?(id: string): boolean;
    };
    /** A person's changes to agents' promises, and their "was it kept?" answer. */
    todoPromiseWriteDeps?: TodoPromiseOwnerChecks & {
      /** The to-dos service. */
      service: Pick<TodoPromiseService, 'update'>;
      /** Takes a person's answer to "was it kept?" (DOR-3034). */
      confirm: Pick<TodoConfirm, 'answer'>;
      /** Whether a promise's stored words came from outside the team (DOR-4666). */
      carriesOutsideWords?(id: string): boolean;
    };
  }
}

/** Narrow the bag, throwing if the registry was composed without it. */
function writeDepsOf(deps: CapabilityDeps): NonNullable<CapabilityDeps['todoWriteDeps']> {
  if (!deps.todoWriteDeps) throw new Error('To-dos are unavailable.');
  return deps.todoWriteDeps;
}

/** Narrow the bag, throwing if the registry was composed without it. */
function promiseWriteDepsOf(
  deps: CapabilityDeps
): NonNullable<CapabilityDeps['todoPromiseWriteDeps']> {
  if (!deps.todoPromiseWriteDeps) throw new Error('To-dos are unavailable.');
  return deps.todoPromiseWriteDeps;
}

/** Why a person's writes have no area: no agent can call them. */
const AREA_NOTE =
  'a person’s own to-do writes; agents use todo_add, todo_update and the promise tools';

/**
 * The person writing. Only the mount's answers decide it: proven by the owner's own session
 * (`ownerProven`, which a held Wi-Fi device never is), else unproven, with the no-owner allowance
 * when the install has no owner account or the request is the owner's held Wi-Fi sign-in. A call
 * with no HTTP request gets the allowance only on an install with no owner.
 */
function personActorOf(
  context: CapabilityHandlerContext,
  deps: Pick<NonNullable<CapabilityDeps['todoWriteDeps']>, 'ownerExists'>
): TodoActor {
  const request = context.request;
  if (request?.ownerProven) return { kind: 'person', proven: true };
  const held = request?.heldWifiOwner === true;
  return { kind: 'person', proven: false, ownerless: !deps.ownerExists() || held, held };
}

/**
 * The assignee a request names, with every person read as the one who owns this DorkOS: v1 has one
 * person, so an account in the body never picks somebody else's list.
 */
function ownersAssignee(assignee: TodoAssignee): TodoAssignee {
  return assignee.kind === 'person' ? { kind: 'person', account: PERSON_ASSIGNER } : assignee;
}

/** A promise door's refusal for a caller who is not this install's owner. */
function ownerOnly(): CapabilityToolError {
  return new CapabilityToolError({
    code: 'TODO_PROMISE_OWNER_ONLY',
    error: 'Only the owner of this agent can change its to-dos.',
  });
}

/** The path's to-do or promise id. */
const ID = { id: z.string().min(1).describe('The to-do.') };

/** A person's to-do writes; registered while `DORKOS_TODOS_ENABLED` is on, like the reads. */
export const todoWriteDomain: CapabilityDomain = {
  name: 'todos',
  assertDeps: writeDepsOf,
  capabilities: [
    defineCapability({
      id: 'todos.add_as_person',
      title: 'Make a to-do',
      description:
        "A person makes a to-do. Only the owner's own sign-in gives it their authority; an app " +
        'window that is not signed in is asked to step up first. Agents use `todo_add`.',
      tier: 'act',
      area: null,
      areaNote: AREA_NOTE,
      wifi: 'person-held',
      input: CreateTodoRequestSchema,
      output: TodoSchema,
      surfaces: {
        http: {
          method: 'post',
          path: '/api/todos',
          success: 201,
          audience: 'person',
          agentsUse: 'Agents make and change to-dos with todo_add and todo_update.',
        },
      },
      invoke: async (deps, input, context) => {
        const write = writeDepsOf(deps);
        const { sourceEntryId, ...rest } = input;
        let source: TodoSource | undefined;
        let roomId = rest.roomId;
        if (sourceEntryId) {
          // The source's author and marks are the server's own read, never the body's.
          const facts = write.readSource(sourceEntryId);
          if (!facts) {
            throw new CapabilityToolError({
              code: 'TODO_SOURCE_NOT_FOUND',
              error: 'No message has that id.',
            });
          }
          source = {
            entryId: facts.entryId,
            author: facts.author,
            marks: facts.marks,
            titleFromSource: titleIsFromSource(rest.what, facts),
          };
          // A to-do made from a message belongs to that message's room, whatever the body says.
          roomId = facts.roomId;
        }
        try {
          const made = write.todos.create(personActorOf(context, write), {
            ...rest,
            assignee: ownersAssignee(rest.assignee),
            ...(roomId ? { roomId } : {}),
            ...(source ? { source } : {}),
          });
          markIfInTurn(context, [made.id], write.carriesOutsideWords);
          return made;
        } catch (err) {
          return throwTodoRefusal(err);
        }
      },
    }),
    defineCapability({
      id: 'todos.change_as_person',
      title: 'Change a to-do',
      description:
        'Mark it done (`kept`) or declined (`dropped` with a note), reopen, edit, move or reassign ' +
        'it. A request that does not prove the person changes nothing. Agents use `todo_update`.',
      tier: 'act',
      area: null,
      areaNote: AREA_NOTE,
      wifi: 'person-held',
      input: UpdateTodoRequestSchema.extend(ID),
      output: TodoSchema,
      surfaces: {
        http: {
          method: 'patch',
          path: '/api/todos/{id}',
          audience: 'person',
          agentsUse: 'Agents make and change to-dos with todo_add and todo_update.',
        },
      },
      invoke: async (deps, { id, assignee, ...change }, context) => {
        const write = writeDepsOf(deps);
        try {
          const changed = write.todos.update(personActorOf(context, write), id, {
            ...change,
            ...(assignee ? { assignee: ownersAssignee(assignee) } : {}),
          });
          markIfInTurn(context, [changed.id], write.carriesOutsideWords);
          return changed;
        } catch (err) {
          return throwTodoRefusal(err);
        }
      },
    }),
  ],
};

/** A person's changes to agents' promises; on every server that runs to-dos, like the reads. */
export const todoPromiseWriteDomain: CapabilityDomain = {
  name: 'todos',
  assertDeps: promiseWriteDepsOf,
  capabilities: [
    defineCapability({
      id: 'todos.change_promise',
      title: 'Close a promise or move its date',
      description:
        'Mark a promise kept, missed or dropped. `state: "open"` moves an open promise to a new ' +
        '`dueAt`, or reopens a closed one. The owner only: agents change their own with ' +
        '`todo_promise_update`.',
      tier: 'act',
      area: null,
      areaNote: AREA_NOTE,
      wifi: 'person-held',
      input: UpdateTodoPromiseRequestSchema.extend({
        id: z.string().min(1).describe('The promise.'),
      }),
      output: TodoPromiseSchema,
      surfaces: {
        http: {
          method: 'patch',
          path: '/api/todo-promises/{id}',
          audience: 'person',
          agentsUse: 'Agents change their own promises with todo_promise_update.',
        },
      },
      invoke: async (deps, { id, ...change }, context) => {
        const promises = promiseWriteDepsOf(deps);
        if (!callerIsOwner(promises, context)) throw ownerOnly();
        try {
          const changed = promises.service.update(
            promisePersonOf(context.request, promises),
            id,
            change
          );
          markIfInTurn(context, [changed.id], promises.carriesOutsideWords);
          return changed;
        } catch (err) {
          return throwTodoRefusal(err);
        }
      },
    }),
    defineCapability({
      id: 'todos.confirm_promise',
      title: 'Answer whether a kept promise was kept',
      description:
        'When an agent marks a promise to a person kept, that person is asked to confirm it ' +
        '(DOR-3034). `yes` confirms it; `not-yet` reopens it. The owner only.',
      tier: 'act',
      area: null,
      areaNote: AREA_NOTE,
      wifi: 'person-held',
      input: ConfirmTodoPromiseRequestSchema.extend({
        id: z.string().min(1).describe('The promise.'),
      }),
      output: TodoPromiseSchema,
      surfaces: {
        http: {
          method: 'post',
          path: '/api/todo-promises/{id}/confirm',
          audience: 'person',
          agentsUse: 'Agents change their own promises with todo_promise_update.',
        },
      },
      invoke: async (deps, { id, answer }, context) => {
        const promises = promiseWriteDepsOf(deps);
        // Any owner of this install may answer: one install is one person until spaces ship.
        if (!callerIsOwner(promises, context)) throw ownerOnly();
        try {
          const answered = promises.confirm.answer(
            promisePersonOf(context.request, promises),
            id,
            answer
          );
          markIfInTurn(context, [answered.id], promises.carriesOutsideWords);
          return answered;
        } catch (err) {
          return throwTodoRefusal(err);
        }
      },
    }),
  ],
};
