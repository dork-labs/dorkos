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
 * The sentinel the CLI's arg parser stores for a `--flag` given no value. Named
 * here because {@link parseBudgetUsd} has to reject exactly that case.
 */
export const VALUELESS_FLAG = 'true';

/**
 * Parse a `--budget` value into a spend ceiling.
 *
 * Rejects anything that is not a finite, non-negative number, LOUDLY — because
 * the quiet path was expensive. A cleared `budget_usd` workflow input reaches the
 * shell as `--budget ""`, which the arg parser stores as {@link VALUELESS_FLAG};
 * `Number('true')` is `NaN`; `NaN ?? 3` is `NaN` (`??` only catches
 * null/undefined), so `isOverRunBudget()` evaluated `total > NaN` — always false
 * — and the credentialed run spent with NO ceiling. Then `writeResults` threw
 * inside `RunSummarySchema.parse` (zod rejects `NaN`), so `results.json` was
 * never written: the money was gone and the evidence the job exists to produce
 * went with it.
 *
 * @param raw - The raw `--budget` argument, if present.
 * @returns The parsed budget, or `undefined` to use {@link DEFAULT_RUN_BUDGET_USD}.
 * @throws {Error} When the value is present but not a usable number.
 */
export function parseBudgetUsd(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === VALUELESS_FLAG) {
    throw new Error(
      '--budget needs a number, e.g. --budget 3. It was passed with no value, which would have ' +
        'run with no spend ceiling at all.'
    );
  }
  // `Number('')` is 0 — a "budget" that silently caps every run at zero spend.
  // An empty value is a cleared input, not a decision, so say so.
  if (raw.trim() === '') {
    throw new Error('--budget must be a finite, non-negative number of USD; got an empty value.');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--budget must be a finite, non-negative number of USD; got "${raw}".`);
  }
  return value;
}

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
 * The cost signal an eval's collected frames carry: the maximum cost any status
 * frame reported (the values are cumulative, so max === latest total), or `null`
 * when NO frame reported a cost at all.
 *
 * The `null` is the whole point of this function existing beside
 * {@link evalCostUsd}. "The runtime said this turn cost nothing" and "nothing
 * ever told us what this turn cost" are different facts, and collapsing them
 * into `0` is how two of ten measured runs burned 92 seconds of real tokens each
 * and were recorded as free. The runner turns a `null` here into
 * `costUnmetered` on the result, and the report prints it as unknown rather than
 * as zero.
 *
 * @param frames - The frames collected while driving one eval.
 * @returns The cumulative USD cost, or `null` when no frame carried one.
 */
export function evalCostSignal(frames: SseFrame[]): number | null {
  let max: number | null = null;
  for (const frame of frames) {
    const cost = frameCostUsd(frame);
    if (cost !== null && (max === null || cost > max)) max = cost;
  }
  return max;
}

/**
 * The cumulative cost an eval's collected frames report, floored at zero.
 * Zero when no frame reported a cost (e.g. `test-mode`) — use
 * {@link evalCostSignal} when you need to tell "free" from "unknown".
 *
 * @param frames - The frames collected while driving one eval.
 * @returns The eval's cumulative USD cost.
 */
export function evalCostUsd(frames: SseFrame[]): number {
  return evalCostSignal(frames) ?? 0;
}

/**
 * Resolve a cap, refusing a value that would silently disable enforcement.
 *
 * `NaN` is the dangerous one: every `>` comparison against it is false, so a
 * `NaN` cap does not raise the ceiling, it REMOVES it. `??` cannot catch that
 * (`NaN` is neither null nor undefined), so the guard lives here as well as at
 * the CLI boundary — the tracker is the thing that actually enforces spend, and
 * it must not be constructible in a state where it enforces nothing.
 *
 * @param value - The caller's cap, if any.
 * @param fallback - The default cap for an absent value.
 * @param what - Name of the cap, for the error message.
 * @returns The cap to enforce.
 * @throws {Error} When `value` is present but not a finite, non-negative number.
 */
function requireFiniteCap(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `The ${what} must be a finite, non-negative number of USD; got ${String(value)}. ` +
        'A non-finite cap disables enforcement rather than raising it.'
    );
  }
  return value;
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
    this.runBudgetUsd = requireFiniteCap(opts.runBudgetUsd, DEFAULT_RUN_BUDGET_USD, 'run budget');
    this.perEvalCeilingUsd = requireFiniteCap(
      opts.perEvalCeilingUsd,
      DEFAULT_PER_EVAL_CEILING_USD,
      'per-eval ceiling'
    );
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
    // The per-case override goes through the SAME guard as the constructor. It
    // was the one path that skipped it, so a `NaN` ceiling from a malformed case
    // silently removed that eval's soft cap — the exact failure the guard's own
    // docstring argues against, one layer down.
    const ceiling = requireFiniteCap(
      overrides.perEvalCeilingUsd,
      this.perEvalCeilingUsd,
      'per-eval ceiling override'
    );
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
