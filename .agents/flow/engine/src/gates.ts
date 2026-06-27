/**
 * The four **hard gates** (§5) and the **auto-merge recovery ladder** (§6) —
 * the `/flow` engine's typed, config-driven control over when the autonomous
 * loop pauses for a human and how an approved-but-stale PR is recovered at merge
 * time.
 *
 * ## The four hard gates
 *
 * 1. **Question / soft-escalation** (any stage, dynamic) — NOT modeled here as a
 *    separate predicate: it is the calibration ladder itself
 *    ({@link resolveInvolvement}, task 2.1). Every disposition in this module
 *    that involves a judgement call ("is this conflict mechanical or a real
 *    tradeoff?", "is this drift behavior-altering?") is routed THROUGH that
 *    ladder rather than re-deriving the stop-vs-proceed behavior.
 * 2. **Plan-approval gate** (after DECOMPOSE, before EXECUTE) — OFF by default
 *    (`gates.planApproval: false`, §7.4). {@link planApprovalRequired} is the
 *    predicate; when `false` the engine flows DECOMPOSE→EXECUTE automatically
 *    and surfaces plan assumptions at the human-review gate instead.
 * 3. **Human-review gate** (after VERIFY) — ALWAYS ON; it is not config-gated
 *    (there is no knob to disable it). It is the entry point to the auto-merge
 *    recovery ladder: PR + evidence → In Review → assign human → stop; on
 *    approval the engine runs {@link evaluateAutoMerge}.
 * 4. **Circuit breaker** — {@link tripsCircuitBreaker} stops + escalates when a
 *    unit exceeds `estimate × estimateMultiplier` wall-clock or the `tokenBudget`.
 *
 * ## The auto-merge recovery ladder (§6)
 *
 * Human approval authorizes exactly **one state**: this diff, green, cleanly
 * mergeable. If that state can't be reproduced automatically at merge time, the
 * agent does NOT merge — {@link evaluateAutoMerge} checks three preconditions in
 * order (mergeable? → CI green? → functionally unchanged?), and each failure is
 * routed through the calibration ladder to a typed {@link MergeDisposition}.
 *
 * ## This module is the pinned oracle, not dead code
 *
 * As with {@link resolveInvolvement} and the dispatch policy, the v1 prose stage
 * skills describe these same gate rules in natural language; this TypeScript is
 * the tested source of truth and the **P5 promotion surface** — when the server
 * build replaces the skill-driven loop, it calls these functions directly. Every
 * threshold is read from {@link GatesSchema} config so re-tuning a gate is a
 * config edit, never a code change.
 *
 * @see specs/unified-workflow-system/02-specification.md §5 (gates), §6 (recovery ladder), §7.4 (plan-approval default off)
 * @module @dorkos/flow/gates
 */

import type { z } from 'zod';
import type { CircuitBreakerSchema, GatesSchema, ReviewGateSchema } from './config-schema.js';
import {
  resolveInvolvement,
  type Calibration,
  type DecisionDescriptor,
  type InvolvementDecision,
} from './calibration.js';

/** Resolved {@link GatesSchema} config — plan approval, review/auto-merge, circuit breaker. */
export type GatesConfig = z.infer<typeof GatesSchema>;
/** Resolved {@link ReviewGateSchema} config — the auto-merge / review-gate policy. */
export type ReviewGateConfig = z.infer<typeof ReviewGateSchema>;
/** Resolved {@link CircuitBreakerSchema} config — wall-clock multiplier + token budget. */
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerSchema>;

/**
 * Mergeability of the PR against the target branch at merge time (§6, row 1).
 * - `clean` — replays cleanly; merge can continue (announce the rebase).
 * - `conflict-mechanical` — a no-functional-risk conflict (both sides add an
 *   import, append a changelog/lockfile line): reversible + confident.
 * - `conflict-real` — overlapping logic edits, a genuine tradeoff: sticky +
 *   not-confident.
 *
 * The `mechanical` vs `real` distinction is the adapter's classification of the
 * conflict; this module routes it through the calibration ladder, it does not
 * re-classify.
 */
export type MergeableState = 'clean' | 'conflict-mechanical' | 'conflict-real';

/**
 * CI status of the approved diff at merge time (§6, row 2).
 * - `green` — CI passes; continue.
 * - `red-first` — first red result (could be a flake): eligible for one retry.
 * - `red-after-retry` — still red after the `ciRetries` flake guard: a real
 *   failure that must re-enter EXECUTE→VERIFY.
 */
export type CiState = 'green' | 'red-first' | 'red-after-retry';

