/**
 * Keeping an answered capability approval on screen long enough to read the
 * answer.
 *
 * ## The disappearance this closes
 *
 * Answering is optimistic: the receipt replaces the two buttons in the same
 * frame. Then the decision mutation retires the request, `approval_resolved`
 * invalidates `['approvals','pending']`, and the refetch comes back without it
 * — which takes the card AND the group wrapping it out of the tree. Every
 * surface guards its approval list with `approvals.length > 0`, so the last
 * answer unmounts the `AnimatePresence` that was supposed to play the card's
 * exit, and an exit nothing is watching for never runs at all. The receipt
 * lived for one refetch round trip.
 *
 * That receipt is the ONLY confirmation an answer gets — nothing navigates and
 * neither answer toasts — so a receipt nobody can read is a decision with no
 * feedback at all.
 *
 * ## Why a module, and why it holds the whole approval
 *
 * The hold belongs to the DECISION, not to whichever copy of the card was
 * mounted when it was made: the same request is drawn in the Inbox popover, the
 * home header and the phone's Now tab at once, and any of them may be unmounted
 * by the answer. It keeps the whole {@link PendingApproval} rather than an id
 * because the request is gone from the server's list by the time the hold
 * matters — the consumers have nothing left to look it up in.
 *
 * ## Why this is a second registry and not a shared one
 *
 * `features/schedule-approval/model/settling-approvals` does the same job for a
 * parked schedule, and the two are deliberately the same shape — the way
 * `deferred-rejection` beside it already is. They are NOT shared code: the
 * repo's DRY rule extracts at three, these are two, and they hold different
 * objects released on different events (a schedule holds only on approve, since
 * a rejection is carried by the undo window instead; a capability approval
 * holds on both answers). A third registry of this shape is the one that should
 * lift the machinery into `shared`.
 *
 * @module features/approvals/model/settling-approvals
 */
import { useSyncExternalStore } from 'react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { askExitTransition } from '@/layers/shared/lib';

/**
 * How long an answered approval stays drawn, in milliseconds.
 *
 * Read off the card's own exit curve rather than picked: the hold plus the melt
 * is exactly how long `ApprovalCard`'s exit needs the card to still be there.
 * Taking the number from `askExitTransition` means the two can never drift —
 * retune the curve and this follows.
 */
const EXIT = askExitTransition({ decided: true, reducedMotion: false });
export const APPROVAL_RECEIPT_SETTLE_MS = (EXIT.delay + EXIT.duration) * 1000;

/** What a person answered, once they have. */
export type ApprovalDecision = 'granted' | 'denied';

/** One answered approval, and the answer its receipt has to print. */
interface HeldApproval {
  /** The request, kept whole because the server's list no longer has it. */
  approval: PendingApproval;
  /** What was answered, so a card drawn from the hold draws the receipt. */
  decision: ApprovalDecision;
}

/** Answered approvals still saying so, keyed by approval id. */
const settling = new Map<string, HeldApproval>();

/**
 * The timer ending each hold, keyed the same way.
 *
 * **Held separately, and every path has to keep it in step.** A timer nobody
 * tracks cannot be cancelled, and an untracked one does not simply leak — it
 * fires on a stale deadline and deletes whatever is holding that id by then.
 * Two ways in: answer → server refuses → answer again, where the first timer
 * cuts the second hold short; and the same request held by two mounted
 * consumers at once (the Inbox popover and the home header are on screen
 * together), where the earlier timer ends the later hold. This is the
 * DOR-1633 shape, and it is why the map exists rather than a bare `setTimeout`.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Everyone who wants to know when that map changes. */
const listeners = new Set<() => void>();

/** The snapshot handed to React. Rebuilt only on change, so the identity is stable. */
let snapshot: PendingApproval[] = [];

/** Nothing settling, as one shared array — so an idle cockpit never mints a new one. */
const NONE: PendingApproval[] = [];

/** Rebuild the snapshot and tell every subscriber. */
function publish(): void {
  snapshot = settling.size === 0 ? NONE : [...settling.values()].map((held) => held.approval);
  // Copied first: a listener may unsubscribe as it runs, and mutating the set
  // mid-iteration would skip whoever came next.
  for (const listener of [...listeners]) listener();
}

