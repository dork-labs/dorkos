import { describe, it, expect } from 'vitest';
import { CalibrationSchema, GatesSchema } from '../config-schema.js';
import {
  planApprovalRequired,
  tripsCircuitBreaker,
  evaluateAutoMerge,
  type GatesConfig,
  type MergeState,
  type UnitUsage,
} from '../gates.js';
import { CalibrationRow, type Calibration } from '../calibration.js';

/** The §9 resolved default gates config — the oracle the spec ships. */
const DEFAULT_GATES: GatesConfig = GatesSchema.parse({});
/** The §9 resolved default calibration config that routes recovery judgements. */
const DEFAULT_CALIBRATION: Calibration = CalibrationSchema.parse({});

/** A merge-time state with every precondition passing, overridable per-test. */
function mergeState(overrides: Partial<MergeState> = {}): MergeState {
  return {
    mergeable: 'clean',
    ci: 'green',
    functionalChange: false,
    attemptCount: 1,
    ...overrides,
  };
}

describe('planApprovalRequired — the plan-approval gate (§5/§7.4)', () => {
  it('is OFF by default — DECOMPOSE→EXECUTE flows automatically', () => {
    expect(planApprovalRequired(DEFAULT_GATES)).toBe(false);
  });

  it('blocks EXECUTE when an operator flips planApproval on', () => {
    const gated: GatesConfig = GatesSchema.parse({ planApproval: true });
    expect(planApprovalRequired(gated)).toBe(true);
  });
});

describe('tripsCircuitBreaker — gate 4 (§5/§6)', () => {
  const { circuitBreaker } = DEFAULT_GATES;

  function usage(overrides: Partial<UnitUsage> = {}): UnitUsage {
    return { estimateMs: 1000, elapsedMs: 500, tokensUsed: 0, ...overrides };
  }

  it('does not trip within budget', () => {
    expect(tripsCircuitBreaker(usage(), circuitBreaker)).toBeNull();
  });

  it('does not trip exactly AT the wall-clock limit (strictly-greater boundary)', () => {
    // estimate 1000 × multiplier 2 = 2000ms limit.
    expect(tripsCircuitBreaker(usage({ elapsedMs: 2000 }), circuitBreaker)).toBeNull();
  });

  it('trips on wall-clock once elapsed exceeds estimate × estimateMultiplier', () => {
    const trip = tripsCircuitBreaker(usage({ elapsedMs: 2001 }), circuitBreaker);
    expect(trip).not.toBeNull();
    expect(trip?.reason).toBe('wall-clock');
    expect(trip?.limit).toBe(2000);
    expect(trip?.observed).toBe(2001);
  });

  it('honors a custom estimateMultiplier (config-driven)', () => {
    const breaker = GatesSchema.parse({ circuitBreaker: { estimateMultiplier: 3 } }).circuitBreaker;
    // 1000 × 3 = 3000ms; 2500ms no longer trips.
    expect(tripsCircuitBreaker(usage({ elapsedMs: 2500 }), breaker)).toBeNull();
    expect(tripsCircuitBreaker(usage({ elapsedMs: 3001 }), breaker)?.reason).toBe('wall-clock');
  });

  it('does not trip exactly AT the token budget (strictly-greater boundary)', () => {
    expect(tripsCircuitBreaker(usage({ tokensUsed: 2_000_000 }), circuitBreaker)).toBeNull();
  });

  it('trips on the token budget once tokens exceed tokenBudget', () => {
    const trip = tripsCircuitBreaker(usage({ tokensUsed: 2_000_001 }), circuitBreaker);
    expect(trip).not.toBeNull();
    expect(trip?.reason).toBe('token-budget');
    expect(trip?.limit).toBe(2_000_000);
    expect(trip?.observed).toBe(2_000_001);
  });

  it('checks wall-clock before the token budget when both breach', () => {
    const trip = tripsCircuitBreaker(
      usage({ elapsedMs: 5000, tokensUsed: 5_000_000 }),
      circuitBreaker
    );
    expect(trip?.reason).toBe('wall-clock');
  });

  it('honors a custom tokenBudget (config-driven)', () => {
    const breaker = GatesSchema.parse({ circuitBreaker: { tokenBudget: 1000 } }).circuitBreaker;
    expect(tripsCircuitBreaker(usage({ tokensUsed: 1000 }), breaker)).toBeNull();
    expect(tripsCircuitBreaker(usage({ tokensUsed: 1001 }), breaker)?.reason).toBe('token-budget');
  });
});

