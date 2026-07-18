/**
 * Budget-cap enforcement, driven from the runtime's own reported cost.
 *
 * Cost model (a spec-vs-schema reconciliation): the spec's budget section names
 * the SDK field `total_cost_usd`, but on the durable per-session stream that
 * value is projected onto `status_change.status.cost` (cumulative session cost
 * in USD) and/or `status.usage.costUsd` (`UsageStatusSchema`, `@dorkos/shared`).
 * Both are CUMULATIVE for the session, so a single eval's cost is the MAX cost
 * any of its status frames report — not a sum of per-frame deltas. "Accumulate"
 * therefore applies at the RUN level: the run total is the sum of each eval's
 * cumulative cost. `test-mode` reports no cost, so structural evals are free.
 *
 * @module evals/runner/budget
 */
import { UsageStatusSchema } from '@dorkos/shared/schemas';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';

/** Default per-run budget cap in USD (D5 policy). */
export const DEFAULT_RUN_BUDGET_USD = 3;

/** Default per-eval soft ceiling in USD — a single runaway turn fails its eval. */
export const DEFAULT_PER_EVAL_CEILING_USD = 1;

/**
 * Read the cumulative session cost a single durable-stream frame reports, or
 * `null` if the frame carries none. Prefers the runtime-neutral
 * `status.usage.costUsd` (validated against `UsageStatusSchema`) and falls back
 * to the top-level `status.cost` projection.
 *
 * @param frame - One SSE frame collected off `/events`.
 * @returns The cumulative USD cost, or `null` when the frame reports no cost.
 */
export function frameCostUsd(frame: SseFrame): number | null {
  if (!frame.data || typeof frame.data !== 'object') return null;
  const data = frame.data as { type?: string; status?: unknown };
  if (data.type !== 'status_change' || !data.status || typeof data.status !== 'object') return null;
  const status = data.status as { cost?: unknown; usage?: unknown };

  const usage = UsageStatusSchema.safeParse(status.usage);
  if (usage.success && typeof usage.data.costUsd === 'number') return usage.data.costUsd;

  if (typeof status.cost === 'number') return status.cost;
  return null;
}

/**
 * The cumulative cost an eval's collected frames report: the maximum cost any
 * status frame carried (the values are cumulative, so max === latest total).
 * Zero when no frame reported a cost (e.g. `test-mode`).
 *
 * @param frames - The frames collected while driving one eval.
 * @returns The eval's cumulative USD cost.
 */
export function evalCostUsd(frames: SseFrame[]): number {
  let max = 0;
  for (const frame of frames) {
    const cost = frameCostUsd(frame);
    if (cost !== null && cost > max) max = cost;
  }
  return max;
}

/** A budget verdict for one eval, plus whether the run may continue. */
export interface BudgetVerdict {
  /** The eval's own cumulative cost. */
  evalCostUsd: number;
  /** The run's total cost after adding this eval. */
  totalCostUsd: number;
  /** True when this eval alone breached its per-eval soft ceiling (a runaway turn). */
  exceededEvalCeiling: boolean;
  /** True when the run total breached the per-run cap; remaining evals are skipped. */
  exceededRunBudget: boolean;
}

/**
 * Accumulates cost across a run and enforces both the per-run cap and the
 * per-eval soft ceiling. One instance per run; `record` is called once per eval
 * with the frames that eval collected.
 */
export class BudgetTracker {
  private total = 0;
  private readonly runBudgetUsd: number;
  private readonly perEvalCeilingUsd: number;

  /**
   * Create a tracker with the run cap and per-eval soft ceiling.
   *
   * @param opts.runBudgetUsd - Per-run cap; the run aborts once total exceeds it.
   * @param opts.perEvalCeilingUsd - Per-eval soft ceiling; an eval over it fails.
   */
  constructor(opts: { runBudgetUsd?: number; perEvalCeilingUsd?: number } = {}) {
    this.runBudgetUsd = opts.runBudgetUsd ?? DEFAULT_RUN_BUDGET_USD;
    this.perEvalCeilingUsd = opts.perEvalCeilingUsd ?? DEFAULT_PER_EVAL_CEILING_USD;
  }

  /** The run's total accumulated cost so far. */
  get totalCostUsd(): number {
    return this.total;
  }

  /**
   * Record one eval's cost (from its collected frames) and return the verdict.
   * A per-eval ceiling may be overridden per case (a cheaper eval gets a tighter
   * ceiling).
   *
   * @param frames - The frames the eval collected.
   * @param overrides.perEvalCeilingUsd - Override the per-eval soft ceiling.
   * @returns The {@link BudgetVerdict} for this eval.
   */
  record(frames: SseFrame[], overrides: { perEvalCeilingUsd?: number } = {}): BudgetVerdict {
    const cost = evalCostUsd(frames);
    this.total += cost;
    const ceiling = overrides.perEvalCeilingUsd ?? this.perEvalCeilingUsd;
    return {
      evalCostUsd: cost,
      totalCostUsd: this.total,
      exceededEvalCeiling: cost > ceiling,
      exceededRunBudget: this.total > this.runBudgetUsd,
    };
  }

  /**
   * Whether the run has already exceeded its budget (checked before starting the
   * next eval, so the remaining ones are marked `skipped-over-budget`).
   */
  isOverRunBudget(): boolean {
    return this.total > this.runBudgetUsd;
  }
}
