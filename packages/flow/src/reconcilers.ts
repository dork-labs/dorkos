/**
 * The **baseline reconcilers** (task 2.5) — the concrete {@link Reconciler}s that
 * wrap the existing typed oracles with **no new decision logic**. Each is the
 * cadence + plumbing around a pure oracle that already owns the decision:
 *
 * | reconciler | wraps                       | decision oracle           |
 * | ---------- | --------------------------- | ------------------------- |
 * | `review`   | clear approved PRs          | `evaluateAutoMerge`       |
 * | `dispatch` | claim the top-ranked item   | `selectDispatch`          |
 * | `triage`   | ready shapeable backlog     | (delegates to the skill)  |
 * | `hygiene`  | surface starvation          | `classifyDispatchOutcome` |
 *
 * The `recovery` (priority 10) and `inbox` (priority 20) reconcilers are
 * deliberately NOT here — they are added by tasks 3.3 and 4.6, which fill the
 * head-of-tick slots {@link defaultRegistry} leaves open. The baseline set
 * therefore orders `review (25) < dispatch (30) < triage (40) < hygiene (50)`.
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
 * The per-tick input bag the {@link defaultRegistry} reconcilers read. Every
 * slice is optional: a tick provides only the slices it gathered, and a
 * reconciler whose slice is absent reports "not due". Tracker-agnostic — no slice
 * names a tracker. Tasks 3.3 / 4.6 add the `recovery` / `inbox` slices.
 */
export interface FlowReconcileInput {
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
 * existing oracles. `list()` is priority-ordered: `review (25) < dispatch (30) <
 * triage (40) < hygiene (50)`. The head-of-tick `recovery` (10) and `inbox` (20)
 * slots are filled by tasks 3.3 and 4.6; until then the registry runs the four
 * baseline reconcilers in priority order.
 *
 * @returns A registry over the baseline reconcilers, ready for {@link runTick}.
 */
export function defaultRegistry(): ReconcilerRegistry<FlowReconcileInput> {
  return createReconcilerRegistry<FlowReconcileInput>([
    reviewReconciler,
    dispatchReconciler,
    triageReconciler,
    hygieneReconciler,
  ]);
}
