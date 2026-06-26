/**
 * The **baseline reconcilers** (task 2.5) — the concrete {@link Reconciler}s that
 * wrap the existing typed oracles with **no new decision logic**. Each is the
 * cadence + plumbing around a pure oracle that already owns the decision:
 *
 * | reconciler | wraps                       | decision oracle           |
 * | ---------- | --------------------------- | ------------------------- |
 * | `recovery` | re-adopt orphaned claims    | `recoverOrphan`           |
 * | `inbox`    | resume parked answers       | `shouldRespondToComment`  |
 * | `review`   | clear approved PRs          | `evaluateAutoMerge`       |
 * | `dispatch` | claim the top-ranked item   | `selectDispatch`          |
 * | `triage`   | ready shapeable backlog     | (delegates to the skill)  |
 * | `hygiene`  | surface starvation          | `classifyDispatchOutcome` |
 *
 * The `recovery` reconciler (priority 10, task 3.3) wraps the `recoverOrphan`
 * ladder and sorts at the HEAD of the tick so an orphan is re-adopted before
 * `dispatch` tries to claim it (same-item contention by priority). The `inbox`
 * reconciler (priority 20, task 4.6) wraps `shouldRespondToComment` over the
 * `comment.added` events the tick polls from the injected `InboundTransport`
 * (`transport.ts`), un-parking an answered `agent/needs-input` item before any
 * fresh claim. The set orders `recovery (10) < inbox (20) < review (25) <
 * dispatch (30) < triage (40) < hygiene (50)`.
 *
 * ## The act is the decision, not I/O
 *
 * In v1 the side-effecting work (claim, merge, comment) is performed by the prose
 * loop / the P5 runner that consumes the {@link ReconcileResult}; these typed
 * reconcilers re-derive truth and return WHAT to do. That keeps them pure and
 * testable — exactly like the oracles they wrap — and is what makes them the P5
 * promotion surface. Each reconciler's `defaultConfig` is read straight from the
 * resolved `loops` schema default ({@link LoopsSchema}), so the registry order and
 * the config block can never drift.
 *
 * @see ./reconciler.ts (the typed contract — task 2.1)
 * @see ./scheduler.ts (the registry + scheduler — task 2.2)
 * @see specs/flow-triage-feeds-loop/02-specification.md §3
 * @module @dorkos/flow/reconcilers
 */

import { LoopsSchema } from './config-schema.js';
import {
  classifyDispatchOutcome,
  selectDispatch,
  type DispatchConfig,
  type DispatchOptions,
  type OwnershipConfig,
  type WipCap,
} from './dispatch.js';
import { evaluateAutoMerge, type GatesConfig, type MergeState } from './gates.js';
import {
  recoverOrphan,
  type FlowRun,
  type OrphanSignal,
  type RecoveryAction,
  type RecoveryConfig,
  type RecoveryContext,
} from './flow-run.js';
import {
  shouldRespondToComment,
  type CommentIdentity,
  type CommentsConfig,
} from './comment-response.js';
import type { CommentAddedEvent } from './events.js';
import type { Calibration } from './calibration.js';
import type { OwnershipClass, WorkItem } from './work-item.js';
import type { ReconcileContext, ReconcileResult, Reconciler, ReconcilerId } from './reconciler.js';
import { createReconcilerRegistry, isCadenceDue, type ReconcilerRegistry } from './scheduler.js';

/**
 * The resolved `loops` defaults, parsed once. Each baseline reconciler reads its
 * `defaultConfig` from here, so its priority/cadence is guaranteed to match the
 * config schema (task 2.4) — one source of truth, no hand-copied numbers.
 */
const LOOP_DEFAULTS = LoopsSchema.parse({});

/**
 * The candidate set + resolved policy a dispatch-shaped reconciler needs. Shared
 * by `dispatch` (which ranks + claims) and `hygiene` (which classifies the same
 * set for starvation). The tick gathers `items` once via the adapter and hands
 * the same slice to both.
 */
