/**
 * One timer per open to-do with a due date (spec `heartbeats` §12).
 *
 * Two moments matter for each: the due time, when the agent should be woken
 * (`onDue`), and one hour after that wake, when a promise still open is marked
 * missed (`onMissed`). Rebuilt from the table at startup, so a restart loses
 * neither.
 *
 * **Late is "due now", never "already missed".** A promise that came due while
 * the server was down, or while the computer slept and the timer fired late,
 * gets its wake now and a fresh hour from now before it is marked missed. A
 * promise whose wake already happened (`dueNotifiedAt`) is not woken again; its
 * hour runs from that wake.
 *
 * `setTimeout` cannot wait longer than about 24.8 days, so a far-off due date is
 * waited for in hops: a timer that fires early just arms the next hop.
 *
 * @module services/todos/todo-due-timers
 */

/** How long after its wake an open promise is marked missed. */
export const TODO_MISSED_AFTER_MS = 60 * 60 * 1000;

/** The longest single wait `setTimeout` honours (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/** What a timer needs to know about a to-do. */
export interface TimedTodo {
  /** The to-do id. */
  id: string;
  /** When it is due (ISO 8601). */
  dueAt: string;
  /** When the agent was woken about this due date, or null when it has not been. */
  dueNotifiedAt: string | null;
}

/** What the timers call back into. */
export interface TodoDueTimerDeps {
  /** The clock, in epoch ms. */
  now: () => number;
  /** The due moment arrived (or was found already past): wake the agent. */
  onDue: (id: string) => void;
  /** An hour has passed since the wake. */
  onMissed: (id: string) => void;
}

/** Which moment a timer is waiting for. */
type Phase = 'due' | 'missed';

/** The armed timers, one per to-do id. */
export class TodoDueTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Build the timer set.
   *
   * @param deps - The clock and the two callbacks.
   */
  constructor(private readonly deps: TodoDueTimerDeps) {}

  /**
   * Arm (or re-arm) the timer for one to-do, replacing any it had.
   *
   * - Due in the future: wait for it.
   * - Past due, already woken: the missed mark lands an hour after that wake.
   * - Past due, never woken: wake now, and mark missed an hour from now.
   *
   * @param to-do - The to-do, its due date and its last wake.
   */
  schedule(todoPromise: TimedTodo): void {
    this.clear(todoPromise.id);
    const due = Date.parse(todoPromise.dueAt);
    if (Number.isNaN(due)) return;
    const now = this.deps.now();
    if (now < due) {
      this.arm(todoPromise.id, 'due', due);
      return;
    }
    const notified = todoPromise.dueNotifiedAt ? Date.parse(todoPromise.dueNotifiedAt) : NaN;
    if (!Number.isNaN(notified)) {
      this.arm(todoPromise.id, 'missed', notified + TODO_MISSED_AFTER_MS);
      return;
    }
    this.arm(todoPromise.id, 'missed', now + TODO_MISSED_AFTER_MS);
    this.deps.onDue(todoPromise.id);
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
   * @param to-dos - Every open to-do with a due date.
   */
  rebuild(todoPromises: readonly TimedTodo[]): void {
    this.stop();
    for (const todoPromise of todoPromises) this.schedule(todoPromise);
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

  /** Wait for `at`, in hops when it is further off than one timer can wait. */
  private arm(id: string, phase: Phase, at: number): void {
    const wait = Math.max(0, at - this.deps.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        const now = this.deps.now();
        if (now < at) {
          this.arm(id, phase, at);
          return;
        }
        if (phase === 'due') {
          // The hour starts at the wake, not at the due time: a timer that
          // fired late after the computer slept still gives a full hour.
          this.arm(id, 'missed', now + TODO_MISSED_AFTER_MS);
          this.deps.onDue(id);
        } else {
          this.deps.onMissed(id);
        }
      },
      Math.min(wait, MAX_TIMER_MS)
    );
    // A promise's timer never keeps the process alive on its own.
    timer.unref?.();
    this.timers.set(id, timer);
  }
}
