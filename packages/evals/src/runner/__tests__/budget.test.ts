/**
 * Budget guard: cost is read from `status_change` frames (cumulative session
 * cost), the per-run cap aborts the run, and the per-eval soft ceiling fails a
 * runaway eval. `test-mode` reports no cost, so structural evals are free.
 */
import { describe, it, expect } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils';
import { BudgetTracker, frameCostUsd, evalCostUsd } from '../budget.js';

/** A durable `status_change` frame carrying a cumulative `usage.costUsd`. */
function usageFrame(costUsd: number, seq: number): SseFrame {
  return {
    event: 'status_change',
    data: { type: 'status_change', seq, status: { usage: { kind: 'pay-as-you-go', costUsd } } },
  };
}

/** A durable `status_change` frame carrying only the top-level `status.cost`. */
function costFrame(cost: number, seq: number): SseFrame {
  return { event: 'status_change', data: { type: 'status_change', seq, status: { cost } } };
}

describe('frameCostUsd / evalCostUsd', () => {
  it('reads cost from usage.costUsd and from the top-level status.cost fallback', () => {
    expect(frameCostUsd(usageFrame(0.02, 1))).toBe(0.02);
    expect(frameCostUsd(costFrame(0.05, 1))).toBe(0.05);
  });

  it('returns null for non-status frames and frames with no cost', () => {
    expect(
      frameCostUsd({ event: 'text_delta', data: { type: 'text_delta', text: 'hi', seq: 1 } })
    ).toBeNull();
    expect(frameCostUsd({ event: 'turn_end', data: { type: 'turn_end', seq: 9 } })).toBeNull();
  });

  it('takes the MAX cumulative cost across frames (values are cumulative, not deltas)', () => {
    const frames = [usageFrame(0.01, 1), usageFrame(0.03, 2), usageFrame(0.03, 3)];
    expect(evalCostUsd(frames)).toBe(0.03);
  });

  it('is zero when no frame reports a cost (test-mode)', () => {
    const frames: SseFrame[] = [
      { event: 'turn_start', data: { type: 'turn_start', seq: 0 } },
      { event: 'turn_end', data: { type: 'turn_end', seq: 1 } },
    ];
    expect(evalCostUsd(frames)).toBe(0);
  });
});

describe('BudgetTracker', () => {
  it('accumulates per-eval cost into the run total', () => {
    const tracker = new BudgetTracker({ runBudgetUsd: 1, perEvalCeilingUsd: 1 });
    const first = tracker.record([usageFrame(0.1, 1)]);
    expect(first.evalCostUsd).toBeCloseTo(0.1);
    expect(first.totalCostUsd).toBeCloseTo(0.1);
    const second = tracker.record([usageFrame(0.2, 1)]);
    expect(second.totalCostUsd).toBeCloseTo(0.3);
  });

  it('flags the per-run breach once the total exceeds the cap', () => {
    const tracker = new BudgetTracker({ runBudgetUsd: 0.25, perEvalCeilingUsd: 1 });
    expect(tracker.record([usageFrame(0.2, 1)]).exceededRunBudget).toBe(false);
    const over = tracker.record([usageFrame(0.1, 1)]);
    expect(over.exceededRunBudget).toBe(true);
    expect(tracker.isOverRunBudget()).toBe(true);
  });

  it('fails a single eval that breaches its per-eval soft ceiling (a runaway turn)', () => {
    const tracker = new BudgetTracker({ runBudgetUsd: 100, perEvalCeilingUsd: 0.5 });
    const verdict = tracker.record([usageFrame(0.9, 1)]);
    expect(verdict.exceededEvalCeiling).toBe(true);
    expect(verdict.exceededRunBudget).toBe(false);
  });

  it('honors a per-case ceiling override tighter than the default', () => {
    const tracker = new BudgetTracker({ runBudgetUsd: 100, perEvalCeilingUsd: 1 });
    const verdict = tracker.record([usageFrame(0.2, 1)], { perEvalCeilingUsd: 0.1 });
    expect(verdict.exceededEvalCeiling).toBe(true);
  });

  it('never trips on a free (test-mode) eval', () => {
    const tracker = new BudgetTracker({ runBudgetUsd: 0.0001, perEvalCeilingUsd: 0.0001 });
    const verdict = tracker.record([{ event: 'turn_end', data: { type: 'turn_end', seq: 0 } }]);
    expect(verdict.evalCostUsd).toBe(0);
    expect(verdict.exceededEvalCeiling).toBe(false);
    expect(verdict.exceededRunBudget).toBe(false);
  });
});
