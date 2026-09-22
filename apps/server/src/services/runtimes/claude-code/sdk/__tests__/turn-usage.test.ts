import { describe, it, expect } from 'vitest';
import { advanceUsageLedger, readModelUsageTotals, type UsageLedger } from '../turn-usage.js';

describe('readModelUsageTotals', () => {
  it('reads the SDK field names and keeps thinking only where reported', () => {
    expect(
      readModelUsageTotals({
        a: { inputTokens: 10, outputTokens: 2, thinkingTokens: 1, costUSD: 0.5 },
        b: { inputTokens: 3 },
      })
    ).toEqual({
      a: { inputTokens: 10, outputTokens: 2, thinkingTokens: 1, costUsd: 0.5 },
      b: { inputTokens: 3, outputTokens: 0, costUsd: 0 },
    });
  });
});

describe('advanceUsageLedger', () => {
  const ledger = (input: number, output: number, cost: number, thinking?: number): UsageLedger => ({
    opus: {
      inputTokens: input,
      outputTokens: output,
      costUsd: cost,
      ...(thinking !== undefined ? { thinkingTokens: thinking } : {}),
    },
  });

  it('derives nothing, but still records the totals, when the baseline is unknown', () => {
    const current = ledger(100, 10, 1);
    expect(advanceUsageLedger(current, undefined)).toEqual({ ledger: current });
  });

  it('reports the whole result against an empty (brand-new) baseline', () => {
    expect(advanceUsageLedger(ledger(100, 10, 1, 4), {}).turn).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      thinkingTokens: 4,
      costUsd: 1,
    });
  });

  it('differences a growing running total', () => {
    const step = advanceUsageLedger(ledger(250, 30, 2.5, 9), ledger(100, 10, 1, 4));
    expect(step.turn).toEqual({
      inputTokens: 150,
      outputTokens: 20,
      thinkingTokens: 5,
      costUsd: 1.5,
    });
    expect(step.ledger).toEqual(ledger(250, 30, 2.5, 9));
  });

  it('sums across models, counting a model new this turn from zero', () => {
    const step = advanceUsageLedger(
      { ...ledger(250, 30, 2), haiku: { inputTokens: 40, outputTokens: 5, costUsd: 0.1 } },
      ledger(100, 10, 1)
    );
    expect(step.turn?.inputTokens).toBe(190);
    expect(step.turn?.outputTokens).toBe(25);
    expect(step.turn?.costUsd).toBeCloseTo(1.1, 9);
    expect(step.turn?.thinkingTokens).toBeUndefined();
  });

  it('treats a drop in any count as a restart and reports the whole result', () => {
    expect(advanceUsageLedger(ledger(60, 50, 0.4), ledger(100, 10, 1)).turn).toEqual({
      inputTokens: 60,
      outputTokens: 50,
      costUsd: 0.4,
    });
  });

  it('treats a model vanishing from the totals as a restart', () => {
    const step = advanceUsageLedger(
      { haiku: { inputTokens: 500, outputTokens: 20, costUsd: 0.2 } },
      { ...ledger(100, 10, 1), haiku: { inputTokens: 40, outputTokens: 5, costUsd: 0.1 } }
    );
    expect(step.turn?.inputTokens).toBe(500);
  });
});
