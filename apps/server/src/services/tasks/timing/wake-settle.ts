/**
 * A scheduled fire waits for the computer to be properly awake (DOR-3286).
 *
 * A sleeping Mac wakes for moments on its own (a dark wake: Power Nap, network
 * maintenance) and croner fires every due schedule in that moment. A run that
 * starts there is cut off seconds later when the computer sleeps again.
 *
 * ## Deferring, not holding the computer awake
 *
 * Keep-awake's assertion (`caffeinate -i`) prevents IDLE sleep, which is not
 * what ends a dark wake, so it cannot hold one. The assertion that can
 * (`caffeinate -s`) works only on mains power and would keep a closed laptop
 * running in a bag: it overrides a sleep the person chose. So a fire that lands
 * within {@link WAKE_SETTLE_MS} of a wake waits until the computer has stayed
 * awake that long. A dark wake ends long before that and the fire waits on;
 * after a real wake it runs a couple of minutes late. When it finally runs it
 * is judged at that moment, so the usual staleness rule (`occurrence.ts`)
 * records a fire that waited too long as skipped because the computer was
 * asleep, rather than running it hours late.
 *
 * @module services/tasks/timing/wake-settle
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  awakeTimeout,
  getAwakeClock,
  pausableAwakeTimeout,
  type AwakeClock,
} from '@dorkos/shared/awake-clock';
import { pauseWhileWaitingToStart } from '@dorkos/shared/run-time-limit';
import { createTaggedLogger } from '../../../lib/logger.js';
import { SESSIONS } from '../../../config/constants.js';

const logger = createTaggedLogger('Tasks');

/** How long the computer must stay awake after a wake before a fire runs. */
export const WAKE_SETTLE_MS = 2 * 60 * 1000;

/** Holds scheduled fires until the computer has settled after a wake. */
export class WakeSettle {
  private readonly pending = new Set<unknown>();

  /**
   * Settle fires on one clock.
   *
   * @param clock - The clock that sees sleep. A run's time limit is counted on
   *   it too ({@link runDeadline}).
   */
  constructor(readonly clock: AwakeClock = getAwakeClock()) {}

  /**
   * Run `fire` now, or once the computer has been awake {@link WAKE_SETTLE_MS}
   * since its last wake. Checked again each time, so a computer that sleeps
   * again while a fire waits keeps it waiting.
   *
   * @param fire - Called with the instant it actually runs. What it resolves
   *   to is not read here (a dispatch answers the run it opened, DOR-4315).
   * @param name - The task's name, for the log line if `fire` rejects.
   */
  run(fire: (firedAt: Date) => Promise<unknown> | void, name: string): void {
    const wokeAt = this.clock.lastWakeAt();
    const wait = wokeAt === null ? 0 : wokeAt + WAKE_SETTLE_MS - this.clock.now();
    if (wait <= 0) {
      Promise.resolve(fire(new Date(this.clock.now()))).catch((err) =>
        logger.error(`dispatch error for ${name}:`, err)
      );
      return;
    }
    const handle = this.clock.timers.setTimeout(() => {
      this.pending.delete(handle);
      this.run(fire, name);
    }, wait);
    this.pending.add(handle);
  }

  /** Drop every waiting fire. */
  stop(): void {
    for (const handle of this.pending) this.clock.timers.clearTimeout(handle);
    this.pending.clear();
  }
}

/**
 * The longest a run's turn may wait to start: the claude-code runtime refuses a
 * turn that waited this long for a free agent slot. A run's limit counts only
 * once its turn starts (DOR-4576), so every bound that outlives a run (the
 * direct path's hard cap below, a relay envelope's TTL, the scheduler's cap-slot
 * hold and the crash sweep's deadline) adds this wait to the run's own limit.
 */
export const RUN_START_WAIT_MS = SESSIONS.WARM_SLOT_WAIT_MS;

/** How a direct run can be stopped early: its operator, or its time limit. */
export interface RunDeadline {
  /** Aborts on whichever comes first; its reason says which. */
  signal: AbortSignal;
  /** Whether the time limit is what stopped it. */
  timedOut(): boolean;
  /** The run ended; drop the deadline. */
  cancel(): void;
  /**
   * Read one event of the run's stream: the limit is paused while the turn
   * waits to start (`pauseWhileWaitingToStart`, DOR-4576).
   */
  observe(event: StreamEvent): void;
}

/**
 * A run's stop signal: the operator's, joined by the time limit counted in
 * awake time only, and only once the run's turn has started. A plain timer
 * counts through sleep, so a run the computer slept through was stopped on
 * wake as over its limit (DOR-3286); and a limit counted from the fire spent
 * itself while the turn waited for a free agent slot (DOR-4576).
 *
 * @param clock - The clock that sees sleep.
 * @param maxRuntime - The task's time limit, if it has one.
 * @param operator - The operator's stop signal.
 * @param onWaiting - Told the wait's words when the turn starts waiting for a
 *   slot, and `null` when it starts.
 */
export function runDeadline(
  clock: AwakeClock,
  maxRuntime: number | null | undefined,
  operator: AbortSignal,
  onWaiting: (message: string | null) => void = () => {}
): RunDeadline {
  if (!maxRuntime) {
    return { signal: operator, timedOut: () => false, cancel: () => {}, observe: () => {} };
  }
  const limit = new AbortController();
  const expire = () =>
    limit.abort(new DOMException('The run reached its time limit.', 'TimeoutError'));
  const timer = pausableAwakeTimeout(clock, maxRuntime, expire, RUN_START_WAIT_MS);
  // The hard cap, which never pauses: a runtime that kept saying it was waiting
  // must not hold a run open for ever.
  const cancelCap = awakeTimeout(clock, maxRuntime + RUN_START_WAIT_MS, expire);
  // `AbortSignal.any` adopts the reason of whichever fired first.
  const signal = AbortSignal.any([operator, limit.signal]);
  return {
    signal,
    timedOut: () => (signal.reason as { name?: string } | null)?.name === 'TimeoutError',
    cancel: () => {
      timer.cancel();
      cancelCap();
    },
    observe: pauseWhileWaitingToStart(timer, onWaiting),
  };
}
