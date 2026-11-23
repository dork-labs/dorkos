/**
 * The `todos` capability domain (DOR-3088): `todo_add`, `todo_update` and `todos_list`.
 *
 * ## The server says who and how strong
 *
 * No tool takes who made a to-do, its chain or its power. The caller is the verified identity
 * (`callerAgentId`), its power is the calling turn's level and marks, and its chain comes from
 * the to-do whose turn the call is in (`TodoTurns.parentOf`), read from the server's own ledger.
 * A message cited as the source is read by the server, author and marks included
 * (`readTodoSourceFacts`), and only from a room the calling agent is in.
 *
 * ## Never from a marked or capped turn (Security's Must 7)
 *
 * In a turn that carries any mark (an outsider's words, a teammate's chain), or a to-do turn held
 * below the agent's own level, `todo_add` refuses and `todo_update` never hands a to-do on,
 * whatever the chat's level, Full included: the to-do would start another agent's turn on words
 * this one was held back from acting on. The agent tells the person instead. It can still close,
 * reopen or reorder the to-dos assigned to it, so a to-do turn can always finish its own to-do; in
 * a marked turn that is all it can do.
 *
 * ## In a chat only
 *
 * The writing tools are on the in-session server alone: the chain a to-do continues is read from
 * the calling chat (G1), and a call with no chat would skip it.
 *
 * ## Permission
 *
 * The To-dos area (`todos`), the same one the promise tools are in (DOR-3936), so the one row a
 * person sets decides every to-do tool (DOR-3953). These are the stronger of the two: a to-do
 * given to another agent starts its turn. One area rather than two, because a person thinks of
 * both as "its to-dos"; the row's words name both. The caps (5 a day to people, the turn caps)
 * still bound what an allowed call may do.
 *
 * ## Which calls mark the turn
 *
 * Each tool marks its own caller's turn (`self` in DORKOS_TOOL_READS, DOR-4666), and only when a
 * to-do it hands back carries outside words: a stranger made or changed it, or it was made from a
 * stranger's post (its stored marks hold the outsider mark). The team's and the person's own
 * to-dos hand on nothing, so a turn that only makes, keeps and reads those stays clean, and its
 * next send does not ask. Before, every call marked the turn.
 *
 * @module services/todos/todo-capabilities
 */
import { z } from 'zod';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import {
  TODO_NOTE_MAX,
  TODO_TO_MAX,
  TODO_WHAT_MAX,
  type TodoPromise,
} from '@dorkos/shared/todo-promise-schemas';
import { TODO_NOTES_MAX, TODO_RANK_MAX, TodoSchema } from '@dorkos/shared/todo-schemas';
import { marksOf, passedOnLevelOf } from '../core/turn-power/turn-levels.js';
import { hasMarks } from '../core/turn-power/turn-marks.js';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { callerAgentId } from './caller.js';
import { TodoPromiseError, PERSON_ASSIGNER } from './todo-promise-service.js';
import type { TodoActor } from './todo-authority.js';
import type { TodoAssignee, TodoParent, TodoService, TodoSource } from './todo-service.js';
import { titleIsFromSource, type TodoSourceFacts } from './todo-source.js';
import { markTurnIfOutside } from './todo-word-marks.js';
import { changeToTell, type TodoChangeNotice } from './notice/todo-recipient-notice.js';

/** The MCP tool names. */
export const TODO_ADD_TOOL = 'todo_add';
/** See {@link TODO_ADD_TOOL}. */
export const TODO_UPDATE_TOOL = 'todo_update';
/** See {@link TODO_ADD_TOOL}. */
export const TODOS_LIST_TOOL = 'todos_list';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the to-dos service is running; gates the `todos` domain. */
    todoDeps?: {
      /** Makes, changes and lists to-dos. */
      todos: Pick<TodoService, 'create' | 'update' | 'list'>;
      /** The Mesh id of the agent at a home folder. */
      agentIdForPath(agentPath: string): string | undefined;
      /** The to-do whose turn runs in a chat, as its chain (`TodoTurns.parentOf`). */
      parentOf(sessionId: string): TodoParent | undefined;
      /** A source message's author and marks, read by the server. */
      readSource(entryId: string): TodoSourceFacts | undefined;
      /** Whether an agent may cite a message in a room. */
      agentInRoom(roomId: string, agentPath: string): boolean;
      /** A to-do as a promise, so a change through this tool tells its recipient (DOR-3034). */
      promiseOf?(id: string): TodoPromise | undefined;
      /** Tell whoever a promise was made to; the same hook `todo_promise_update` uses. */
      tellRecipient?: (notice: TodoChangeNotice) => Promise<void>;
      /** Whether a to-do's stored words came from outside the team (DOR-4666). */
      carriesOutsideWords?(id: string): boolean;
    };
  }
}

