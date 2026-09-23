/**
 * Per-turn usage from the SDK's running totals.
 *
 * A `result` message's `modelUsage` (and `total_cost_usd`) is NOT one turn's
 * usage. The SDK documents it as "cumulative across turns in streaming-input
 * sessions: each result carries the running total so far, so read the latest
 * result rather than summing across results", and since SDK 0.3.277 "a resumed
 * or forked session continues from the totals its transcript saved, when it has
 * them (so the first result already carries the earlier turns)". A mid-session
 * `/clear` resets the running total.
 *
 * Both halves were observed live (2026-09-22, a two-turn streaming query on
 * haiku, then a resume of the same session): at 0.3.268 the second warm turn
 * reported 7699 input tokens for a ~3447-token turn — the running total — and
 * the resumed query restarted at zero; at 0.3.280 the resumed query's first
 * result carried all three turns (11196). The evidence is in
 * `research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/triage-decisions.md`.
 *
 * So a turn's usage is a DIFFERENCE: this result's running totals minus the
 * running totals the session had reached before the turn. That baseline is the
 * {@link UsageLedger} held on the in-memory session, and this module is the one
 * place it is read and advanced.
 *
 * @module services/runtimes/claude-code/sdk/turn-usage
 */

/** One model's running totals, as the latest `result` reported them. */
export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Absent when the CLI never recorded thinking for this model. */
  thinkingTokens?: number;
  costUsd: number;
}

/**
 * The running totals a session had reached at its last `result`, keyed by model.
 *
 * An EMPTY ledger is a claim — "this session's totals start at zero" — and is
 * only ever seeded when a query starts a brand-new transcript. An ABSENT ledger
 * means the baseline is unknown (a resumed session this process has not yet
 * seen a result for), and then no per-turn figure can honestly be derived.
 */
export type UsageLedger = Record<string, ModelUsageTotals>;

/** One turn's usage, summed across every model the turn touched. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Written only when at least one model reported thinking this turn. */
  thinkingTokens?: number;
  costUsd: number;
}

/** What {@link advanceUsageLedger} derives from one `result`. */
export interface TurnUsageStep {
  /** This turn's usage; undefined when it cannot honestly be derived. */
  turn?: TurnUsage;
  /**
   * The ledger to hold for the next turn: this result's totals, or undefined
   * when they cannot serve as a baseline (see {@link advanceUsageLedger}).
   */
  ledger?: UsageLedger;
}

/**
 * Read a result's `modelUsage` map into ledger form.
 *
 * @param modelUsage - The result's `modelUsage`, keyed by model string.
 */
export function readModelUsageTotals(
  modelUsage: Record<string, Record<string, unknown>>
): UsageLedger {
  const totals: UsageLedger = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    const thinking = usage.thinkingTokens;
    totals[model] = {
      inputTokens: (usage.inputTokens as number | undefined) ?? 0,
      outputTokens: (usage.outputTokens as number | undefined) ?? 0,
      ...(typeof thinking === 'number' ? { thinkingTokens: thinking } : {}),
      costUsd: (usage.costUSD as number | undefined) ?? 0,
    };
  }
  return totals;
}

/**
 * Whether the running totals went BACKWARDS since the baseline — a model the
 * baseline knew is gone, or one of its counts shrank. Running totals only ever
 * grow within one lifetime, so a drop means a new lifetime began: a `/clear`,
 * or a resumed query whose transcript carried no saved totals (every transcript
 * an SDK before 0.3.277 wrote — observed: resuming a 0.3.268 session at 0.3.280
 * restarted at zero). Everything in the new totals then belongs to this turn.
 */
function totalsWentBackwards(current: UsageLedger, baseline: UsageLedger): boolean {
  for (const [model, before] of Object.entries(baseline)) {
    const now = current[model];
    if (!now) return true;
    if (now.inputTokens < before.inputTokens || now.outputTokens < before.outputTokens) {
      return true;
    }
  }
  return false;
}

/** Whether every count in these totals is zero — a zeroed crash result's shape. */
function allZero(totals: UsageLedger): boolean {
  return Object.values(totals).every(
    (t) => t.inputTokens === 0 && t.outputTokens === 0 && t.costUsd === 0
  );
}

/**
 * Derive one turn's usage from a result's running totals, and advance the ledger.
 *
 * - **Unknown baseline** (`baseline` undefined): no turn figure. The first result
 *   of a resumed session this process holds no ledger for may carry every
 *   earlier turn, and there is nothing to subtract, so reporting it as one turn
 *   would be the over-count this module exists to prevent.
 * - **Zeroed totals, or an ERROR result whose totals went backwards**: no turn
 *   figure, and the baseline becomes unknown. The SDK says "crash/startup-error
 *   results may carry zeroed usage", and those zeros are not a new lifetime: the
 *   next real result still carries the full running total. Adopting the zeros
 *   as the baseline would report that whole history as one turn.
 * - **Totals went backwards on a success**: a new lifetime began (a `/clear`, or
 *   the first turn on a transcript that saved no totals), so the whole result
 *   is this turn's.
 * - **Otherwise**: the difference, per model, summed.
 *
 * Thinking is summed only over models that reported it this result, and a
 * baseline that lacked it counts as zero; a negative difference is clamped,
 * because a share of the output can never be less than nothing.
 *
 * @param current - This result's running totals ({@link readModelUsageTotals}).
 * @param baseline - The session's ledger before this result, if known.
 * @param isError - Whether the result is an error result (any non-success subtype).
 */
export function advanceUsageLedger(
  current: UsageLedger,
  baseline: UsageLedger | undefined,
  isError = false
): TurnUsageStep {
  // A zeroed result against a KNOWN-empty baseline changes nothing: the session
  // has spent nothing yet, so its zero baseline stays true.
  if (allZero(current)) return baseline && Object.keys(baseline).length === 0 ? { ledger: {} } : {};
  if (baseline === undefined) return { ledger: current };
  const backwards = totalsWentBackwards(current, baseline);
  if (backwards && isError) return {};
  const from = backwards ? {} : baseline;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let thinkingTokens = 0;
  let sawThinking = false;
  for (const [model, now] of Object.entries(current)) {
    const before = from[model];
    inputTokens += now.inputTokens - (before?.inputTokens ?? 0);
    outputTokens += now.outputTokens - (before?.outputTokens ?? 0);
    costUsd += Math.max(0, now.costUsd - (before?.costUsd ?? 0));
    if (now.thinkingTokens !== undefined) {
      thinkingTokens += Math.max(0, now.thinkingTokens - (before?.thinkingTokens ?? 0));
      sawThinking = true;
    }
  }
  return {
    turn: {
      inputTokens,
      outputTokens,
      ...(sawThinking ? { thinkingTokens } : {}),
      costUsd,
    },
    ledger: current,
  };
}
