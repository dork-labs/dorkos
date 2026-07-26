/**
 * Budget guard: cost is read from `status_change` frames (cumulative session
 * cost), the per-run cap aborts the run, and the per-eval soft ceiling fails a
 * runaway eval. `test-mode` reports no cost, so structural evals are free.
 */
import { describe, it, expect } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils';
import {
  BudgetTracker,
  frameCostUsd,
  evalCostSignal,
  evalCostUsd,
  parseBudgetUsd,
  VALUELESS_FLAG,
  DEFAULT_RUN_BUDGET_USD,
} from '../budget.js';

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

  it('tells "the runtime said zero" from "nothing ever said" (evalCostSignal)', () => {
    // The distinction the timed-out governance runs needed: a turn killed before
    // its terminal frame carries no cost frame at all, and reporting that as $0
    // accounted 92 seconds of real tokens as free.
    const noSignal: SseFrame[] = [
      { event: 'turn_start', data: { type: 'turn_start', seq: 0 } },
      { event: 'tool_call', data: { type: 'tool_call', seq: 1 } },
    ];
    expect(evalCostSignal(noSignal)).toBeNull();
    expect(evalCostUsd(noSignal)).toBe(0);

    // A runtime that genuinely reported zero is a different fact, and stays one.
    expect(evalCostSignal([usageFrame(0, 1)])).toBe(0);
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

describe('parseBudgetUsd — a cleared --budget must never disable the cap', () => {
  it('accepts a plain number and defaults an absent flag', () => {
    expect(parseBudgetUsd('3')).toBe(3);
    expect(parseBudgetUsd('0.25')).toBe(0.25);
    expect(parseBudgetUsd('0')).toBe(0);
    expect(parseBudgetUsd(undefined)).toBeUndefined();
  });

  it('REJECTS a valueless --budget (the cleared workflow input)', () => {
    // `budget_usd: ''` reaches the shell as `--budget ""`, which the arg parser
    // stores as this sentinel. `Number('true')` is NaN, `NaN ?? 3` is NaN, and
    // `total > NaN` is always false — the run spent with no ceiling and then
    // threw in `RunSummarySchema.parse`, losing results.json after the money.
    expect(() => parseBudgetUsd(VALUELESS_FLAG)).toThrow(/needs a number/);
  });

  it('REJECTS anything non-finite or negative', () => {
    expect(() => parseBudgetUsd('')).toThrow(/finite, non-negative/);
    expect(() => parseBudgetUsd('lots')).toThrow(/finite, non-negative/);
    expect(() => parseBudgetUsd('NaN')).toThrow(/finite, non-negative/);
    expect(() => parseBudgetUsd('Infinity')).toThrow(/finite, non-negative/);
    expect(() => parseBudgetUsd('-1')).toThrow(/finite, non-negative/);
  });
});

describe('BudgetTracker construction', () => {
  it('refuses a non-finite cap instead of silently enforcing nothing', () => {
    expect(() => new BudgetTracker({ runBudgetUsd: Number.NaN })).toThrow(/finite, non-negative/);
    expect(() => new BudgetTracker({ perEvalCeilingUsd: Number.NaN })).toThrow(
      /finite, non-negative/
    );
    expect(() => new BudgetTracker({ runBudgetUsd: -1 })).toThrow(/finite, non-negative/);
  });

  it('a NaN cap would have removed the ceiling, not raised it', () => {
    // The property that made the bug silent: EVERY ordering comparison against
    // NaN is false, so `total > runBudgetUsd` never fired.
    const nanCap = Number('true');
    expect(Number.isNaN(nanCap)).toBe(true);
    expect(5 > nanCap).toBe(false);
    // The tracker's default is a real number, so enforcement actually happens.
    const tracker = new BudgetTracker({});
    tracker.record([usageFrame(DEFAULT_RUN_BUDGET_USD + 1, 1)]);
    expect(tracker.isOverRunBudget()).toBe(true);
  });
});

describe('BudgetTracker.record — the per-eval override is guarded too', () => {
  it('REJECTS a non-finite per-eval ceiling override', () => {
    // This was the one path that skipped `requireFiniteCap`: a NaN override on a
    // $99 eval returned exceededEvalCeiling: false, silently removing that
    // eval's soft cap. The run cap still fires, so the blast radius is one
    // ceiling, but it is the exact failure the guard's docstring argues against.
    const tracker = new BudgetTracker({ perEvalCeilingUsd: 1 });
    expect(() => tracker.record([usageFrame(99, 1)], { perEvalCeilingUsd: Number.NaN })).toThrow(
      /finite, non-negative/
    );
  });

  it('still honors a legitimate tighter override', () => {
    const tracker = new BudgetTracker({ perEvalCeilingUsd: 1 });
    const verdict = tracker.record([usageFrame(0.75, 1)], { perEvalCeilingUsd: 0.5 });
    expect(verdict.exceededEvalCeiling).toBe(true);
  });

  it('falls back to the constructor ceiling when no override is given', () => {
    const tracker = new BudgetTracker({ perEvalCeilingUsd: 0.5 });
    expect(tracker.record([usageFrame(0.75, 1)]).exceededEvalCeiling).toBe(true);
  });
});