/**
 * The facts about an approved PR at merge time, fed to {@link evaluateAutoMerge}.
 * Carries the three precondition signals plus the running attempt count for the
 * runaway-bounce circuit breaker.
 */
export interface MergeState {
  /** Mergeability against the target branch. */
  mergeable: MergeableState;
  /** CI status of the approved diff. */
  ci: CiState;
  /**
   * Whether the diff has functionally changed since approval (§6, row 3). A
   * mechanical-only change (clean rebase, lockfile churn) is `false`; a
   * behavior-altering change is `true`. The adapter/agent determines this; the
   * ladder routes it.
   */
  functionalChange: boolean;
  /**
   * How many merge attempts (fix→review cycles) this unit has already burned.
   * The FIRST attempt is `1`. When it exceeds `review.maxMergeAttempts` the
   * ladder escalates via the circuit breaker instead of bouncing again (§6).
   */
  attemptCount: number;
}

/**
 * The disposition kinds the auto-merge recovery ladder (§6) can produce. A
 * discriminated union (over {@link MergeDisposition.kind}) rather than boolean
 * flags so every branch is exhaustively handled at the call site.
 */
export type MergeDispositionKind =
  | 'merge'
  | 'resolve-and-announce'
  | 'bounce'
  | 'retry-ci'
  | 're-enter-execute'
  | 're-request-approval'
  | 'escalate';

/** Tracker label applied when a real conflict bounces back to the human (§6). */
const LABEL_NEEDS_REBASE = 'agent/needs-rebase';
/** Tracker label applied when a runaway bounce escalates via the circuit breaker (§6). */
const LABEL_BLOCKED = 'agent/blocked';

/**
 * The resolved outcome of the auto-merge recovery ladder (§6) — a discriminated
 * union over {@link MergeDisposition.kind}. Each variant carries exactly the
 * fields its branch acts on (the tracker label to apply, whether the loop
 * blocks, the calibration row that produced a judgement-routed disposition).
 *
 * - `merge` — preconditions hold (or the only changes were mechanical): merge +
 *   close + teardown, announcing the result.
 * - `resolve-and-announce` — a mechanical/no-functional-risk conflict: resolve
 *   it automatically and announce the rebase; the loop continues.
 * - `bounce` — a real-tradeoff conflict: apply `agent/needs-rebase`, move to In
 *   Progress, comment, and re-assign the human; the loop blocks.
 * - `retry-ci` — first red CI: retry once as a flake guard; the loop continues.
 * - `re-enter-execute` — still red after the retry: re-enter EXECUTE→VERIFY and
 *   regenerate evidence; the loop continues (counts as a fresh merge attempt).
 * - `re-request-approval` — behavior-altering drift since approval: re-assign
 *   with fresh evidence and re-request approval; the loop blocks.
 * - `escalate` — runaway bounce over `maxMergeAttempts`, or any
 *   circuit-breaker trip: apply `agent/blocked` + nudge; the loop blocks.
 */
export type MergeDisposition =
  | {
      kind: 'merge';
      /** The loop continues to teardown; this disposition never blocks. */
      blocks: false;
      /** Tear down the worktree after merge per `review.teardownWorktree`. */
      teardownWorktree: boolean;
    }
  | {
      kind: 'resolve-and-announce';
      blocks: false;
      /** The calibration row that classified the conflict as mechanical. */
      row: InvolvementDecision['row'];
    }
  | {
      kind: 'bounce';
      blocks: true;
      /** `agent/needs-rebase` — the durable bounce label. */
      label: typeof LABEL_NEEDS_REBASE;
      /** The calibration row that classified the conflict as a real tradeoff. */
      row: InvolvementDecision['row'];
    }
  | {
      kind: 'retry-ci';
      blocks: false;
      /** Remaining flake-guard retries authorized by `review.ciRetries`. */
      retriesRemaining: number;
    }
  | { kind: 're-enter-execute'; blocks: false }
  | {
      kind: 're-request-approval';
      blocks: true;
      /** The calibration row that classified the drift as behavior-altering. */
      row: InvolvementDecision['row'];
    }
  | {
      kind: 'escalate';
      blocks: true;
      /** `agent/blocked` — the durable escalation label. */
      label: typeof LABEL_BLOCKED;
      /** Human-readable reason the breaker tripped, for the escalation comment. */
      reason: string;
    };

/**
 * Whether the plan-approval gate (gate 2, §5/§7.4) blocks the DECOMPOSE→EXECUTE
 * transition. OFF by default: when `gates.planApproval` is `false` the engine
 * flows straight into EXECUTE and surfaces plan assumptions at the human-review
 * gate; operators who want a pre-code checkpoint flip it on.
 *
 * @param gates - The resolved gates config.
 * @returns `true` if EXECUTE must wait for plan approval.
 */