describe('evaluateAutoMerge — the auto-merge recovery ladder (§6)', () => {
  describe('all preconditions pass → merge + close + teardown', () => {
    it('clean + green + no functional change → merge (teardown per config)', () => {
      const disp = evaluateAutoMerge(mergeState(), DEFAULT_GATES, DEFAULT_CALIBRATION);
      expect(disp.kind).toBe('merge');
      expect(disp.blocks).toBe(false);
      if (disp.kind === 'merge') expect(disp.teardownWorktree).toBe(true);
    });

    it('respects teardownWorktree:false', () => {
      const gates = GatesSchema.parse({ review: { teardownWorktree: false } });
      const disp = evaluateAutoMerge(mergeState(), gates, DEFAULT_CALIBRATION);
      expect(disp.kind).toBe('merge');
      if (disp.kind === 'merge') expect(disp.teardownWorktree).toBe(false);
    });
  });

  describe('precondition 1 — Mergeable? (§6, row 1)', () => {
    it('mechanical/no-functional-risk conflict → resolve + announce (continues)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-mechanical' }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('resolve-and-announce');
      expect(disp.blocks).toBe(false);
      // Routed through the calibration ladder as reversible+confident (row 1).
      if (disp.kind === 'resolve-and-announce') {
        expect(disp.row).toBe(CalibrationRow.ReversibleConfident);
      }
    });

    it('real-tradeoff conflict → bounce (agent/needs-rebase, blocks, re-assign)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real' }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('bounce');
      expect(disp.blocks).toBe(true);
      if (disp.kind === 'bounce') {
        expect(disp.label).toBe('agent/needs-rebase');
        // Routed through the calibration ladder as sticky+not-confident (row 2).
        expect(disp.row).toBe(CalibrationRow.StickyNotConfident);
      }
    });

    it('onConflict:always-bounce forces even a mechanical conflict to bounce', () => {
      const gates = GatesSchema.parse({ review: { onConflict: 'always-bounce' } });
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-mechanical' }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('bounce');
      expect(disp.blocks).toBe(true);
    });

    it('onConflict:never-resolve also bounces a mechanical conflict', () => {
      const gates = GatesSchema.parse({ review: { onConflict: 'never-resolve' } });
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-mechanical' }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('bounce');
    });

    it('the mergeable check precedes the CI check (a conflict short-circuits red CI)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real', ci: 'red-first' }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('bounce');
    });
  });

  describe('precondition 2 — CI green? (§6, row 2)', () => {
    it('first red → retry once (flake guard, ciRetries=1, continues)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ ci: 'red-first' }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('retry-ci');
      expect(disp.blocks).toBe(false);
      if (disp.kind === 'retry-ci') expect(disp.retriesRemaining).toBe(1);
    });

    it('still red after the retry → re-enter EXECUTE→VERIFY, regenerate evidence', () => {
      const disp = evaluateAutoMerge(
        mergeState({ ci: 'red-after-retry' }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('re-enter-execute');
      expect(disp.blocks).toBe(false);
    });

    it('ciRetries:0 → a first red goes straight to re-enter (no flake guard)', () => {
      const gates = GatesSchema.parse({ review: { ciRetries: 0 } });
      const disp = evaluateAutoMerge(mergeState({ ci: 'red-first' }), gates, DEFAULT_CALIBRATION);
      expect(disp.kind).toBe('re-enter-execute');
    });

    it('requireCiGreen:false skips the CI check entirely → merges on red', () => {
      const gates = GatesSchema.parse({ review: { requireCiGreen: false } });
      const disp = evaluateAutoMerge(
        mergeState({ ci: 'red-after-retry' }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('merge');
    });
  });

  describe('precondition 3 — Functionally unchanged since approval? (§6, row 3)', () => {
    it('mechanical-only (no functional change) → merge + close + teardown', () => {
      const disp = evaluateAutoMerge(
        mergeState({ functionalChange: false }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('merge');
      expect(disp.blocks).toBe(false);
    });

    it('behavior-altering drift → re-request approval (re-assign, fresh evidence, blocks)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ functionalChange: true }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('re-request-approval');
      expect(disp.blocks).toBe(true);
      // Routed through the calibration ladder as sticky+not-confident (row 2).
      if (disp.kind === 're-request-approval') {
        expect(disp.row).toBe(CalibrationRow.StickyNotConfident);
      }
    });

    it('reapproveOnFunctionalChange:false → merges despite functional drift', () => {
      const gates = GatesSchema.parse({ review: { reapproveOnFunctionalChange: false } });
      const disp = evaluateAutoMerge(
        mergeState({ functionalChange: true }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('merge');
    });
  });

  describe('runaway bounce → circuit-breaker escalation (§6)', () => {
    it('attemptCount over maxMergeAttempts → escalate (agent/blocked + nudge, blocks)', () => {
      const disp = evaluateAutoMerge(
        // default maxMergeAttempts=3; a 4th attempt is runaway.
        mergeState({ mergeable: 'conflict-real', attemptCount: 4 }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('escalate');
      expect(disp.blocks).toBe(true);
      if (disp.kind === 'escalate') {
        expect(disp.label).toBe('agent/blocked');
        expect(disp.reason).toContain('maxMergeAttempts=3');
      }
    });

    it('the final allowed attempt (== maxMergeAttempts) still bounces, not escalates', () => {
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real', attemptCount: 3 }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('bounce');
    });

    it('escalation pre-empts every precondition (runs even on a clean+green state)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ attemptCount: 4 }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('escalate');
    });

    it('honors a custom maxMergeAttempts (config-driven)', () => {
      const gates = GatesSchema.parse({ review: { maxMergeAttempts: 5 } });
      const stillBouncing = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real', attemptCount: 5 }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(stillBouncing.kind).toBe('bounce');
      const escalates = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real', attemptCount: 6 }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(escalates.kind).toBe('escalate');
    });
  });

  describe('mergeOnApproval:false opts out of auto-merge entirely', () => {
    it('returns a plain merge and skips the recovery ladder even on a real conflict', () => {
      const gates = GatesSchema.parse({ review: { mergeOnApproval: false } });
      const disp = evaluateAutoMerge(
        mergeState({ mergeable: 'conflict-real', ci: 'red-after-retry', functionalChange: true }),
        gates,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('merge');
      expect(disp.blocks).toBe(false);
    });
  });

  describe('precondition ordering — mergeable → CI → drift', () => {
    it('CI is checked before drift (red CI short-circuits a functional change)', () => {
      const disp = evaluateAutoMerge(
        mergeState({ ci: 'red-after-retry', functionalChange: true }),
        DEFAULT_GATES,
        DEFAULT_CALIBRATION
      );
      expect(disp.kind).toBe('re-enter-execute');
    });
  });
});
