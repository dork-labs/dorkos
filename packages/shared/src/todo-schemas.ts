/**
 * Zod schemas for to-dos (DOR-3088): one thing someone has to do, assigned to one agent or one
 * person, on the same record as an agent's promises (`commitment-schemas.ts`).
 *
 * Field and state names follow the To-dos spec exactly (`what`, assignee, `assignedBy`, `to`,
 * `dueAt`, room, `sourceEntryId`, notes, `rank`; open / kept / dropped + note), so other views
 * (mini apps) can read the same record. Who assigned a to-do, its chain and its stored power are
 * set by the server and are never accepted from a caller.
 *
 * @module shared/todo-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import {
  COMMITMENT_NOTE_MAX,
  COMMITMENT_TO_MAX,
  COMMITMENT_WHAT_MAX,
  CommitmentStateSchema,
} from './commitment-schemas.js';

extendZodWithOpenApiOnce();

/** The longest a to-do's notes may be. */
export const TODO_NOTES_MAX = 2000;

/** The longest a sort key may be. */
export const TODO_RANK_MAX = 64;

/** The most to-dos one list request returns. */
export const TODO_LIST_MAX = 500;

/** Who a to-do is assigned to. */
export const TodoAssigneeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
    z.object({ kind: z.literal('person'), account: z.string().min(1) }),
  ])
  .openapi('TodoAssignee');

/** A to-do's assignee. */
export type TodoAssignee = z.infer<typeof TodoAssigneeSchema>;

/** One to-do, as readers see it. Its stored power stays on the server. */
export const TodoSchema = z
  .object({
    id: z.string(),
    what: z.string(),
    assignee: TodoAssigneeSchema,
    /** Who made it: recorded once, never editable. */
    assignedBy: z.object({ kind: z.enum(['agent', 'person', 'outsider']), id: z.string() }),
    to: z.string().nullable(),
    dueAt: z.string().nullable(),
    state: CommitmentStateSchema,
    /** Open with a due date in the past. Computed on read, never stored. */
    overdue: z.boolean(),
    roomId: z.string().nullable(),
    sourceEntryId: z.string().nullable(),
    /** Who wrote the source message, when it came from one. */
    sourceAuthor: z.string().nullable(),
    /** Whether the title is still the source's words, unedited. */
    titleFromSource: z.boolean(),
    notes: z.string().nullable(),
    /** How it ended, or why it was declined. */
    note: z.string().nullable(),
    rank: z.string().nullable(),
    chainDepth: z.number().int(),
    /**
     * True when it runs at the stranger's bound: an outsider touched it, or a request that did not
     * prove the person made or changed it. Shown on the to-do so the drop is never silent.
     */
    strangerBound: z.boolean(),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .openapi('Todo');

/** One to-do. */
export type Todo = z.infer<typeof TodoSchema>;

/** An ISO 8601 date-time with an offset. */
const DueAtSchema = z.string().datetime({ offset: true });

/** What a person sends to make a to-do. Who made it is never in the body. */
export const CreateTodoRequestSchema = z
  .object({
    what: z.string().trim().min(1).max(COMMITMENT_WHAT_MAX),
    assignee: TodoAssigneeSchema,
    to: z.string().trim().min(1).max(COMMITMENT_TO_MAX).optional(),
    dueAt: DueAtSchema.optional(),
    roomId: z.string().min(1).optional(),
    notes: z.string().trim().max(TODO_NOTES_MAX).optional(),
    rank: z.string().max(TODO_RANK_MAX).optional(),
    /**
     * The room message it is made from. The server reads its author, its marks, and whether the
     * title is still its words, itself.
     */
    sourceEntryId: z.string().min(1).optional(),
  })
  .strict()
  .openapi('CreateTodoRequest');

/** A create-to-do request. */
export type CreateTodoRequest = z.infer<typeof CreateTodoRequestSchema>;

/** What changes a to-do. Every field is optional; at least one must change something. */
export const UpdateTodoRequestSchema = z
  .object({
    state: z.enum(['open', 'kept', 'dropped']).optional(),
    note: z.string().trim().max(COMMITMENT_NOTE_MAX).optional(),
    what: z.string().trim().min(1).max(COMMITMENT_WHAT_MAX).optional(),
    notes: z.string().trim().max(TODO_NOTES_MAX).nullable().optional(),
    dueAt: DueAtSchema.nullable().optional(),
    assignee: TodoAssigneeSchema.optional(),
    rank: z.string().max(TODO_RANK_MAX).nullable().optional(),
    /** The state the caller believes it is in; a mismatch is refused (`CONFLICT`). */
    from: CommitmentStateSchema.optional(),
  })
  .strict()
  .openapi('UpdateTodoRequest');

/** An update-to-do request. */
export type UpdateTodoRequest = z.infer<typeof UpdateTodoRequestSchema>;

/** Which to-dos a list shows. */
export const TodoViewSchema = z.enum(['mine', 'by-me', 'agents', 'everyone']).openapi('TodoView');

/** A list view. */
export type TodoView = z.infer<typeof TodoViewSchema>;

/** Filters for listing to-dos. */
export const ListTodosQuerySchema = z
  .object({
    /** `mine` (assigned to me, the default), `by-me`, `agents`, or `everyone`. */
    view: TodoViewSchema.optional(),
    /** Only to-dos assigned to this agent. */
    agentId: z.string().min(1).optional(),
    /** Only to-dos from this room. */
    roomId: z.string().min(1).optional(),
    /** `overdue`, `today`, `week` or `none`. */
    due: z.enum(['overdue', 'today', 'week', 'none']).optional(),
    /** Include done and declined ones. */
    showDone: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    /** `due` (soonest first, the default) or `rank` (the assignee's own order). */
    sort: z.enum(['due', 'rank']).optional(),
    limit: z.coerce.number().int().min(1).max(TODO_LIST_MAX).optional(),
  })
  .openapi('ListTodosQuery');

/** A list-to-dos query. */
export type ListTodosQuery = z.infer<typeof ListTodosQuerySchema>;

/** The answer to a list request. */
export const ListTodosResponseSchema = z
  .object({
    todos: z.array(TodoSchema),
    /** How many done or declined to-dos the view hides. */
    doneCount: z.number().int(),
    /** The rail badge: the person's open to-dos due today or overdue. */
    badge: z.number().int(),
  })
  .openapi('ListTodosResponse');

/** A list-to-dos response. */
export type ListTodosResponse = z.infer<typeof ListTodosResponseSchema>;