export interface DispatchCandidates {
  /** The candidate work items (the adapter's `getEligibleWork`). */
  items: readonly WorkItem[];
  /** The resolved dispatch / ownership / WIP-cap config. */
  config: { dispatch: DispatchConfig; ownership: OwnershipConfig; wipCap: WipCap };
  /** Ownership resolution (the task-3.1 seam) + live WIP counts. */
  opts: DispatchOptions;
}

/**
 * The single approved-PR candidate at the review gate (§6). v1 is WIP-1, so one
 * candidate per tick; the P5 runner generalizes to a queue.
 */
export interface ReviewReconcileInput {
  /** The item whose PR is at the gate (its identifier, for contention dedupe). */
  itemId: string;
  /** The approved PR's merge-time facts (mergeable / CI / drift / attempts). */
  state: MergeState;
  /** The resolved gates config (review policy + circuit breaker). */
  gates: GatesConfig;
  /** The resolved calibration block, to route the mechanical-vs-real judgement. */
  calibration: Calibration;
}

/**
 * The triage reconciler's input — the count of shapeable backlog items lacking
 * `agent/ready` (from {@link classifyDispatchOutcome}'s `shapeableCount`). When
 * positive, a triage pass has fuel to produce.
 */
export interface TriageReconcileInput {
  /** Dispatchable-category items missing `agent/ready` (the readiness lever). */
  shapeableCount: number;
}

/**
 * One orphan candidate for the `recovery` reconciler — an `agent/claimed` +
 * started-category item the tick gathered, paired with everything
 * {@link recoverOrphan} needs to decide its fate. The reconciler stays **pure**:
 * the tick performs the impure work (lists claimed items, reads each
 * {@link FlowRun} from `flow-state.json`, probes pid-liveness + the worktree/session
 * checkpoint, derives the {@link OrphanSignal}) and hands the facts in here — the
 * recovery package itself never touches the disk or the tracker.
 */
export interface RecoveryCandidate {
  /** The item's human key (e.g. `DOR-123`) — the contention-dedupe key. */
  itemId: string;
  /**
   * The orphan disposition derived from the item's `agent/*` label + state:
   * `claimed-no-worker` (dead {@link FlowRun.workerPid}), `no-local-record` (no
   * local run), or `needs-input` (parked — never reclaimed; excluded from `isDue`).
   */
  signal: OrphanSignal;
  /**
   * The durable run record read from `flow-state.json`, or `null` for the
   * `no-local-record` signal (there is, by definition, no local record).
   */
  run: FlowRun | null;
  /** The injected probe facts (`worktreeExists`, `sessionLogIntact`). */
  probe: RecoveryContext;
}

/**
 * The `recovery` reconciler's input — the orphan candidates the tick gathered plus
 * the resolved {@link RecoveryConfig} (`maxRetries`/…) the ladder runs against.
 */
export interface RecoveryReconcileInput {
  /** The `agent/claimed` + started-category orphan candidates this tick. */
  candidates: readonly RecoveryCandidate[];
  /** The resolved recovery policy (the `RecoverySchema` default in v1). */
  recovery: RecoveryConfig;
}

/**
 * One inbox candidate for the `inbox` reconciler — a polled `comment.added`
 * {@link CommentAddedEvent} paired with everything {@link shouldRespondToComment}
 * needs to decide its fate, all injected so the reconciler stays **pure**.
 * Mirrors {@link RecoveryCandidate}: the tick does the impure work (poll the
 * injected {@link InboundTransport}, re-read each item's CURRENT state via the
 * adapter — *events are triggers, not truth* — classify ownership, load the
 * durable {@link FlowRun} for resume) and hands the facts in here.
 */