/** A refusal, as every to-do tool answers one. */
const RefusalSchema = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

/** A refusal value. */
type Refusal = z.infer<typeof RefusalSchema>;

/** Narrow the bag, throwing if the registry was composed without it. */
function requireTodoDeps(deps: CapabilityDeps): NonNullable<CapabilityDeps['todoDeps']> {
  if (!deps.todoDeps)
    throw new Error('To-do capability invoked without todoDeps in the registry bag.');
  return deps.todoDeps;
}

/** The refusal for a call from a turn that carries a mark (Must 7). */
const MARKED_TURN: Refusal = {
  ok: false,
  code: 'MARKED_TURN',
  error:
    'This turn read words DorkOS cannot vouch for, or a teammate started it, so it cannot make or ' +
    'hand on to-dos. Tell the person in your chat; they can make the to-do themselves.',
};

/** The refusal for making or handing on a to-do from a capped to-do turn (Must 7). */
const CAPPED_TURN: Refusal = {
  ok: false,
  code: 'CAPPED_TURN',
  error:
    'This turn runs on a to-do held below your own level, so it cannot make or hand on to-dos. ' +
    'Tell the person in your chat; they can make the to-do themselves.',
};

/** The refusal for anything but closing or reordering an own to-do in a marked turn (Must 7). */
const MARKED_TURN_EDIT: Refusal = {
  ok: false,
  code: 'MARKED_TURN',
  error:
    'This turn read words DorkOS cannot vouch for, or a teammate started it. You can only mark ' +
    'to-dos assigned to you done, declined or open, or move them in your order.',
};

/** The refusal for a writing call made outside a chat. */
const NO_SESSION: Refusal = {
  ok: false,
  code: 'NO_SESSION',
  error: 'Make and change to-dos from a chat, where DorkOS can see what started it.',
};

/** The refusal for a call with no agent behind it. */
const NO_AGENT: Refusal = {
  ok: false,
  code: 'NO_AGENT',
  error: 'Only one of your agents can use this tool. A person makes to-dos in the app.',
};

/** The calling turn's level, power axes only, or undefined when this process recorded none. */
function turnLevelOf(
  context: CapabilityHandlerContext
): Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'> | undefined {
  const level = context.sessionId ? passedOnLevelOf(context.sessionId) : undefined;
  if (!level) return undefined;
  return { asks: level.asks, reach: level.reach, ...(level.auto ? { auto: level.auto } : {}) };
}

/** A writing call's caller: the agent, its chat, and the to-do turn that chat descends from. */
interface WritingCall {
  readonly actor: TodoActor & { kind: 'agent' };
  readonly marked: boolean;
  readonly parent: TodoParent | undefined;
}

/**
 * The calling agent as a to-do actor, with its turn's marks and chain, or a refusal: no agent, or
 * no chat. An unknown level is kept unknown, so the to-do gets the stranger bound and the outsider
 * mark.
 */
function writingCall(
  todoDeps: NonNullable<CapabilityDeps['todoDeps']>,
  context: CapabilityHandlerContext
): WritingCall | Refusal {
  const caller = callerAgentId(context.identity, todoDeps.agentIdForPath);
  if (!caller.ok) return NO_AGENT;
  if (!context.sessionId) return NO_SESSION;
  const marks = marksOf(context.sessionId, context.identity?.agentPath);
  return {
    actor: { kind: 'agent', agentId: caller.agentId, level: turnLevelOf(context), marks },
    marked: hasMarks(marks),
    parent: todoDeps.parentOf(context.sessionId),
  };
}

/** Mark the caller's turn when a to-do it gets back carries outside words (DOR-4666). */
function markIfOutside(
  todoDeps: NonNullable<CapabilityDeps['todoDeps']>,
  context: CapabilityHandlerContext,
  ids: readonly string[]
): void {
  markTurnIfOutside(context, ids, todoDeps.carriesOutsideWords);
}

