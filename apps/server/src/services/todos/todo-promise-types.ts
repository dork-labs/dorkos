/**
 * The words the to-do promise service speaks in: its refusals, who is acting, what a new promise
 * and a change carry, and what a wake hands its observers. Split from `todo-promise-service.ts` so
 * the service stays under the file-size limit; the service re-exports every one of them.
 *
 * @module services/todos/todo-promise-types
 */
import type { TodoPromise, TodoState } from '@dorkos/shared/todo-promise-schemas';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { TurnMarks } from '../core/turn-power/turn-marks.js';
import type { TodoEstimate } from './timing/todo-wake-plan.js';

/** Why a to-do change was refused. */
export type TodoPromiseErrorCode =
  | 'NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOTHING_TO_CHANGE'
  | 'CONFLICT'
  | 'PAST_DUE'
  | 'NO_AGENT'
  | 'UNKNOWN_AGENT'
  | 'TOO_MANY';

/** A refusal, with a stable code and a plain sentence for whoever asked. */
export class TodoPromiseError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - The stable code.
   * @param message - A plain sentence for the caller.
   */
  constructor(
    readonly code: TodoPromiseErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TodoPromiseError';
  }
}

/** Who is changing a to-do: the agent by its Mesh id, or a person. */
export type TodoPromiseActor =
  | {
      kind: 'agent';
      agentId: string;
      /** The level of the turn it acts from, when known (DOR-3088, Security's Must 3). */
      level?: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'>;
      /** The marks of that turn. */
      marks?: TurnMarks;
    }
  | {
      kind: 'person';
      /**
       * True only for a request carrying the owner's own session cookie (`personProof`). A person
       * who did not prove it writes the stranger bound, never `person` authority.
       */
      proven?: boolean;
    };

/** What a new to-do carries. */
export interface NewTodoPromise {
  /** What was promised. */
  what: string;
  /** To whom, or omitted. */
  to?: string;
  /** When it is due (ISO 8601), or omitted. Never in the past. */
  dueAt?: string;
  /** The chat it was made in. */
  sourceSessionId?: string;
  /** The room message it was made in. */
  sourceRoomEntryId?: string;
  /**
   * The marks of the turn it was made in (DOR-3036), from that turn's own record. The beat its
   * due date wakes reads the promise, so it carries them on.
   */
  originMarks?: TurnMarks;
  /**
   * The level of the turn it was made in, when known (DOR-3088, Must 1): the promise is held to
   * it. Unknown keeps the agent's own standing, as every promise had before to-dos.
   */
  originLevel?: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'>;
  /**
   * The agent's rough guess of how long the work takes. It is woken to start that long, plus a
   * buffer, before the due time, and once partway to check in (DOR-3034).
   */
  estimate?: TodoEstimate;
}

/** A change to a to-do. */
export interface TodoPromiseChange {
  /**
   * The state it should be in. `open` on an open promise moves its date; on a
   * closed one it reopens it (with a new `dueAt`, or keeping the old one).
   */
  state: TodoState;
  /** A new due date, or null to remove it. Only with state `open`. */
  dueAt?: string | null;
  /** A short note on how it ended or why it moved. */
  note?: string;
  /** With state `kept`: a link to what was delivered (a pull request, a message, a file). */
  delivered?: string;
  /**
   * The state the caller believes it is in now. When given and it differs,
   * the change is refused with `CONFLICT`, so an Undo never reverts a change
   * someone else made since.
   */
  from?: TodoState;
}

/** What observers hear when a to-do comes due. */
export interface TodoPromiseDueEvent {
  /** Always `commitment.due`. */
  type: 'commitment.due';
  /** The start wake, or the check-in partway to the due time (DOR-3034). */
  phase: 'start' | 'checkin';
  /** The to-do, as read at that moment. */
  todoPromise: TodoPromise;
}

/** Something listening for to-dos coming due. */
export type TodoPromiseObserver = (event: TodoPromiseDueEvent) => void;

/** A promise's last wake for its current date (DOR-3034). */
export interface LastTodoWake {
  /** The start wake, or the check-in. */
  phase: 'start' | 'checkin';
  /** When it came (ISO 8601): part of the beat's key, so each wake is news. */
  at: string;
  /** Whether a person's Not yet caused it. */
  notYet: boolean;
}

/** The audit action for a to-do arriving in each closed state. */
export const CLOSE_ACTION: Record<Exclude<TodoState, 'open'>, string> = {
  kept: 'commitment.kept',
  missed: 'commitment.missed',
  dropped: 'commitment.dropped',
};