export interface InboxCandidate {
  /**
   * The triggering polled event. Typed as {@link CommentAddedEvent} (not the wider
   * {@link import('./events.js').TrackerEvent}) because only a comment can be the
   * parked answer rule 3 resumes on; the tick passes only `comment.added` events.
   */
  event: CommentAddedEvent;
  /**
   * The item's **current** state, re-read via the adapter after the event fired
   * (events are triggers, not truth). Its `agent/needs-input` label is what gates
   * the rule-3 resume.
   */
  item: WorkItem;
  /** The item's ownership class (the task-3.1 `classifyOwnership` seam — injected). */
  ownership: OwnershipClass;
  /**
   * The durable run record for this item, or `null` when there is no local record.
   * On a resume its {@link FlowRun.sessionId} is the `--resume` handle; `null`
   * falls back to thread-replay.
   */
  run: FlowRun | null;
}

/**
 * The `inbox` reconciler's input — the resolved candidates the tick gathered from
 * the injected {@link InboundTransport}, plus the resolved identity + comments
 * config the rule walk needs. The polling I/O lives in the tick (the
 * {@link PollingTransport} seam); this slice is the pure, already-polled facts.
 */
export interface InboxReconcileInput {
  /** The polled `comment.added` candidates, each resolved to its current state. */
  candidates: readonly InboxCandidate[];
  /** The resolved agent identity (`agent` + `marker`) — recognizes self-authored writes (rule 1). */
  identity: CommentIdentity;
  /** The resolved `comments` config (`respondWhen` / `ambiguousBias`). */
  comments: CommentsConfig;
}

/**
 * The per-tick input bag the {@link defaultRegistry} reconcilers read. Every
 * slice is optional: a tick provides only the slices it gathered, and a
 * reconciler whose slice is absent reports "not due". Tracker-agnostic — no slice
 * names a tracker.
 */
export interface FlowReconcileInput {
  /** The orphan candidates for the `recovery` reconciler (task 3.3). */
  recovery?: RecoveryReconcileInput;
  /** The polled inbox candidates for the `inbox` reconciler (task 4.6). */
  inbox?: InboxReconcileInput;
  /** Candidates for the `dispatch` reconciler. */
  dispatch?: DispatchCandidates;
  /** Candidates for the `hygiene` reconciler (same shape as dispatch). */
  hygiene?: DispatchCandidates;
  /** The approved-PR candidate for the `review` reconciler. */
  review?: ReviewReconcileInput;
  /** The shapeable-backlog signal for the `triage` reconciler. */
  triage?: TriageReconcileInput;
}

/** A benign no-op result (nothing was due to act on). */
function noOp(id: ReconcilerId, summary: string): ReconcileResult {
  return { id, acted: false, summary };
}

/** The first item not already claimed this tick (the contention skip). */
function firstUnclaimed(
  items: readonly WorkItem[],
  claimed: ReadonlySet<string> | undefined
): WorkItem | undefined {
  if (!claimed || claimed.size === 0) return items[0];
  return items.find((item) => !claimed.has(item.identifier));
}

/**
 * The first orphan the recovery reconciler should reclaim this tick: an
 * *actionable* candidate (its signal is NOT `needs-input` — a parked item is never
 * reclaimed) that no higher-priority reconciler already claimed. Returns
 * `undefined` when every candidate is parked or already claimed.
 */
function firstReclaimable(
  candidates: readonly RecoveryCandidate[],
  claimed: ReadonlySet<string> | undefined
): RecoveryCandidate | undefined {
  return candidates.find((c) => c.signal !== 'needs-input' && !(claimed?.has(c.itemId) ?? false));
}

/**
 * The first inbox candidate whose comment-response decision is `resume` (rule 3 —
 * a non-agent reply on a parked `agent/needs-input` item) and whose item no
 * higher-priority reconciler already claimed this tick. The {@link shouldRespondToComment}
 * oracle owns the decision: rule 1 (the agent's own marker-bearing comment) yields
 * `ignore` and is skipped here, so a self-authored reply never resumes (no
 * self-resume loop). Returns `undefined` when nothing is resumable.
 */
function firstResumable(
  slice: InboxReconcileInput,
  claimed: ReadonlySet<string> | undefined
): InboxCandidate | undefined {
  return slice.candidates.find((c) => {
    if (claimed?.has(c.item.identifier) ?? false) return false;
    const decision = shouldRespondToComment(
      c.event.comment,
      { item: c.item, ownership: c.ownership, identity: slice.identity },
      slice.comments
    );
    return decision.action === 'resume';
  });
}

