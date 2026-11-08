/**
 * The `todos` capability domain (spec `heartbeats` §12): `todo_promise_add`,
 * `todo_promise_update` and `todo_promises_list`.
 *
 * ## The caller is the verified identity
 *
 * `todo_promise_add` takes no "who": the promise is the calling agent's own, read
 * off `context.identity`, and its chat is `context.sessionId`. A call with no
 * agent behind it is refused (`NO_AGENT`); a person adds one for an agent in the
 * app. `todo_promise_update` lets the promising agent or a person change one, and
 * refuses any other agent (`NOT_YOURS`). `todo_promises_list` reads every agent's
 * list, because promises are readable by everyone in the space (canon §5.5).
 *
 * ## Permission
 *
 * All three are in the To-dos area (`todos`, DOR-3936), which every preset
 * Allows. Before, they had no area, so a person's Blocked stored for one of them
 * was read by nothing and the call still ran. Now a Blocked or Ask set for the
 * area, or for one of the three actions, decides the call like any other area.
 *
 * ## Who sees what
 *
 * `todo_promises_list` never returns `sourceSessionId`: which chat a promise was
 * made in is the owner's to see, in the app, and chats are owner-only
 * everywhere else too. It defaults to open promises, 50 rows at most.
 *
 * ## Strangers
 *
 * `todo_promise_add` refuses on a turn that read such words, a Wi-Fi sign-in's
 * included (DOR-3037): the promise's due beat would run at the agent's own
 * level on words the turn was held back from acting on. Not in a chat set to
 * Full autonomy (DOR-3412): nothing held that turn back, so the promise is made,
 * with the turn's marks on it and one Activity line. A teammate's mark is still
 * refused there: it is the space owner's limit.
 *
 * @module services/todos/todo-promise-capabilities
 */
import { z } from 'zod';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { marksOf, passedOnLevelOf } from '../core/turn-power/turn-levels.js';
import { callerAgentId } from './caller.js';
import { marksHold } from '../core/turn-power/turn-marks.js';
import { markedTurnRunsAtFull } from '../core/turn-power/full-autonomy.js';
import {
  TODO_PROMISE_LIST_MAX,
  TODO_NOTE_MAX,
  TODO_TO_MAX,
  TODO_WHAT_MAX,
  TodoPromiseSchema,
  TodoStateSchema,
} from '@dorkos/shared/todo-promise-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import {
  TodoPromiseError,
  type TodoPromiseActor,
  type TodoPromiseService,
} from './todo-promise-service.js';

/** The MCP tool names, exported so prose that names them reads them from here. */
export const TODO_PROMISE_ADD_TOOL = 'todo_promise_add';
/** See {@link TODO_PROMISE_ADD_TOOL}. */
export const TODO_PROMISE_UPDATE_TOOL = 'todo_promise_update';
/** See {@link TODO_PROMISE_ADD_TOOL}. */
export const TODO_PROMISES_LIST_TOOL = 'todo_promises_list';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the to-dos service is running; gates the `todos` domain. */
    todoPromiseDeps?: {
      /** Records, reads and changes to-dos. */
      service: Pick<TodoPromiseService, 'create' | 'update' | 'list'>;
      /**
       * The Mesh id of the agent living at a home folder, or undefined when Mesh
       * does not know it.
       *
       * @param agentPath - The agent's home folder.
       */
      agentIdForPath(agentPath: string): string | undefined;
    };
  }
}

/** A refusal, as every to-do tool answers one. */
const RefusalSchema = z.object({
  ok: z.literal(false),
  /** A stable code. */
  code: z.string(),
  /** A plain sentence for the calling agent. */
  error: z.string(),
});

/** A refusal value. */
type Refusal = z.infer<typeof RefusalSchema>;

/** Narrow the bag, throwing if the registry was composed without it. */
function requireTodoPromiseDeps(
  deps: CapabilityDeps
): NonNullable<CapabilityDeps['todoPromiseDeps']> {
  if (!deps.todoPromiseDeps) {
    throw new Error('To-do capability invoked without todoPromiseDeps in the registry bag.');
  }
  return deps.todoPromiseDeps;
}

/** The refusal for a call with no agent behind it. */
const NO_AGENT: Refusal = {
  ok: false,
  code: 'NO_AGENT',
  error:
    'Only an agent can record its own promise. This chat is not running as one of your agents, ' +
    'so nothing was recorded.',
};

/**
 * What `todo_promise_add` answers from a turn that read words DorkOS cannot
 * vouch for (DOR-3037): a promise's due beat runs at the agent's own level, so
 * a promise made from such a turn would carry those words past its cap.
 */
const OUTSIDER_PROMISE: Refusal = {
  ok: false,
  code: 'OUTSIDER_TURN',
  error:
    "This turn read words DorkOS can't vouch for, such as a Wi-Fi sign-in's, so it can't " +
    'make a promise. Tell the person instead; they can record it at the computer.',
};