export function planApprovalRequired(gates: GatesConfig): boolean {
  return gates.planApproval;
}

/** Resource usage of a single work unit, measured for the circuit breaker (§5/§6). */
export interface UnitUsage {
  /** Estimated wall-clock for the unit, in milliseconds (the budget baseline). */
  estimateMs: number;
  /** Actual wall-clock elapsed on the unit so far, in milliseconds. */
  elapsedMs: number;
  /** Tokens consumed by the unit so far. */
  tokensUsed: number;
}

/**
 * Why the circuit breaker tripped, or `null` when it has not. A discriminated
 * result (rather than a bare boolean) so the escalation comment can name the
 * threshold that was breached.
 */
export type CircuitBreakerTrip = null | {
  /** The breached threshold. */
  reason: 'wall-clock' | 'token-budget';
  /** The configured limit that was exceeded (ms for wall-clock, tokens for budget). */
  limit: number;
  /** The observed value that breached the limit. */
  observed: number;
};

/**
 * Whether a unit's usage trips the circuit breaker (gate 4, §5/§6): it exceeds
 * `estimate × estimateMultiplier` wall-clock OR the `tokenBudget`. Wall-clock is
 * checked first (it is the cheaper, earlier signal). Returns the breached
 * threshold so the caller can escalate with a precise reason, or `null` when the
 * unit is still within budget.
 *
 * @param usage - The unit's measured estimate, elapsed wall-clock, and token spend.
 * @param circuitBreaker - The resolved circuit-breaker thresholds.
 * @returns The trip descriptor, or `null` if within budget.
 */
export function tripsCircuitBreaker(
  usage: UnitUsage,
  circuitBreaker: CircuitBreakerConfig
): CircuitBreakerTrip {
  const wallClockLimit = usage.estimateMs * circuitBreaker.estimateMultiplier;
  if (usage.elapsedMs > wallClockLimit) {
    return { reason: 'wall-clock', limit: wallClockLimit, observed: usage.elapsedMs };
  }
  if (usage.tokensUsed > circuitBreaker.tokenBudget) {
    return {
      reason: 'token-budget',
      limit: circuitBreaker.tokenBudget,
      observed: usage.tokensUsed,
    };
  }
  return null;
}

/**
 * Route a recovery judgement call ("is this conflict mechanical?", "is this
 * drift behavior-altering?") through the calibration ladder (§5) rather than
 * re-deriving the stop-vs-proceed behavior in this module. A mechanical /
 * no-functional-risk change is modeled as `reversible + confident` (the ladder
 * proceeds); a real tradeoff is `sticky + not-confident` (the ladder stops).
 *
 * The recovery ladder runs in an execution stage (it is post-VERIFY merge work),
 * so row 3's ambiguous middle is never reached for these descriptors — they are
 * always either reversible+confident (row 1) or sticky+not-confident (row 2).
 *
 * @param isMechanical - Whether the change is mechanical / no-functional-risk.
 * @param calibration - The resolved `involvement.calibration` config block.
 * @returns The ladder's decision (its `behavior`/`blocks`/`row`).
 */
function routeThroughCalibration(
  isMechanical: boolean,
  calibration: Calibration
): InvolvementDecision {
  const descriptor: DecisionDescriptor = isMechanical
    ? { reversibility: 'reversible', confidence: 'confident', stage: 'execution' }
    : { reversibility: 'sticky', confidence: 'not-confident', stage: 'execution' };
  return resolveInvolvement(descriptor, calibration);
}

/**
 * Precondition 1 (§6, row 1) — Mergeable? Routes a conflict through the
 * calibration ladder: a mechanical/no-functional-risk conflict resolves +
 * announces; a real-tradeoff conflict bounces (`agent/needs-rebase`, re-assign).
 *
 * `onConflict` overrides the ladder at the edges: `always-bounce` forces a
 * bounce even for mechanical conflicts; `never-resolve` does the same. Only the
 * default `resolve-if-mechanical` consults the ladder. A `clean` replay returns
 * `null` (the precondition passes; fall through to the CI check).
 */
function evaluateMergeable(
  state: MergeState,
  review: ReviewGateConfig,
  calibration: Calibration
): MergeDisposition | null {
  if (state.mergeable === 'clean') return null;

  const isMechanical =
    state.mergeable === 'conflict-mechanical' && review.onConflict === 'resolve-if-mechanical';
  const decision = routeThroughCalibration(isMechanical, calibration);

  if (decision.behavior === 'stop-and-ask') {
    return { kind: 'bounce', blocks: true, label: LABEL_NEEDS_REBASE, row: decision.row };
  }
  return { kind: 'resolve-and-announce', blocks: false, row: decision.row };
}