/**
 * Map a {@link RecoveryAction} onto a {@link ReconcileResult} for the audit log +
 * contention dedupe. `skip` (a parked item) is the lone benign no-op; every other
 * action is a real reclaim that claims the item for this tick.
 */
function recoveryResult(itemId: string, action: RecoveryAction): ReconcileResult {
  switch (action.kind) {
    case 'skip':
      // Parked on a human — should be filtered out before run, kept as a guard.
      return { id: 'recovery', acted: false, itemId, summary: `skip ${itemId} (${action.reason})` };
    case 'resume':
      return {
        id: 'recovery',
        acted: true,
        itemId,
        summary: `resume ${itemId} at HEAD (attempt ${action.attemptCount})`,
      };
    case 'restart-clean':
      return {
        id: 'recovery',
        acted: true,
        itemId,
        summary: `restart-clean ${itemId} (${action.reason}, attempt ${action.attemptCount})`,
      };
    case 'escalate':
      return {
        id: 'recovery',
        acted: true,
        itemId,
        summary: `escalate ${itemId} → ${action.label} (${action.reason})`,
      };
    case 're-derive':
      return {
        id: 'recovery',
        acted: true,
        itemId,
        summary: `re-derive ${itemId} from tracker (${action.reason})`,
      };
  }
}

/**
 * The **recovery** reconciler (priority 10, head of the tick) — re-adopts orphaned
 * `agent/claimed` work by running the {@link recoverOrphan} ladder over each
 * gathered {@link RecoveryCandidate}. Sorts FIRST so an orphan is resumed before
 * `dispatch` (30) tries to claim it (same-item contention by priority).
 *
 * The reconciler is **pure**: the tick injects the candidates (each carrying its
 * {@link FlowRun}, derived {@link OrphanSignal}, and probe facts); the reconciler
 * only runs the oracle and reports the {@link RecoveryAction}. A parked
 * (`needs-input`) candidate is excluded from {@link Reconciler.isDue} entirely —
 * the single most important invariant: **a parked item is never reclaimed**.
 * v1 is WIP-1, so it reclaims one orphan per tick (the first reclaimable,
 * unclaimed candidate), mirroring `dispatch`.
 */
export const recoveryReconciler: Reconciler<FlowReconcileInput> = {
  id: 'recovery',
  defaultConfig: LOOP_DEFAULTS.recovery,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    const slice = ctx.input.recovery;
    if (slice === undefined) return false;
    if (!isCadenceDue(ctx, LOOP_DEFAULTS.recovery.intervalMs)) return false;
    // Due only when an actionable (non-parked, unclaimed) orphan exists.
    return firstReclaimable(slice.candidates, ctx.claimedItemIds) !== undefined;
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.recovery;
    if (slice === undefined) {
      return Promise.resolve(noOp('recovery', 'no orphan candidates this tick'));
    }
    const next = firstReclaimable(slice.candidates, ctx.claimedItemIds);
    if (next === undefined) {
      return Promise.resolve(noOp('recovery', 'no reclaimable orphan (all parked or claimed)'));
    }
    const action = recoverOrphan(next.signal, next.run, next.probe, slice.recovery);
    return Promise.resolve(recoveryResult(next.itemId, action));
  },
};

