/**
 * The **baseline reconcilers** (task 2.5) — the concrete {@link Reconciler}s that
 * wrap the existing typed oracles with **no new decision logic**. Each is the
 * cadence + plumbing around a pure oracle that already owns the decision:
 *
 * | reconciler | wraps                       | decision oracle           |
 * | ---------- | --------------------------- | ------------------------- |
 * | `recovery` | re-adopt orphaned claims    | `recoverOrphan`           |
 * | `review`   | clear approved PRs          | `evaluateAutoMerge`       |
 * | `dispatch` | claim the top-ranked item   | `selectDispatch`          |
 * | `triage`   | ready shapeable backlog     | (delegates to the skill)  |
 * | `hygiene`  | surface starvation          | `classifyDispatchOutcome` |
 *
 * The `recovery` reconciler (priority 10, task 3.3) wraps the `recoverOrphan`
 * ladder and sorts at the HEAD of the tick so an orphan is re-adopted before
 * `dispatch` tries to claim it (same-item contention by priority). The `inbox`
 * reconciler (priority 20) is still deferred to task 4.6, which fills the one
 * remaining head-of-tick slot {@link defaultRegistry} leaves open. The set
 * therefore orders `recovery (10) < review (25) < dispatch (30) < triage (40) <
 * hygiene (50)`.
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
import type { Calibration } from './calibration.js';
import type { WorkItem } from './work-item.js';
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
 * The per-tick input bag the {@link defaultRegistry} reconcilers read. Every
 * slice is optional: a tick provides only the slices it gathered, and a
 * reconciler whose slice is absent reports "not due". Tracker-agnostic — no slice
 * names a tracker. Tasks 3.3 / 4.6 add the `recovery` / `inbox` slices.
 */
export interface FlowReconcileInput {
  /** The orphan candidates for the `recovery` reconciler (task 3.3). */
  recovery?: RecoveryReconcileInput;
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
 * Build the **default reconciler registry** — the baseline set wrapping the
 * existing oracles plus the head-of-tick `recovery` reconciler (task 3.3).
 * `list()` is priority-ordered: `recovery (10) < review (25) < dispatch (30) <
 * triage (40) < hygiene (50)`. The remaining `inbox` (20) slot is filled by task
 * 4.6; until then the registry runs these five reconcilers in priority order.
 *
 * @returns A registry over the baseline reconcilers, ready for {@link runTick}.
 */
export function defaultRegistry(): ReconcilerRegistry<FlowReconcileInput> {
  return createReconcilerRegistry<FlowReconcileInput>([
    recoveryReconciler,
    reviewReconciler,
    dispatchReconciler,
    triageReconciler,
    hygieneReconciler,
  ]);
}
