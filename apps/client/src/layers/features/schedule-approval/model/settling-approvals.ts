/**
 * Keeping an approved schedule on screen long enough to say it was approved.
 *
 * ## The disappearance this closes
 *
 * Approving a schedule is optimistic: the receipt replaces the buttons in the
 * same frame. Then `useUpdateTask` invalidates `['tasks']`, the refetch comes
 * back with the task `active`, and it drops out of the parked list — which
 * takes the card, AND the group wrapping it, out of the tree. Measured: the
 * receipt lived 10-60ms against a local server. `AskCard.Root` declares a
 * 0.4s hold and a 0.2s melt for exactly this moment, but an exit transition
 * only runs while something is still watching for it, and the `AnimatePresence`
 * was inside the group that had just unmounted.
 *
 * The receipt is the ONLY confirmation an approval gets — nothing navigates and
 * neither answer toasts on success — so a receipt nobody can read is a decision
 * with no feedback at all.
 *
 * ## Why a module, and why it holds the task
 *
 * Same reasoning as `deferred-rejection`, and deliberately the same shape: the
 * hold belongs to the DECISION, not to whichever copy of the card was mounted
 * when it was made. It keeps the whole {@link Task} rather than an id because
 * the card is gone from the server's list by the time the hold matters — the
 * consumers have nothing left to look the row up in.
 *
 * @module features/schedule-approval/model/settling-approvals
 */
import { useSyncExternalStore } from 'react';
import type { Task } from '@dorkos/shared/types';
import { askExitTransition } from '@/layers/shared/lib';

/**
 * How long an approved schedule stays drawn, in milliseconds.
 *
 * Read off the card's own exit curve rather than picked: the hold plus the melt
 * is exactly how long `AskCard.Root` needs the card to still be there. Taking
 * the number from `askExitTransition` means the two can never drift — retune
 * the curve and this follows.
 */
const EXIT = askExitTransition({ decided: true, reducedMotion: false });
export const APPROVAL_SETTLE_MS = (EXIT.delay + EXIT.duration) * 1000;

/** Approved schedules still saying so, keyed by task id. */
const settling = new Map<string, Task>();

/**
 * The timer ending each hold, keyed the same way.
 *
 * **Held separately, and every path has to keep it in step.** A timer nobody
 * tracks cannot be cancelled, and an untracked one does not simply leak — it
 * fires on a stale deadline and deletes whatever is holding that id by then.
 * Two ways in: approve → refused → approve again, where the first timer cuts
 * the second hold short; and the same task held by two mounted consumers at
 * once (the Inbox popover and the home header are on screen together), where
 * the earlier timer ends the later hold. `deferred-rejection` does this
 * bookkeeping for the same reason.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Everyone who wants to know when that map changes. */
const listeners = new Set<() => void>();

/** The snapshot handed to React. Rebuilt only on change, so the identity is stable. */
let snapshot: readonly Task[] = [];

/** Nothing settling, as one shared array — so an idle cockpit never mints a new one. */
const NONE: readonly Task[] = [];

/** Rebuild the snapshot and tell every subscriber. */
function publish(): void {
  snapshot = settling.size === 0 ? NONE : [...settling.values()];
  // Copied first: a listener may unsubscribe as it runs, and mutating the set
  // mid-iteration would skip whoever came next.
  for (const listener of [...listeners]) listener();
}

/**
 * Keep this schedule drawn while its receipt is read.
 *
 * Called the moment Approve is pressed, BEFORE the mutation settles — the race
 * being lost is the refetch, and waiting for the mutation would be waiting for
 * the very thing that ends the card.
 *
 * @param task - The schedule that was just approved.
 */
export function holdApprovedSchedule(task: Task): void {
  // Whatever was counting down for this id is done: this hold owns the deadline
  // now. Without this the older timer fires first and ends a window that had
  // only just started.
  clearHoldTimer(task.id);
  settling.set(task.id, task);
  timers.set(
    task.id,
    setTimeout(() => {
      timers.delete(task.id);
      settling.delete(task.id);
      publish();
    }, APPROVAL_SETTLE_MS)
  );
  publish();
}

/**
 * Cancel and forget the timer ending this schedule's hold, if there is one.
 *
 * @param taskId - The schedule whose countdown should stop.
 */
function clearHoldTimer(taskId: string): void {
  const timer = timers.get(taskId);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(taskId);
}

/**
 * Stop holding a schedule.
 *
 * The approval was refused, so the card is answerable again and belongs to the
 * live list rather than to this one.
 *
 * @param taskId - The schedule to release.
 */
export function releaseSettledSchedule(taskId: string): void {
  // The timer goes with the entry. Left armed it has nothing to end, and would
  // instead end the next hold this id is given.
  clearHoldTimer(taskId);
  if (!settling.delete(taskId)) return;
  publish();
}

/** Watch the settling set. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current snapshot. */
function read(): readonly Task[] {
  return snapshot;
}

/**
 * The parked schedules to draw, including any still saying they were approved.
 *
 * Every surface that lists proposals calls this with whatever the server told
 * it, so all three keep a decided card on screen for the same beat — and none
 * of them has to know that a hold exists.
 *
 * A schedule the server still reports as parked is drawn from the SERVER's copy
 * (it is the fresher row), so this never resurrects one that was approved
 * elsewhere and refused here.
 *
 * @param schedules - The parked schedules the server currently reports.
 * @returns Those schedules, plus any settling ones the server has already
 *   dropped, in the server's order with the settling ones last.
 */
export function useScheduleApprovalCards(schedules: readonly Task[]): readonly Task[] {
  const held = useSyncExternalStore(subscribe, read, () => NONE);
  if (held.length === 0) return schedules;

  const live = new Set(schedules.map((task) => task.id));
  const stillHeld = held.filter((task) => !live.has(task.id));
  return stillHeld.length === 0 ? schedules : [...schedules, ...stillHeld];
}

/**
 * Drop every hold immediately.
 *
 * Test-only teardown: the timers outlive `cleanup()` by design, so a suite that
 * approved something would otherwise carry it into the next case. Cancelling
 * them is the whole point — clearing the entries alone leaves the timers armed,
 * and each one still fires inside some later, unrelated test.
 *
 * @internal Exported for testing only.
 */
export function discardSettlingSchedules(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  settling.clear();
  publish();
}
