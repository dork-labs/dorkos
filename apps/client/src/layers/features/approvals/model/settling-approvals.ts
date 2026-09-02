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
 * ## Two lifetimes, and the difference is the whole design
 *
 * The **hold** is about the LIST: which cards a surface still draws after the
 * server has stopped listing them. It is bounded by a timer, because a list
 * that never let go would pin a decided card to the cockpit forever.
 *
 * The **answer** is about the CARD: what a card draws instead of two buttons.
 * It outlives the hold, because a card can outlive the hold — the transcript's
 * copy (`AssistantMessageContent` draws it from the message part, not from the
 * pending list) is never unmounted by the refetch at all. Expiring the answer
 * with the hold is what made such a card flash its receipt and then go BACK to
 * offering Allow and Don't allow on a request that was already decided, which
 * is precisely the "button that does nothing" the design rules out. Worse, the
 * event that would have corrected it (`capability_approval_resolved`) is
 * documented as droppable in `stream-manager.ts`, so the revert could be
 * permanent.
 *
 * So the answer is bounded by COUNT, not by time, and there is exactly one
 * thing that erases it: {@link releaseDecidedApproval}, i.e. the server
 * refusing the answer. That is what keeps a second mounted card honest — when
 * the answer turns out not to have landed, every copy goes back to being
 * answerable together, not just the one that clicked.
 *
 * ## Why this is not shared machinery (yet)
 *
 * Two neighbours hold the same shape. `features/schedule-approval/model/
 * settling-approvals` holds a parked schedule the same way, deliberately
 * mirroring `deferred-rejection` beside it rather than sharing with it. And
 * `entities/attention/model/ask-receipt-store` is the **third**: a settling
 * list, per-id cancellable timers with the same DOR-1633 fix, and a
 * count-bounded receipt ledger separate from that list — the very split this
 * module just adopted, borrowed from it deliberately.
 *
 * So the rule-of-three counter is at three, and extraction is still not the
 * right move: that third one is a Zustand store in `entities` serving a
 * different question (how an Ask ENDED, including endings nobody chose — an
 * expiry, another window), while these two are `useSyncExternalStore`
 * registries in `features` that merge a hold back into a server list. A shared
 * abstraction would have to span two layers and two state libraries to save a
 * map and a timer. **The honest trigger is a FOURTH holder that merges a hold
 * into a server-owned list** — at that point the merge hook plus the timer
 * bookkeeping is the thing to lift into `shared`, and these two are what it
 * should be extracted from.
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

/**
 * How many answers are remembered at once.
 *
 * Bounded by count rather than by a timer, for the reason the module header
 * gives: an answer has no natural expiry, and the card reading it may still be
 * on screen an hour later. The number is `ask-receipt-store`'s; its REASONING is
 * not, and borrowing it would be wrong — that store can argue nothing needs a
 * receipt a minute later, which is the exact claim this module exists to
 * refute. The bound here is simply more answers than any plausible burst in one
 * page session, and it is safe because eviction degrades to the pre-fix
 * behaviour — the card offers its buttons again and the server answers with the
 * refusal toast — never to anything worse.
 */
const ANSWER_LIMIT = 50;

/**
 * How each request was answered — the ledger a CARD reads.
 *
 * Insertion-ordered (a `Map` is), so the cap drops the oldest rather than an
 * arbitrary key. Deliberately NOT the same map as {@link settling}: an entry
 * here survives its hold expiring and is erased only by
 * {@link releaseDecidedApproval}.
 */
const answers = new Map<string, ApprovalDecision>();

/** Answered approvals still drawn by every surface, keyed by approval id. */
const settling = new Map<string, PendingApproval>();

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
  snapshot = settling.size === 0 ? NONE : [...settling.values()];
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
 * @param decision - What was answered, so every copy of the card can draw the
 *   receipt — including one that never had a decision of its own.
 */
