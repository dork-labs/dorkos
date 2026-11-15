/**
 * One timer per open to-do with a due date (spec `heartbeats` §12).
 *
 * Three moments matter for each, planned by `todo-wake-plan.ts` (DOR-3034): the start wake,
 * before the due time by the agent's own guess of the work (`onDue`); with a guess, a check-in
 * partway (`onCheckin`); and the due time plus a short grace, when a promise still open is marked
 * missed (`onMissed`). Each timer waits for the next moment only. After a wake the service saves
 * it and re-arms, so the next moment is planned from what really happened. Rebuilt from the table
 * at startup, so a restart loses none of them.
 *
 * **Late is "due now", never "already missed".** A promise whose start passed while the server was
 * down, or while the computer slept and the timer fired late, is woken now, and its grace runs
 * from that wake.
 *
 * `setTimeout` cannot wait longer than about 24.8 days, so a far-off moment is waited for in hops:
 * a timer that fires early just arms the next hop.
 *
 * @module services/todos/timing/todo-due-timers
 */
import { nextWakeStep, type WakeInputs, type WakeStep } from './todo-wake-plan.js';
import type { AgentTodoRow } from '../todo-promise-store.js';

/** The longest single wait `setTimeout` honours (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/** What a timer needs to know about a to-do. */
export interface TimedTodo extends WakeInputs {
  /** The to-do id. */
  id: string;
}

/** What the timers call back into. */
export interface TodoDueTimerDeps {
  /** The clock, in epoch ms. */
  now: () => number;
  /** The start moment arrived (or was found already past): wake the agent. */
  onDue: (id: string) => void;
  /** Partway between the start and the due time: wake the agent to check in. */
  onCheckin: (id: string) => void;
  /** The due time plus its grace passed with the promise still open. */
  onMissed: (id: string) => void;
}

/** The armed timers, one per to-do id. */
export class TodoDueTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Build the timer set.
   *
   * @param deps - The clock and the three callbacks.
   */
  constructor(private readonly deps: TodoDueTimerDeps) {}

  /**
   * Arm (or re-arm) the timer for one to-do's next moment, replacing any it had. A moment already
   * past fires at once.
   *
   * @param todo - The to-do: its due date, guess and past wakes.
   */
  schedule(todo: TimedTodo): void {
    this.clear(todo.id);
    const now = this.deps.now();
    const step = nextWakeStep(todo, now);
    if (!step) return;
    // A start already past (found at startup, or a date set inside its lead) wakes at once, so the
    // first observer can be handed it before anything else runs.
    if (step.phase === 'due' && step.at <= now) {
      this.deps.onDue(todo.id);
      return;
    }
    this.arm(todo.id, step);
  }

  /**
   * Disarm one to-do's timer: it closed, or its date was removed.
   *
   * @param id - The to-do id.
   */
  clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /**
   * Replace every timer with one per to-do given. Called at startup.
   *
   * @param todos - Every open to-do with a due date.
   */
  rebuild(todos: readonly TimedTodo[]): void {
    this.stop();
    for (const todo of todos) this.schedule(todo);
  }

  /** Disarm everything. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** How many timers are armed. For tests and diagnostics. */
  get size(): number {
    return this.timers.size;
  }

  /** Wait for a step's moment, in hops when it is further off than one timer can wait. */
  private arm(id: string, step: WakeStep): void {
    const wait = Math.max(0, step.at - this.deps.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        if (this.deps.now() < step.at) {
          this.arm(id, step);
          return;
        }
        if (step.phase === 'due') this.deps.onDue(id);
        else if (step.phase === 'checkin') this.deps.onCheckin(id);
        else this.deps.onMissed(id);
      },
      Math.min(wait, MAX_TIMER_MS)
    );
    // A promise's timer never keeps the process alive on its own.
    timer.unref?.();
    this.timers.set(id, timer);
  }
}

/**
 * What the timers need from a row, or null when it has no due date.
 *
 * @param row - The stored row.
 */
export function timedTodo(row: AgentTodoRow): TimedTodo | null {
  if (!row.dueAt) return null;
  return {
    id: row.id,
    dueAt: row.dueAt,
    estimateMinutes: row.estimateMinutes,
    dueSetAt: row.dueSetAt,
    dueNotifiedAt: row.dueNotifiedAt,
    checkinNotifiedAt: row.checkinNotifiedAt,
  };
}