/**
 * Cancel and forget the timer ending this approval's hold, if there is one.
 *
 * @param approvalId - The request whose countdown should stop.
 */
function clearHoldTimer(approvalId: string): void {
  const timer = timers.get(approvalId);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(approvalId);
}

/**
 * Keep this approval drawn while its receipt is read.
 *
 * Called the moment an answer is pressed, BEFORE the mutation settles — the
 * race being lost is the refetch, and waiting for the mutation would be waiting
 * for the very thing that ends the card.
 *
 * @param approval - The request that was just answered.
 * @param decision - What was answered, so the receipt survives a remount.
 */
export function holdDecidedApproval(approval: PendingApproval, decision: ApprovalDecision): void {
  // Whatever was counting down for this id is done: this hold owns the deadline
  // now. Without this the older timer fires first and ends a window that had
  // only just started.
  clearHoldTimer(approval.approvalId);
  settling.set(approval.approvalId, { approval, decision });
  timers.set(
    approval.approvalId,
    setTimeout(() => {
      timers.delete(approval.approvalId);
      settling.delete(approval.approvalId);
      publish();
    }, APPROVAL_RECEIPT_SETTLE_MS)
  );
  publish();
}

/**
 * Stop holding an approval.
 *
 * The server refused the answer, so the request is answerable again and belongs
 * to the live list rather than to this one — a stale hold would draw it twice,
 * once from the server's copy and once from ours.
 *
 * @param approvalId - The request to release.
 */
export function releaseDecidedApproval(approvalId: string): void {
  // The timer goes with the entry. Left armed it has nothing to end, and would
  // instead end the next hold this id is given.
  clearHoldTimer(approvalId);
  if (!settling.delete(approvalId)) return;
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
function read(): PendingApproval[] {
  return snapshot;
}

/**
 * The approval cards to draw, including any still saying how they were
 * answered.
 *
 * Every surface that lists approvals calls this with whatever the server told
 * it, so all three keep a decided card on screen for the same beat — and none
 * of them has to know that a hold exists.
 *
 * A request the server still reports as pending is drawn from the SERVER's copy
 * (it is the fresher row), so this never draws one card twice in the window
 * between the answer and the refetch.
 *
 * @param approvals - The pending approvals the server currently reports.
 * @returns Those approvals, plus any settling ones the server has already
 *   dropped, in the server's order with the settling ones last.
 */
export function useApprovalCards(approvals: PendingApproval[]): PendingApproval[] {
  const held = useSyncExternalStore(subscribe, read, () => NONE);
  if (held.length === 0) return approvals;

  const live = new Set(approvals.map((approval) => approval.approvalId));
  const stillHeld = held.filter((approval) => !live.has(approval.approvalId));
  return stillHeld.length === 0 ? approvals : [...approvals, ...stillHeld];
}

/**
 * What this request was answered, while its hold is still running.
 *
 * A card drawn FROM the hold is a fresh mount — the copy that was answered may
 * have been unmounted by the very refetch this module exists to survive — and a
 * fresh mount has no local decision state. Without this it would draw Allow and
 * Don't allow over a request that is already answered, which is a button that
 * does nothing. Reading the answer back is what makes the receipt a property of
 * the decision rather than of one component instance.
 *
 * @param approvalId - The request to ask about.
 * @returns The answer, or `undefined` once the hold has ended or never ran.
 */
export function useHeldApprovalDecision(approvalId: string): ApprovalDecision | undefined {
  return useSyncExternalStore(
    subscribe,
    () => settling.get(approvalId)?.decision,
    // The server render has no decisions in flight.
    () => undefined
  );
}

/**
 * Drop every hold immediately.
 *
 * Test-only teardown: the timers outlive `cleanup()` by design, so a suite that
 * answered something would otherwise carry it into the next case. Cancelling
 * them is the whole point — clearing the entries alone leaves the timers armed,
 * and each one still fires inside some later, unrelated test.
 *
 * @internal Exported for testing only.
 */
export function discardSettlingApprovals(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  settling.clear();
  publish();
}
