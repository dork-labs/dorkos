/**
 * How a person's to-do writes refuse over HTTP once the capability mount serves them (DOR-4978):
 * the same problem codes and the same sentences the hand routes answered with (`todoRefusal`).
 *
 * The services refuse with a {@link TodoPromiseError}: a stable code and a plain sentence. A
 * capability hands the dispatcher a `CapabilityToolError` instead, whose problem comes from a fixed
 * table (`routes/capability-refusals.ts`, ADR 261123-170831), never the handler's own words. So
 * each service code is one tool code here, and the table lists every sentence the services may say
 * for it ({@link TODO_TOOL_REFUSALS}): a sentence on that list is sent as it is, and anything else
 * gets the code's own fixed sentence. A source scan keeps the lists equal to the services'
 * sentences (`__tests__/todo-refusals.test.ts`).
 *
 * @module services/todos/todo-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';
import { TodoStateSchema } from '@dorkos/shared/todo-promise-schemas';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { TodoPromiseError, type TodoPromiseErrorCode } from './todo-promise-types.js';

/** One refusal: its problem code, its fixed sentence, and the other sentences it may say. */
export interface TodoToolRefusal {
  /** The problem code; its status comes with it. */
  readonly code: ProblemCode;
  /** The sentence for a refusal whose own sentence is not on {@link TodoToolRefusal.alsoSays}. */
  readonly detail: string;
  /** Every other sentence the services refuse with under this code, each sent as it is. */
  readonly alsoSays: readonly string[];
}

const STATES = TodoStateSchema.options;

/** "That to-do is kept now, not open." for every pair of states, to-dos and promises alike. */
const CHANGED_MEANWHILE = (['to-do', 'promise'] as const).flatMap((noun) =>
  STATES.flatMap((now) =>
    STATES.filter((from) => from !== now).map(
      (from) => `That ${noun} is ${now} now, not ${from}. Nothing changed.`
    )
  )
);

/** The tool code each service code becomes, so every refusal finds its table entry. */
const TOOL_CODE: Readonly<Record<TodoPromiseErrorCode, string>> = {
  NOT_FOUND: 'TODO_NOT_FOUND',
  NOT_YOURS: 'TODO_NOT_YOURS',
  NOTHING_TO_CHANGE: 'TODO_NOTHING_TO_CHANGE',
  CONFLICT: 'TODO_CONFLICT',
  PAST_DUE: 'TODO_PAST_DUE',
  NO_AGENT: 'TODO_NO_AGENT',
  UNKNOWN_AGENT: 'TODO_UNKNOWN_AGENT',
  TOO_MANY: 'TODO_TOO_MANY',
};

/**
 * The refusal table's entries for the to-do writes, keyed by tool code. `TODO_NOT_FOUND` is also
 * what `todos.view_card` refuses an unknown id with.
 */
export const TODO_TOOL_REFUSALS: Readonly<Record<string, TodoToolRefusal>> = {
  TODO_NOT_FOUND: {
    code: 'not_found',
    detail: 'No to-do has that id.',
    alsoSays: ['No promise has that id.'],
  },
  TODO_SOURCE_NOT_FOUND: {
    code: 'not_found',
    detail: 'No message has that id.',
    alsoSays: [],
  },
  TODO_NOT_YOURS: {
    code: 'forbidden',
    detail: 'This caller isn’t allowed to change that to-do.',
    alsoSays: [
      'Only the person, or the agent it is assigned to, can change whether it is done.',
      'Only the person, or the agent it is assigned to, can write how it ended.',
      'Only the person, its assignee or the agent that made it can edit it.',
      'Only the person, its assignee or the agent that made it can move its date.',
      'Only the person, or the agent that made it, can reassign it.',
      'Only the person, or the agent it is assigned to, can move it in their order.',
      'That agent is not in your space, so it cannot get your to-dos.',
      'That agent is already in this chain of to-dos. Ask the person instead.',
      'That promise belongs to another agent. Only that agent or a person can change it.',
      'An agent records only its own promises.',
    ],
  },
  TODO_NOTHING_TO_CHANGE: {
    code: 'invalid_request',
    detail: 'Nothing to change.',
    alsoSays: [
      "That is an agent's own promise. Change it as a promise, not as a to-do.",
      'Say why in a note when declining a to-do.',
      'A to-do needs a title.',
      "Only an agent's own promise can be missed. Mark a to-do kept, or dropped with a note.",
      'A new due date applies only with state open. Leave dueAt out to close it.',
      'A delivered link goes only with state kept.',
      'Nothing to change. Pass a new dueAt, or a state of kept, missed or dropped.',
      'Nothing is waiting for an answer there.',
      ...STATES.map((state) => `That promise is already ${state}.`),
    ],
  },
  TODO_CONFLICT: {
    code: 'precondition_failed',
    detail: 'It changed since you last looked. Nothing changed.',
    alsoSays: CHANGED_MEANWHILE,
  },
  TODO_PAST_DUE: {
    code: 'past_due',
    detail: 'That due date has passed. Pick a time ahead.',
    alsoSays: [],
  },
  TODO_NO_AGENT: {
    code: 'forbidden',
    detail: 'Only an agent can do that.',
    alsoSays: [],
  },
  TODO_UNKNOWN_AGENT: {
    code: 'not_found',
    detail: 'No agent on the team has that id.',
    alsoSays: [],
  },
  TODO_TOO_MANY: {
    code: 'rate_limited',
    detail: 'Too many to-dos for one day. Wait until tomorrow.',
    alsoSays: [],
  },
};

/**
 * Rethrow a service's refusal as the tool error the dispatcher answers with; anything else is
 * rethrown as it is, a fault.
 *
 * @param err - What the service threw.
 * @throws Always.
 */
export function throwTodoRefusal(err: unknown): never {
  if (err instanceof TodoPromiseError) {
    throw new CapabilityToolError({ code: TOOL_CODE[err.code], error: err.message });
  }
  throw err;
}