/**
 * Precondition 2 (§6, row 2) — CI green? A first red result retries once (flake
 * guard, `review.ciRetries`); still red after the retry re-enters EXECUTE→VERIFY
 * to regenerate evidence. Green returns `null` (passes; fall through to drift).
 */
function evaluateCi(state: MergeState, review: ReviewGateConfig): MergeDisposition | null {
  switch (state.ci) {
    case 'green':
      return null;
    case 'red-first':
      if (review.ciRetries > 0) {
        return { kind: 'retry-ci', blocks: false, retriesRemaining: review.ciRetries };
      }
    // No retries configured — treat a first red exactly like a confirmed red.
    // falls through
    case 'red-after-retry':
      return { kind: 're-enter-execute', blocks: false };
  }
}

/**
 * Precondition 3 (§6, row 3) — Functionally unchanged since approval? A
 * mechanical-only change merges (+ close + teardown); a behavior-altering change
 * re-requests approval (re-assign, fresh evidence) when
 * `review.reapproveOnFunctionalChange` is on. The drift judgement is routed
 * through the calibration ladder via {@link routeThroughCalibration}.
 */
function evaluateDrift(
  state: MergeState,
  review: ReviewGateConfig,
  calibration: Calibration
): MergeDisposition {
  if (state.functionalChange && review.reapproveOnFunctionalChange) {
    const decision = routeThroughCalibration(false, calibration);
    return { kind: 're-request-approval', blocks: true, row: decision.row };
  }
  return { kind: 'merge', blocks: false, teardownWorktree: review.teardownWorktree };
}

/**
 * Evaluate the **auto-merge recovery ladder** (§6) for an approved PR at merge
 * time. Approval authorized one state — this diff, green, cleanly mergeable — so
 * this function re-checks the three preconditions in order and returns the typed
 * {@link MergeDisposition} for the first failure (or `merge` when all hold).
 *
 * Order and routing:
 * 1. **Runaway guard first** — if `attemptCount` has already exceeded
 *    `review.maxMergeAttempts`, the fix→review→red loop is runaway: escalate via
 *    the circuit breaker (`agent/blocked` + nudge) instead of bouncing again.
 * 2. **Mergeable?** — clean → continue; conflict → mechanical resolves +
 *    announces, real tradeoff bounces. Routed through the calibration ladder.
 * 3. **CI green?** — green → continue; first red retries once; still red
 *    re-enters EXECUTE→VERIFY.
 * 4. **Functionally unchanged?** — mechanical-only → merge + close + teardown;
 *    behavior-altering → re-request approval. Routed through the ladder.
 *
 * `review.mergeOnApproval: false` opts out of auto-merge entirely: the recovery
 * ladder is skipped and the disposition is always a plain `merge` (the human
 * merges by hand; the engine performs no replay/CI/drift recovery). The ladder
 * only runs when the operator has opted into auto-merge-on-approval.
 *
 * @param state - The approved PR's merge-time facts (mergeable / CI / drift / attempts).
 * @param gates - The resolved gates config (review policy + circuit breaker).
 * @param calibration - The resolved `involvement.calibration` config block, used
 *   to route the mechanical-vs-real and drift judgements (§5).
 * @returns The single disposition to act on.
 */
export function evaluateAutoMerge(
  state: MergeState,
  gates: GatesConfig,
  calibration: Calibration
): MergeDisposition {
  const { review } = gates;

  // Auto-merge opted out — the human merges by hand; no recovery ladder runs.
  if (!review.mergeOnApproval) {
    return { kind: 'merge', blocks: false, teardownWorktree: review.teardownWorktree };
  }

  // Runaway bounce guard (§6): fix→review→red over maxMergeAttempts escalates
  // via the circuit breaker rather than bouncing again.
  if (state.attemptCount > review.maxMergeAttempts) {
    return {
      kind: 'escalate',
      blocks: true,
      label: LABEL_BLOCKED,
      reason: `runaway merge: ${state.attemptCount} attempts exceeds maxMergeAttempts=${review.maxMergeAttempts}`,
    };
  }

  // Precondition 1 — Mergeable?
  const mergeableDisposition = evaluateMergeable(state, review, calibration);
  if (mergeableDisposition) return mergeableDisposition;

  // Precondition 2 — CI green? (only requireCiGreen gates this; off ⇒ skip).
  if (review.requireCiGreen) {
    const ciDisposition = evaluateCi(state, review);
    if (ciDisposition) return ciDisposition;
  }

  // Precondition 3 — Functionally unchanged since approval?
  return evaluateDrift(state, review, calibration);
}