/**
 * The calling agent's Mesh id, or a refusal.
 *
 * @param deps - The to-do deps.
 * @param context - The invocation context.
 */
function callingAgentId(
  deps: NonNullable<CapabilityDeps['todoPromiseDeps']>,
  context: CapabilityHandlerContext
): string | Refusal {
  // The one function that names the calling agent (DOR-3640 swaps its source, nothing else).
  const caller = callerAgentId(context.identity, deps.agentIdForPath);
  if (caller.ok) return caller.agentId;
  if (caller.code === 'NO_AGENT') return NO_AGENT;
  return {
    ok: false,
    code: 'UNKNOWN_AGENT',
    error: 'This agent is not registered on the team yet, so its promises cannot be kept here.',
  };
}

/**
 * The calling turn's level, power axes only, or undefined when this process recorded none.
 *
 * @param context - The invocation context.
 */
function turnLevelOf(
  context: CapabilityHandlerContext
): Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'> | undefined {
  const level = context.sessionId ? passedOnLevelOf(context.sessionId) : undefined;
  if (!level) return undefined;
  return { asks: level.asks, reach: level.reach, ...(level.auto ? { auto: level.auto } : {}) };
}

/**
 * Who is changing a to-do: the calling agent, a person, or a refusal.
 *
 * A machine that claimed an identity which did not verify, or an in-session
 * chat with no agent, is never read as the person: that is the confusion that
 * once let a revoked agent act as the operator (DOR-1361).
 *
 * @param deps - The to-do deps.
 * @param context - The invocation context.
 */
function actorOf(
  deps: NonNullable<CapabilityDeps['todoPromiseDeps']>,
  context: CapabilityHandlerContext
): TodoPromiseActor | Refusal {
  if (context.identity) {
    const agentId = callingAgentId(deps, context);
    if (typeof agentId !== 'string') return agentId;
    // The calling turn's level and marks count toward the row's floor (DOR-3088, Must 3).
    const level = turnLevelOf(context);
    return {
      kind: 'agent',
      agentId,
      ...(level ? { level } : {}),
      marks: marksOf(context.sessionId, context.identity?.agentPath),
    };
  }
  if (context.agentIdentityPresented || context.mcpServer === 'in-session') return NO_AGENT;
  return { kind: 'person' };
}