/**
 * The **inbox / resume** reconciler (priority 20) — un-parks answered questions
 * before any fresh claim. Consumes the `comment.added` {@link TrackerEvent}s the
 * tick polled from the injected {@link InboundTransport} ({@link PollingTransport},
 * task 4.2) and runs the {@link shouldRespondToComment} oracle over each: a
 * non-agent reply on a parked `agent/needs-input` item is rule 3 → **resume**, and
 * the action carries the {@link FlowRun.sessionId} so the runtime re-attaches the
 * worktree at HEAD and resumes via `--resume <sessionId>` (or thread-replay when
 * there is no local run). It is **identity-mode-agnostic by construction**: in
 * shared mode the `identity.marker` (rule 1) is what disambiguates the agent's own
 * reply from the human's, so the same oracle handles both modes with no branch.
 *
 * The reconciler is **pure** and idempotent: the tick performs the polling +
 * re-read I/O and injects {@link InboxCandidate}s (each carrying the event, the
 * item's CURRENT state, its ownership class, and the run record); the reconciler
 * only walks the oracle. *Events are triggers, not truth* — the injected `item` is
 * the re-read current state, never the event's stale snapshot — and idempotency
 * rides on the event's `dedupeKey` + the skip-self-authored rule. Sorts at
 * priority 20 (after `recovery` 10, before `review` 25 / `dispatch` 30), so a
 * resumed item is claimed for this tick and `dispatch` stands down on it.
 */
export const inboxReconciler: Reconciler<FlowReconcileInput> = {
  id: 'inbox',
  defaultConfig: LOOP_DEFAULTS.inbox,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    const slice = ctx.input.inbox;
    if (slice === undefined) return false;
    if (!isCadenceDue(ctx, LOOP_DEFAULTS.inbox.intervalMs)) return false;
    // Due only when a polled reply actually resumes a parked item (new events on
    // `agent/needs-input` items); a self-authored reply (rule 1) is not resumable.
    return firstResumable(slice, ctx.claimedItemIds) !== undefined;
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.inbox;
    if (slice === undefined) {
      return Promise.resolve(noOp('inbox', 'no inbox events this tick'));
    }
    const next = firstResumable(slice, ctx.claimedItemIds);
    if (next === undefined) {
      return Promise.resolve(
        noOp('inbox', 'no resumable reply (self-authored, unrelated, or claimed)')
      );
    }
    // Resume the parked run: re-attach the worktree at HEAD and resume the captured
    // session. The sessionId is the `--resume` handle; absent a local run, fall back
    // to thread-replay. The dedupeKey is carried for the idempotent audit trail.
    const via = next.run ? `--resume ${next.run.sessionId}` : 'thread-replay (no local FlowRun)';
    return Promise.resolve({
      id: 'inbox',
      acted: true,
      itemId: next.item.identifier,
      summary: `resume ${next.item.identifier} via ${via} (rule 3, ${next.event.dedupeKey})`,
    });
  },
};

/**
 * The **review** reconciler (priority 25) — clears approved PRs at the
 * human-review gate by running the {@link evaluateAutoMerge} ladder. Sorts before
 * `dispatch` so a finished item leaves the gate before a fresh one is claimed.
 */
export const reviewReconciler: Reconciler<FlowReconcileInput> = {
  id: 'review',
  defaultConfig: LOOP_DEFAULTS.review,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    return ctx.input.review !== undefined && isCadenceDue(ctx, LOOP_DEFAULTS.review.intervalMs);
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.review;
    if (slice === undefined) return Promise.resolve(noOp('review', 'no approved PR at the gate'));
    const disposition = evaluateAutoMerge(slice.state, slice.gates, slice.calibration);
    return Promise.resolve({
      id: 'review',
      acted: true,
      itemId: slice.itemId,
      summary: `${slice.itemId}: auto-merge disposition "${disposition.kind}"`,
    });
  },
};

/**
 * The **dispatch** reconciler (priority 30) — claims the top-ranked eligible item
 * via the {@link selectDispatch} ladder, skipping any item a higher-priority
 * reconciler (recovery, review) already claimed this tick.
 */