export function holdDecidedApproval(approval: PendingApproval, decision: ApprovalDecision): void {
  rememberAnswer(approval.approvalId, decision);
  // Whatever was counting down for this id is done: this hold owns the deadline
  // now. Without this the older timer fires first and ends a window that had
  // only just started.
  clearHoldTimer(approval.approvalId);
  settling.set(approval.approvalId, approval);
  timers.set(
    approval.approvalId,
    setTimeout(() => {
      timers.delete(approval.approvalId);
      // Only the LIST entry. The answer stays: the surfaces stop drawing this
      // card, but a card that outlives the hold has to keep saying what it
      // says. See the module header.
      settling.delete(approval.approvalId);
      publish();
    }, APPROVAL_RECEIPT_SETTLE_MS)
  );
  publish();
}

/**
 * Write this answer into the ledger, newest last, oldest evicted.
 *
 * Re-inserted rather than overwritten in place so a re-answer counts as recent:
 * `Map` keeps first-insertion order, so a plain `set` on an existing key would
 * leave the freshest answer sitting at the front of the eviction queue.
 *
 * @param approvalId - The request that was answered.
 * @param decision - What was answered.
 */
function rememberAnswer(approvalId: string, decision: ApprovalDecision): void {
  answers.delete(approvalId);
  answers.set(approvalId, decision);
  if (answers.size <= ANSWER_LIMIT) return;
  const oldest = answers.keys().next().value;
  if (oldest !== undefined) answers.delete(oldest);
}

/**
 * Take an answer back, because the server would not have it.
 *
 * The one thing that erases a remembered answer, and it has to erase it
 * everywhere rather than only on the card that clicked: a 403 from the answer
 * guard usually means somebody else answered first, and a second mounted copy
 * left saying "Allowed" would be reporting an outcome that never happened. The
 * request is answerable again and belongs to the live list, so the hold goes
 * too — left behind it would draw the card twice, once from the server's copy
 * and once from ours.
 *
 * @param approvalId - The request whose answer did not land.
 */
export function releaseDecidedApproval(approvalId: string): void {
  // The timer goes with the entry. Left armed it has nothing to end, and would
  // instead end the next hold this id is given.
  clearHoldTimer(approvalId);
  const forgot = answers.delete(approvalId);
  const dropped = settling.delete(approvalId);
  // Either half changing is news: a card reads the answer, and the surfaces
  // read the list. Publishing only when the LIST changed would leave a card
  // whose hold had already expired still drawing a withdrawn receipt.
  if (forgot || dropped) publish();
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
 * How this request was answered, whoever answered it and however long ago.
 *
 * What makes the receipt a property of the DECISION rather than of one
 * component instance. Two cards need it and neither has the answer of its own:
 * a card drawn from the hold, whose original copy the refetch unmounted; and
 * the transcript's card, which was mounted before the answer and stays mounted
 * long after — for that one, reading this is the difference between a receipt
 * and two buttons offering to answer a request that is already decided.
 *
 * Deliberately NOT tied to the hold's timer. It goes away only when
 * {@link releaseDecidedApproval} says the answer did not land.
 *
 * @param approvalId - The request to ask about.
 * @returns The answer, or `undefined` when this request has none on record.
 */
export function useRecordedApprovalDecision(approvalId: string): ApprovalDecision | undefined {
  return useSyncExternalStore(
    subscribe,
    () => answers.get(approvalId),
    // The server render has no decisions on record.
    () => undefined
  );
}

/**
 * The approvals currently being held — the ones that are drawn but NOT waiting.
 *
 * `ApprovalList` reads it to tell its cap the difference: a receipt is not a
 * request queueing for an answer, so it must neither be pushed out by the cap
 * nor counted in the "N more requests are waiting" line under it.
 *
 * @returns The held approvals, stable by identity while nothing changes.
 */
export function useSettlingApprovals(): readonly PendingApproval[] {
  return useSyncExternalStore(subscribe, read, () => NONE);
}

/**
 * Drop every hold and forget every answer immediately.
 *
 * Test-only teardown, and it has to clear BOTH halves: the timers outlive
 * `cleanup()` by design, and the answer ledger outlives the timers by design,
 * so a suite that answered something would otherwise carry it into the next
 * case twice over. Cancelling the timers is the whole point of the first half —
 * clearing the entries alone leaves them armed, and each one still fires inside
 * some later, unrelated test.
 *
 * @internal Exported for testing only.
 */
export function discardSettlingApprovals(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  settling.clear();
  answers.clear();
  publish();
}