/** Run a to-do tool, answering a {@link TodoPromiseError} as a refusal. */
function answer<T>(run: () => T): T | Refusal {
  try {
    return run();
  } catch (err) {
    if (err instanceof TodoPromiseError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/** How many rows `todo_promises_list` returns when the caller names no limit. */
const LIST_DEFAULT_LIMIT = 50;

/** An ISO 8601 date-time with an offset. */
const DueAtInput = z.string().datetime({ offset: true });

/** The to-dos domain. */
export const todoPromisesDomain: CapabilityDomain = {
  name: 'todo_promises',
  assertDeps: requireTodoPromiseDeps,
  capabilities: [
    defineCapability({
      id: 'todo_promises.add',
      title: 'Add a to-do',
      description:
        'Record something you promised, once you have promised it, so it never lives only in a ' +
        'chat. Everyone on the team can read your list. `what` is the promise in one plain line ' +
        '("Send Acme the revised quote"). `to` is who it was made to: a person, an agent id, or ' +
        '`external:<name>` for someone outside the business. `dueAt` is when it is due (ISO ' +
        '8601 with an offset, never in the past); when it comes due you are woken to deal with ' +
        'it, and an hour later it is marked missed ' +
        'unless you kept it or moved the date. A promise to an outsider ' +
        '(a date, a price, a discount) commits other people: ask first, then record it. When you ' +
        'have done it, mark it kept with the promise-update tool.',
      tier: 'act',
      area: 'todos',
      // What a card shows if a person sets this to Ask.
      approvalDisplayFields: ['what', 'to', 'dueAt'],
      input: z.object({
        what: z
          .string()
          .trim()
          .min(1)
          .max(TODO_WHAT_MAX)
          .describe('The promise, in one plain line.'),
        to: z
          .string()
          .trim()
          .min(1)
          .max(TODO_TO_MAX)
          .optional()
          .describe('Who it was made to: a person, an agent id, or `external:<name>`.'),
        dueAt: DueAtInput.optional().describe('When it is due, ISO 8601 with an offset.'),
        sourceEntryId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('The room message id the promise was made in, when it was made in a room.'),
      }),
      output: z.union([
        z.object({ ok: z.literal(true), todoPromise: TodoPromiseSchema }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: TODO_PROMISE_ADD_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const marks = marksOf(context.sessionId, context.identity?.agentPath);
        if (
          marksHold(marks) &&
          !markedTurnRunsAtFull({
            actionId: 'todo_promises.add',
            title: 'Make a promise',
            ...(context.identity ? { agentPath: context.identity.agentPath } : {}),
            ...(context.identity?.displayName ? { agentName: context.identity.displayName } : {}),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          })
        ) {
          return OUTSIDER_PROMISE;
        }
        const todoPromiseDeps = requireTodoPromiseDeps(deps);
        const agentId = callingAgentId(todoPromiseDeps, context);
        if (typeof agentId !== 'string') return agentId;
        const originLevel = turnLevelOf(context);
        const todoPromise = todoPromiseDeps.service.create(
          agentId,
          {
            what: input.what,
            ...(input.to ? { to: input.to } : {}),
            ...(input.dueAt ? { dueAt: input.dueAt } : {}),
            ...(context.sessionId ? { sourceSessionId: context.sessionId } : {}),
            ...(input.sourceEntryId ? { sourceRoomEntryId: input.sourceEntryId } : {}),
            // The marks of the calling turn, from its own record (DOR-3036).
            originMarks: marks,
            // And its level, which holds the promise (DOR-3088, Must 1).
            ...(originLevel ? { originLevel } : {}),
          },
          { kind: 'agent', agentId }
        );
        return { ok: true as const, todoPromise };
      },
    }),
    defineCapability({
      id: 'todo_promises.update',
      title: 'Change a to-do',
      description:
        'Change one of your promises. `state: "kept"` when you have done it, `"dropped"` when it ' +
        'no longer applies (say why in `note`), `"missed"` when you could not make it. To move ' +
        'the date, pass `state: "open"` with a new `dueAt`, and tell the person you promised. ' +
        'The same reopens a closed promise. Only the agent that promised, or a person, can ' +
        'change a promise.',
      tier: 'act',
      area: 'todos',
      // What a card shows if a person sets this to Ask.
      approvalDisplayFields: ['id', 'state', 'dueAt', 'note'],
      input: z.object({
        id: z.string().min(1).max(100).describe('The promise id, from todo_promises_list.'),
        state: TodoStateSchema.describe('kept, dropped, missed, or open to move the date.'),
        from: TodoStateSchema.optional().describe(
          'The state you believe it is in now. If it changed since, nothing changes.'
        ),
        dueAt: DueAtInput.nullable()
          .optional()
          .describe('A new due date, with state open; never in the past. null removes the date.'),
        note: z
          .string()
          .trim()
          .max(TODO_NOTE_MAX)
          .optional()
          .describe('A short note on how it ended or why it moved.'),
      }),
      output: z.union([
        z.object({ ok: z.literal(true), todoPromise: TodoPromiseSchema }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: TODO_PROMISE_UPDATE_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const todoPromiseDeps = requireTodoPromiseDeps(deps);
        const actor = actorOf(todoPromiseDeps, context);
        if ('ok' in actor) return actor;
        return answer(() => ({
          ok: true as const,
          todoPromise: todoPromiseDeps.service.update(actor, input.id, {
            state: input.state,
            ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            ...(input.from !== undefined ? { from: input.from } : {}),
          }),
        }));
      },
    }),
    defineCapability({
      id: 'todo_promises.list',
      title: 'Read to-dos',
      description:
        "Read what agents have promised: yours, or any agent's. Open promises only by default, " +
        'soonest due first; `overdue` marks one past its date. `state: "all"` adds closed ones, ' +
        'most recently closed first. Filter by `agentId` or `to`. At most `limit` rows (default ' +
        '50); `truncated: true` means more matched, so narrow the filter or raise `limit`.',
      tier: 'observe',
      area: 'todos',
      input: z.object({
        agentId: z.string().min(1).max(100).optional().describe("Only this agent's promises."),
        state: z
          .union([TodoStateSchema, z.literal('all')])
          .optional()
          .describe('Only promises in this state, or "all". Defaults to open.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TODO_PROMISE_LIST_MAX)
          .optional()
          .describe('At most this many rows (default 50). Open promises come first.'),
        to: z
          .string()
          .min(1)
          .max(TODO_TO_MAX)
          .optional()
          .describe('Only promises made to this person, agent or `external:<name>`.'),
      }),
      output: z.union([
        z.object({
          todoPromises: z.array(TodoPromiseSchema),
          /** True when more matched than `limit`, so a cut list is never silent. */
          truncated: z.boolean(),
        }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: TODO_PROMISES_LIST_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { state = 'open', limit = LIST_DEFAULT_LIMIT, ...filter } = input;
        const list = requireTodoPromiseDeps(deps).service.list(
          { ...filter, ...(state === 'all' ? {} : { state }) },
          // One more than asked, so a list cut at `limit` says so.
          limit + 1
        );
        // Which chat a promise was made in is the owner's to see (module TSDoc).
        return {
          todoPromises: list.slice(0, limit).map((c) => ({ ...c, sourceSessionId: null })),
          truncated: list.length > limit,
        };
      },
    }),
  ],
};