export const dispatchReconciler: Reconciler<FlowReconcileInput> = {
  id: 'dispatch',
  defaultConfig: LOOP_DEFAULTS.dispatch,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    const slice = ctx.input.dispatch;
    if (slice === undefined) return false;
    if (!isCadenceDue(ctx, LOOP_DEFAULTS.dispatch.intervalMs)) return false;
    const picked = selectDispatch(slice.items, slice.config, slice.opts);
    return firstUnclaimed(picked, ctx.claimedItemIds) !== undefined;
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.dispatch;
    if (slice === undefined) return Promise.resolve(noOp('dispatch', 'no candidates this tick'));
    const picked = selectDispatch(slice.items, slice.config, slice.opts);
    const next = firstUnclaimed(picked, ctx.claimedItemIds);
    if (next === undefined) {
      return Promise.resolve(noOp('dispatch', 'no unclaimed eligible item'));
    }
    return Promise.resolve({
      id: 'dispatch',
      acted: true,
      itemId: next.identifier,
      summary: `claim ${next.identifier} (top-ranked of ${picked.length} eligible)`,
    });
  },
};

/**
 * The **triage** reconciler (priority 40) — the one baseline reconciler with NO
 * typed decision oracle: in v1 it delegates to the `triaging-work` skill. `isDue`
 * fires when shapeable backlog waits behind the readiness gate; `run` is a thin
 * delegation marker (no `itemId` — a triage pass is backlog-wide).
 */
export const triageReconciler: Reconciler<FlowReconcileInput> = {
  id: 'triage',
  defaultConfig: LOOP_DEFAULTS.triage,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    const slice = ctx.input.triage;
    if (slice === undefined) return false;
    if (!isCadenceDue(ctx, LOOP_DEFAULTS.triage.intervalMs)) return false;
    return slice.shapeableCount > 0;
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.triage;
    if (slice === undefined || slice.shapeableCount <= 0) {
      return Promise.resolve(noOp('triage', 'nothing shapeable to ready'));
    }
    return Promise.resolve({
      id: 'triage',
      acted: true,
      summary: `delegate to triaging-work skill — ${slice.shapeableCount} shapeable item(s) to ready`,
    });
  },
};

/**
 * The **hygiene** reconciler (priority 50, slowest cadence) — keeps the queue
 * honest by running {@link classifyDispatchOutcome} over the candidate set and
 * surfacing starvation (the charter G3 "never starve silently" contract). `acted`
 * reflects whether the queue was found starved.
 */
export const hygieneReconciler: Reconciler<FlowReconcileInput> = {
  id: 'hygiene',
  defaultConfig: LOOP_DEFAULTS.hygiene,
  isDue(ctx: ReconcileContext<FlowReconcileInput>): boolean {
    const slice = ctx.input.hygiene;
    if (slice === undefined) return false;
    if (!isCadenceDue(ctx, LOOP_DEFAULTS.hygiene.intervalMs)) return false;
    return slice.items.length > 0;
  },
  run(ctx: ReconcileContext<FlowReconcileInput>): Promise<ReconcileResult> {
    const slice = ctx.input.hygiene;
    if (slice === undefined) return Promise.resolve(noOp('hygiene', 'no queue to inspect'));
    const outcome = classifyDispatchOutcome(slice.items, slice.config, slice.opts);
    const summary = outcome.starved
      ? `starved: 0 ready, ${outcome.shapeableCount} shapeable — run a triage pass`
      : `${outcome.eligibleCount} ready, ${outcome.shapeableCount} shapeable`;
    return Promise.resolve({ id: 'hygiene', acted: outcome.starved, summary });
  },
};

/**
 * Build the **default reconciler registry** — the full baseline set wrapping the
 * existing oracles. `list()` is priority-ordered: `recovery (10) < inbox (20) <
 * review (25) < dispatch (30) < triage (40) < hygiene (50)`. Recovery re-adopts
 * orphans at the head of the tick; `inbox` (task 4.6) then un-parks answered
 * questions before `review` clears finished PRs and `dispatch` claims fresh work.
 *
 * @returns A registry over the baseline reconcilers, ready for {@link runTick}.
 */
export function defaultRegistry(): ReconcilerRegistry<FlowReconcileInput> {
  return createReconcilerRegistry<FlowReconcileInput>([
    recoveryReconciler,
    inboxReconciler,
    reviewReconciler,
    dispatchReconciler,
    triageReconciler,
    hygieneReconciler,
  ]);
}
