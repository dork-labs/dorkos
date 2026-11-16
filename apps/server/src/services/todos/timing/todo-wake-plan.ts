/**
 * When an agent is woken about a dated to-do, and when an unkept promise is missed (DOR-3034).
 *
 * Work should be finished by the due time, so the agent is woken to **start** before it: the due
 * time minus its own rough guess of how long the work takes, minus a buffer. With a guess it is
 * also woken once partway through, to check in. A promise not kept by the due time plus a short
 * grace is missed then. A date set inside its own lead wakes the agent at the due time instead. One found late (a restart, a computer that slept) is woken now and keeps
 * its grace from that wake, so a late wake never misses it on the spot.
 *
 * @module services/todos/timing/todo-wake-plan
 */

/** How long past its due time an unkept promise waits before it is missed. */
export const TODO_GRACE_MS = 15 * 60 * 1000;

/** How early an agent with no guess is woken: an hour of work, no check-in. */
export const TODO_DEFAULT_LEAD_MS = 60 * 60 * 1000;

/** The smallest buffer added before a guessed start. */
const MIN_BUFFER_MS = 15 * 60 * 1000;

/** The rough sizes an agent can give, in minutes of work. */
export const TODO_ESTIMATES = { hour: 60, 'half-day': 240, day: 480 } as const;

/** A rough size an agent gives when it promises. */
export type TodoEstimate = keyof typeof TODO_ESTIMATES;

/** What a plan is computed from. */
export interface WakeInputs {
  /** When it is due (ISO 8601). */
  dueAt: string;
  /** The agent's guess of the work, in minutes, or null. */
  estimateMinutes: number | null;
  /** When the current due date was set (ISO 8601), or null on an older row. */
  dueSetAt: string | null;
  /** When the start wake happened for this date (ISO 8601), or null. */
  dueNotifiedAt: string | null;
  /** When the check-in wake happened for this date (ISO 8601), or null. */
  checkinNotifiedAt: string | null;
}

/** The next moment a timer waits for. */
export type WakeStep =
  { phase: 'due'; at: number } | { phase: 'checkin'; at: number } | { phase: 'missed'; at: number };

/**
 * The three moments for one dated to-do, in epoch ms.
 *
 * @param inputs - Its due date, guess and past wakes.
 * @returns The start wake, the check-in (null without a guess) and the missed moment.
 */
export function wakeMoments(inputs: WakeInputs): {
  startAt: number;
  checkinAt: number | null;
  missedAt: number;
} {
  const due = Date.parse(inputs.dueAt);
  const work = inputs.estimateMinutes === null ? null : inputs.estimateMinutes * 60_000;
  const planned =
    work === null ? due - TODO_DEFAULT_LEAD_MS : due - work - Math.max(MIN_BUFFER_MS, work / 4);
  // A date set inside its own lead has no early start left: the agent that set it is working on
  // it now, so it is woken at the due time instead, with no check-in.
  const setAt = inputs.dueSetAt ? Date.parse(inputs.dueSetAt) : NaN;
  const early = Number.isNaN(setAt) || planned > setAt;
  const startAt = early ? planned : due;
  const checkinAt = work === null || !early ? null : startAt + (due - startAt) / 2;
  const woke = inputs.dueNotifiedAt ? Date.parse(inputs.dueNotifiedAt) : NaN;
  // Found late: the grace runs from the wake, never from a due time already gone.
  const missedAt = Math.max(due, Number.isNaN(woke) ? due : woke) + TODO_GRACE_MS;
  return { startAt, checkinAt, missedAt };
}

/**
 * The next moment to wait for, given what already happened.
 *
 * - Never woken: the start wake (at once if its moment passed).
 * - Woken, with a check-in still owed and the due time not yet here: the check-in.
 * - Otherwise: the missed moment.
 *
 * @param inputs - Its due date, guess and past wakes.
 * @param now - The moment to judge it at, in epoch ms.
 * @returns The step, or null when the due date does not parse.
 */
export function nextWakeStep(inputs: WakeInputs, now: number): WakeStep | null {
  const due = Date.parse(inputs.dueAt);
  if (Number.isNaN(due)) return null;
  const { startAt, checkinAt, missedAt } = wakeMoments(inputs);
  if (!inputs.dueNotifiedAt) return { phase: 'due', at: startAt };
  const woke = Date.parse(inputs.dueNotifiedAt);
  // A check-in is owed only while it still falls before the due time and after the start wake;
  // a start that came late has already done its job.
  if (checkinAt !== null && !inputs.checkinNotifiedAt && woke < checkinAt && now < due) {
    return { phase: 'checkin', at: checkinAt };
  }
  return { phase: 'missed', at: missedAt };
}
