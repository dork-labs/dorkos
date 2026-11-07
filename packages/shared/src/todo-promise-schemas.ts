/**
 * Zod schemas for to-dos: what an agent promised, to whom, and by when
 * (spec `heartbeats` §12, canon PROACTIVE-AGENTS §5.5).
 *
 * DorkOS keeps the list, not the agent's chat, so anyone in the space can read
 * every agent's promises. `overdue` is computed when a to-do is read and is
 * never stored.
 *
 * @module shared/todo-promise-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The longest a promise's text may be. */
export const TODO_WHAT_MAX = 300;

/** The longest a note on a to-do may be. */
export const TODO_NOTE_MAX = 500;

/** The longest a `to` value may be. */
export const TODO_TO_MAX = 200;

/**
 * The prefix a `to` value carries when the promise was made to an outsider
 * (`external:Acme`), as opposed to a person's account or an agent id.
 */
export const TODO_EXTERNAL_PREFIX = 'external:';

/** Where a to-do stands. */
export const TodoStateSchema = z.enum(['open', 'kept', 'missed', 'dropped']).openapi('TodoState');

/** A to-do's state. */
export type TodoState = z.infer<typeof TodoStateSchema>;

/** One to-do, as every reader sees it. */
export const TodoPromiseSchema = z
  .object({
    id: z.string(),
    /** The Mesh id of the agent that promised. */
    agentId: z.string(),
    /** To whom: an account, an agent id, or `external:<label>`; null when unnamed. */
    to: z.string().nullable(),
    /** What was promised. */
    what: z.string(),
    /** When it is due (ISO 8601), or null. */
    dueAt: z.string().nullable(),
    state: TodoStateSchema,
    /** Open with a due date in the past. Computed on read, never stored. */
    overdue: z.boolean(),
    /** The chat the promise was made in, or null. */
    sourceSessionId: z.string().nullable(),
    /** The room message the promise was made in, or null. */
    sourceRoomEntryId: z.string().nullable(),
    createdAt: z.string(),
    /** When it left `open`, or null while open. */
    closedAt: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi('TodoPromise');

/** One to-do. */
export type TodoPromise = z.infer<typeof TodoPromiseSchema>;

/** An ISO 8601 date-time with an offset, the form every due date takes. */
const DueAtSchema = z.string().datetime({ offset: true });

/** What a person sends to add a to-do for an agent. */
export const CreateTodoPromiseRequestSchema = z
  .object({
    what: z.string().trim().min(1).max(TODO_WHAT_MAX),
    to: z.string().trim().min(1).max(TODO_TO_MAX).optional(),
    dueAt: DueAtSchema.optional(),
  })
  .openapi('CreateTodoPromiseRequest');

/** A create-to-do request. */
export type CreateTodoPromiseRequest = z.infer<typeof CreateTodoPromiseRequestSchema>;

/**
 * What changes a to-do: its new state, and optionally a new due date and a
 * note. A new `dueAt` with state `open` moves the date.
 */
export const UpdateTodoPromiseRequestSchema = z
  .object({
    state: TodoStateSchema,
    dueAt: DueAtSchema.nullable().optional(),
    note: z.string().trim().max(TODO_NOTE_MAX).optional(),
    /** The state the caller believes it is in now; a mismatch is refused (`CONFLICT`). */
    from: TodoStateSchema.optional(),
  })
  .openapi('UpdateTodoPromiseRequest');

/** An update-to-do request. */
export type UpdateTodoPromiseRequest = z.infer<typeof UpdateTodoPromiseRequestSchema>;

/** The most rows one list request may ask for. */
export const TODO_PROMISE_LIST_MAX = 500;

/**
 * Filters for listing to-dos. Every one is optional. Open promises are
 * never cut by `limit`; closed ones fill the rest, newest first.
 */
export const ListTodoPromisesQuerySchema = z
  .object({
    agentId: z.string().min(1).optional(),
    state: TodoStateSchema.optional(),
    to: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(TODO_PROMISE_LIST_MAX).optional(),
  })
  .openapi('ListTodoPromisesQuery');

/** A list-to-dos query. */
export type ListTodoPromisesQuery = z.infer<typeof ListTodoPromisesQuerySchema>;

/** The answer to a list request. */
export const ListTodoPromisesResponseSchema = z
  .object({ todoPromises: z.array(TodoPromiseSchema) })
  .openapi('ListTodoPromisesResponse');

/** A list-to-dos response. */
export type ListTodoPromisesResponse = z.infer<typeof ListTodoPromisesResponseSchema>;