/** Run a to-do tool, answering a refusal the service raised. */
function answer<T>(run: () => T): T | Refusal {
  try {
    return run();
  } catch (err) {
    if (err instanceof TodoPromiseError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/** An assignee, as an agent names one: an agent by id, or `person` for the person. */
const AssigneeInput = z
  .union([z.literal('person'), z.string().min(1).max(100)])
  .describe('An agent id, or "person" to give it to the person who owns this DorkOS.');

/** The assignee an input names. */
function assigneeOf(value: string): TodoAssignee {
  return value === 'person'
    ? { kind: 'person', account: PERSON_ASSIGNER }
    : { kind: 'agent', agentId: value };
}

/**
 * Whether an update asks for more than a marked turn may do: anything but the state, how it ended
 * and the order. Whose to-do it is, the service checks (`mayChangeState`, `mayRank`).
 */
function ownOnlyFieldsBreached(input: Record<string, unknown>): boolean {
  return Object.entries(input).some(
    ([field, value]) => value !== undefined && !MARKED_TURN_FIELDS.has(field)
  );
}

/** What a marked turn may still send to `todo_update`. */
const MARKED_TURN_FIELDS = new Set(['id', 'state', 'note', 'rank']);

/** An ISO 8601 date-time with an offset. */
const DueAtInput = z.string().datetime({ offset: true });

/** The todos domain. */
export const todosDomain: CapabilityDomain = {
  name: 'todos',
  assertDeps: requireTodoDeps,
  capabilities: [
    defineCapability({
      id: 'todos.add',
      title: 'Make a to-do',
      description:
        'Give a to-do to another agent on your team, to the person ("person"), or to yourself. ' +
        "Another agent's to-do starts its turn; yours is a note to self. You can give people at " +
        'most 5 a day. Cite the room message it came from with `sourceEntryId`. Not available in a ' +
        "turn that read words DorkOS can't vouch for, or one a capped to-do started: tell the " +
        'person instead.',
      tier: 'act',
      area: 'todos',
      // What a card shows if a person sets this to Ask: who gets it first, since an agent's to-do
      // starts its turn, named rather than shown as an id ("person" shows as it is).
      approvalDisplayFields: ['assignee', 'what', 'dueAt'],
      approvalSubject: { field: 'assignee', kind: 'agent' },
      input: z.object({
        what: z.string().trim().min(1).max(TODO_WHAT_MAX).describe('One plain line.'),
        assignee: AssigneeInput,
        to: z.string().trim().min(1).max(TODO_TO_MAX).optional(),
        dueAt: DueAtInput.optional().describe('When it is due; never in the past.'),
        notes: z.string().trim().max(TODO_NOTES_MAX).optional(),
        sourceEntryId: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The room message it came from.'),
      }),
      output: z.union([z.object({ ok: z.literal(true), todo: TodoSchema }), RefusalSchema]),
      surfaces: {
        mcp: {
          toolName: TODO_ADD_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const todoDeps = requireTodoDeps(deps);
        const call = writingCall(todoDeps, context);
        if ('ok' in call) return call;
        if (call.marked) return MARKED_TURN;
        if (call.parent?.capped) return CAPPED_TURN;
        let source: TodoSource | undefined;
        let roomId: string | undefined;
        if (input.sourceEntryId) {
          const facts = todoDeps.readSource(input.sourceEntryId);
          const agentPath = context.identity?.agentPath;
          if (!facts || !agentPath || !todoDeps.agentInRoom(facts.roomId, agentPath)) {
            return {
              ok: false as const,
              code: 'NOT_FOUND',
              error: 'No message you can read has that id.',
            };
          }
          source = {
            entryId: facts.entryId,
            author: facts.author,
            marks: facts.marks,
            titleFromSource: titleIsFromSource(input.what, facts),
          };
          roomId = facts.roomId;
        }
        const made = answer(() => ({
          ok: true as const,
          todo: todoDeps.todos.create(
            call.actor,
            {
              what: input.what,
              assignee: assigneeOf(input.assignee),
              ...(input.to ? { to: input.to } : {}),
              ...(input.dueAt ? { dueAt: input.dueAt } : {}),
              ...(input.notes ? { notes: input.notes } : {}),
              ...(source ? { source } : {}),
              ...(roomId ? { roomId } : {}),
            },
            call.parent
          ),
        }));
        // A to-do made from a stranger's post hands their words back (DOR-4666).
        if (made.ok) markIfOutside(todoDeps, context, [made.todo.id]);
        return made;
      },
    }),
    defineCapability({
      id: 'todos.update',
      title: 'Update a to-do',
      description:
        'Change a to-do. `state: "kept"` when it is done (put the outcome in `note`), `"dropped"` ' +
        'to decline it (say why in `note`). The first due date is kept: a move after the date has ' +
        'passed still counts as late, and a dropped to-do counts as not kept on time. ' +
        'You can change the state only of to-dos assigned to ' +
        'you, and reassign only to-dos you made. In a marked or capped turn you can only close, ' +
        'reopen or reorder your own; the rest waits for the person.',
      tier: 'act',
      area: 'todos',
      // As `todo_promises.update` names its fields, plus a hand-on's new assignee.
      approvalDisplayFields: ['id', 'state', 'assignee', 'dueAt', 'note'],
      input: z.object({
        id: z.string().min(1).max(100).describe('The to-do id, from todos_list.'),
        state: z.enum(['open', 'kept', 'dropped']).optional(),
        note: z.string().trim().max(TODO_NOTE_MAX).optional(),
        what: z.string().trim().min(1).max(TODO_WHAT_MAX).optional(),
        notes: z.string().trim().max(TODO_NOTES_MAX).nullable().optional(),
        dueAt: DueAtInput.nullable().optional(),
        assignee: AssigneeInput.optional(),
        rank: z.string().max(TODO_RANK_MAX).nullable().optional(),
      }),
      output: z.union([z.object({ ok: z.literal(true), todo: TodoSchema }), RefusalSchema]),
      surfaces: {
        mcp: {
          toolName: TODO_UPDATE_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const todoDeps = requireTodoDeps(deps);
        const call = writingCall(todoDeps, context);
        if ('ok' in call) return call;
        const { id, assignee, ...rest } = input;
        if (call.marked && ownOnlyFieldsBreached(input)) return MARKED_TURN_EDIT;
        if (assignee !== undefined && call.parent?.capped) return CAPPED_TURN;
        const before = todoDeps.promiseOf?.(id);
        const result = answer(() => ({
          ok: true as const,
          todo: todoDeps.todos.update(
            call.actor,
            id,
            { ...rest, ...(assignee ? { assignee: assigneeOf(assignee) } : {}) },
            call.parent
          ),
        }));
        // The row it hands back may be one a stranger wrote (DOR-4666).
        if (result.ok) markIfOutside(todoDeps, context, [result.todo.id]);
        // A move, drop or keep through this tool is told the same way (DOR-3034).
        const after = result.ok ? todoDeps.promiseOf?.(id) : undefined;
        const change = after ? changeToTell(before, after) : null;
        if (after && change && call.actor.kind === 'agent' && todoDeps.tellRecipient) {
          void todoDeps.tellRecipient({
            todoPromise: after,
            change,
            reason: input.note || null,
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.identity?.agentPath ? { agentPath: context.identity.agentPath } : {}),
          });
        }
        return result;
      },
    }),
    defineCapability({
      id: 'todos.list',
      title: 'Read to-dos',
      description:
        "Read to-dos: yours (`agentId` = your id), the agents', or everyone's. Open ones first, " +
        'soonest due first; `showDone` adds finished ones.',
      tier: 'observe',
      area: 'todos',
      input: z.object({
        view: z.enum(['agents', 'everyone']).optional().describe('Defaults to everyone.'),
        agentId: z.string().min(1).max(100).optional(),
        showDone: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ todos: z.array(TodoSchema) }),
      surfaces: {
        mcp: {
          toolName: TODOS_LIST_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const todoDeps = requireTodoDeps(deps);
        const { todos } = todoDeps.todos.list({
          view: input.view ?? 'everyone',
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.showDone ? { showDone: true } : {}),
          limit: input.limit ?? 50,
        });
        // A stranger's to-do in the list hands their words on; the team's alone do not (DOR-4666).
        markIfOutside(
          todoDeps,
          context,
          todos.map((todo) => todo.id)
        );
        return { todos };
      },
    }),
  ],
};
