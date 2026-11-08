/**
 * The to-do routes (DOR-3088): list, make and change to-dos at `/api/todos`. Mounted only behind
 * `DORKOS_TODOS_ENABLED` until v1 is complete.
 *
 * ## Who is asking
 *
 * - An agent presenting its identity may list. It makes and changes to-dos with `todo_add` and
 *   `todo_update`, which carry its turn's power, so its writes here are refused.
 * - A person writes with `person` authority only when the request proves it: the owner's own
 *   session cookie (`personProof`). A window of the app with no session yet is asked for the
 *   owner's step-up (`401 person_session_required`) before anything is written, so the person's
 *   own to-dos never drop to the stranger bound by accident. Any other caller (a program on this
 *   computer) writes as an unproven person: the stranger bound, shown on the to-do. Only on an
 *   install with no owner account may it finish, reopen, note or reorder a to-do assigned to the
 *   person; it changes nothing else (`todo-policy`).
 *
 * @module routes/todos
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { PERSON_APP_HEADER, PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import {
  CreateTodoRequestSchema,
  ListTodosQuerySchema,
  UpdateTodoRequestSchema,
} from '@dorkos/shared/todo-schemas';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody, validationFailureBody } from '../lib/route-utils.js';
import {
  isPersonWithoutSession,
  PERSON_SESSION_REQUIRED_MESSAGE,
} from '../lib/person-without-session.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import {
  TodoPromiseError,
  PERSON_ASSIGNER,
  type TodoPromiseErrorCode,
} from '../services/todos/todo-promise-service.js';
import type { TodoActor } from '../services/todos/todo-authority.js';
import type { TodoAssignee, TodoService, TodoSource } from '../services/todos/todo-service.js';
import { titleIsFromSource, type TodoSourceFacts } from '../services/todos/todo-source.js';

/** What the routes are built from. */
export interface TodoRouterDeps {
  /** Makes, changes and lists to-dos. */
  todos: Pick<TodoService, 'create' | 'update' | 'list' | 'get'>;
  /** Whether a request proves the owner in person (`personProof`). */
  personProven(facts: RequestFacts): boolean;
  /** Whether this install has an owner account; when it doesn't, nobody can be proven. */
  ownerExists(): boolean;
  /** Whether an unproven request is an app window to ask for the step-up ({@link todoNeedsStepUp}). */
  needsStepUp(facts: RequestFacts): boolean;
  /** The chat a to-do's latest turn ran in, or null; none when turns aren't wired. */
  workSessionOf?(todoId: string): string | null;
  /** A source message's author and marks, read by the server. */
  readSource(entryId: string): TodoSourceFacts | undefined;
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

/**
 * Whether an unproven write should ask for the owner's step-up instead: it came from a window of
 * the app, which can answer one, and it would be the person at this computer if only it held their
 * session (`isPersonWithoutSession`). A program without the app's marker is not asked.
 *
 * @param facts - The request's facts.
 */
export function todoNeedsStepUp(facts: RequestFacts): boolean {
  const fromTheApp =
    facts.headers[PERSON_APP_HEADER] !== undefined || !!facts.headers['x-client-id'];
  return fromTheApp && isPersonWithoutSession(facts);
}

/**
 * The assignee a request names, with every person read as the one who owns this DorkOS: v1 has one
 * person, so an account in the body never picks somebody else's list.
 */
function ownersAssignee(assignee: TodoAssignee): TodoAssignee {
  return assignee.kind === 'person' ? { kind: 'person', account: PERSON_ASSIGNER } : assignee;
}

/**
 * The person writing, or the answer to give instead: agents are refused, and an app window with
 * no session is asked to step up first.
 */
function personActor(
  c: Context<ApiEnv>,
  deps: TodoRouterDeps
): { actor: TodoActor } | { refused: Response } {
  const facts = honoRequestFacts(c);
  if (presentsAgentIdentity(facts)) {
    return {
      refused: c.json(
        errorBody('Agents make and change to-dos with todo_add and todo_update.', 'NOT_A_PERSON'),
        403
      ),
    };
  }
  const proven = deps.personProven(facts);
  if (!proven && deps.needsStepUp(facts)) {
    return {
      refused: c.json(
        errorBody(PERSON_SESSION_REQUIRED_MESSAGE, PERSON_SESSION_REQUIRED_CODE),
        401
      ),
    };
  }
  return {
    actor: proven
      ? { kind: 'person', proven }
      : { kind: 'person', proven, ownerless: !deps.ownerExists() },
  };
}

/**
 * The routes for `/api/todos`.
 *
 * @param deps - The service and the lookups.
 * @returns The routes, to mount at `/api/todos`.
 */
export function createTodosRoutes(deps: TodoRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const query = ListTodosQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    return c.json(deps.todos.list(query.data));
  });

  // One to-do, for its card: read with the same reach as the list, so a card never shows a to-do
  // the reader's list wouldn't. An id nobody can read answers 404, and the card says so.
  router.get('/:id', (c) => {
    const todo = deps.todos.get(c.req.param('id'));
    if (!todo) return c.json(errorBody('No to-do has that id.', 'NOT_FOUND'), 404);
    return c.json({ ...todo, workSessionId: deps.workSessionOf?.(todo.id) ?? null });
  });

  router.post('/', (c) => {
    const body = CreateTodoRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const caller = personActor(c, deps);
    if ('refused' in caller) return caller.refused;
    const { sourceEntryId, ...input } = body.data;
    let source: TodoSource | undefined;
    let roomId = input.roomId;
    if (sourceEntryId) {
      // The source's author and marks are the server's own read, never the body's.
      const facts = deps.readSource(sourceEntryId);
      if (!facts) return c.json(errorBody('No message has that id.', 'NOT_FOUND'), 404);
      source = {
        entryId: facts.entryId,
        author: facts.author,
        marks: facts.marks,
        titleFromSource: titleIsFromSource(input.what, facts),
      };
      // A to-do made from a message belongs to that message's room, whatever the body says.
      roomId = facts.roomId;
    }
    try {
      const todo = deps.todos.create(caller.actor, {
        ...input,
        assignee: ownersAssignee(input.assignee),
        ...(roomId ? { roomId } : {}),
        ...(source ? { source } : {}),
      });
      return c.json(todo, 201);
    } catch (err) {
      return refusal(c, err);
    }
  });

  router.patch('/:id', (c) => {
    const body = UpdateTodoRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const caller = personActor(c, deps);
    if ('refused' in caller) return caller.refused;
    try {
      const { assignee, ...change } = body.data;
      return c.json(
        deps.todos.update(caller.actor, c.req.param('id'), {
          ...change,
          ...(assignee ? { assignee: ownersAssignee(assignee) } : {}),
        })
      );
    } catch (err) {
      return refusal(c, err);
    }
  });

  return router;
}
