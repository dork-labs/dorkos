/**
 * Tests for the agent-hour aggregation.
 *
 * Every function under test is pure arithmetic over plain data, and every one of
 * them is a place where a plausible-looking wrong answer would survive review —
 * a percentile that ignores its weights, a first turn whose tokens are dropped,
 * an hour boundary that double-counts. Each case below pins one of those.
 *
 * @module scripts/__tests__/agent-hours.test
 */
import { describe, expect, it } from 'vitest';

import {
  HOUR_MS,
  bucketKey,
  measureFanOut,
  parseBucketKey,
  summarize,
  toBuckets,
  toSlices,
  weightedPercentile,
  type Slice,
} from '../agent-hours/aggregate.js';
import {
  CACHE_WRITE_1H_RATIO,
  CACHE_WRITE_5M_RATIO,
  emptyMix,
  mixTotal,
  priceFor,
  priceMix,
  type TokenMix,
} from '../agent-hours/prices.js';
import type { Turn } from '../agent-hours/readers.js';

const GAP = 5 * 60_000;
const T0 = Date.parse('2026-09-01T10:00:00Z');

function mix(over: Partial<TokenMix> = {}): TokenMix {
  return { ...emptyMix(), ...over };
}

function turn(atMs: number, over: Partial<TokenMix> = {}, sessionKey = 's1'): Turn {
  return {
    runtime: 'claude-code',
    sessionKey,
    model: 'claude-sonnet-5',
    atMs,
    mix: mix(over),
    reportedCostUsd: null,
  };
}

function slice(startMs: number, endMs: number, over: Partial<Slice> = {}): Slice {
  return {
    runtime: 'claude-code',
    sessionKey: 's1',
    model: 'claude-sonnet-5',
    startMs,
    endMs,
    mix: mix({ input: 1000 }),
    costUsd: 1,
    repriceUsd: 1,
    ...over,
  };
}

describe('weightedPercentile', () => {
  it('follows the weights, not the count', () => {
    // One cheap sample and 99 units of weight on the expensive one: an
    // unweighted median would answer 1.
    const samples = [
      { value: 1, weight: 1 },
      { value: 3, weight: 99 },
    ];
    expect(weightedPercentile(samples, 0.5)).toBe(3);
  });

  it('returns null rather than a misleading zero for an empty sample', () => {
    expect(weightedPercentile([], 0.5)).toBeNull();
    expect(weightedPercentile([{ value: 5, weight: 0 }], 0.5)).toBeNull();
  });

  it('returns the top value at p95 of a skewed sample', () => {
    const samples = [
      { value: 1, weight: 90 },
      { value: 100, weight: 10 },
    ];
    expect(weightedPercentile(samples, 0.5)).toBe(1);
    expect(weightedPercentile(samples, 0.95)).toBe(100);
  });
});

describe('toSlices', () => {
  it('gives the first turn of a session a zero-length slice that keeps its tokens', () => {
    const slices = toSlices([turn(T0, { input: 7 }), turn(T0 + 60_000, { input: 11 })], GAP, null);
    expect(slices).toHaveLength(2);
    // The regression this pins: dropping the first turn loses its tokens from
    // the numerator, which biases every per-hour rate downward.
    expect(slices[0]!.endMs - slices[0]!.startMs).toBe(0);
    expect(slices[0]!.mix.input).toBe(7);
    expect(slices[1]!.endMs - slices[1]!.startMs).toBe(60_000);
    expect(slices.reduce((sum, s) => sum + mixTotal(s.mix), 0)).toBe(18);
  });

  it('keeps a single-turn session rather than dropping it entirely', () => {
    const slices = toSlices([turn(T0, { input: 5 })], GAP, null);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.mix.input).toBe(5);
  });

  it('clamps an interval longer than the gap threshold', () => {
    const slices = toSlices([turn(T0), turn(T0 + 60 * 60_000)], GAP, null);
    expect(slices[1]!.endMs - slices[1]!.startMs).toBe(GAP);
  });

  it('measures each session independently and does not interleave them', () => {
    const slices = toSlices(
      [turn(T0, {}, 'a'), turn(T0 + 30_000, {}, 'b'), turn(T0 + 60_000, {}, 'a')],
      GAP,
      null
    );
    const a = slices.filter((s) => s.sessionKey === 'a');
    // 'a' spans T0 → T0+60s despite 'b' landing in the middle.
    expect(a[1]!.endMs - a[1]!.startMs).toBe(60_000);
  });
});

describe('toBuckets', () => {
  it('apportions a slice straddling an hour boundary by time share', () => {
    const start = T0 - 15 * 60_000; // 09:45
    const end = T0 + 45 * 60_000; // 10:45
    const buckets = [...toBuckets([slice(start, end, { mix: mix({ input: 400 }), costUsd: 4 })])];
    expect(buckets).toHaveLength(2);
    const byHour = new Map(buckets.map(([key, b]) => [parseBucketKey(key)[3], b]));
    const first = byHour.get(T0 - HOUR_MS);
    const second = byHour.get(T0);
    expect(first?.mix.input).toBeCloseTo(100, 6); // 15 of 60 minutes
    expect(second?.mix.input).toBeCloseTo(300, 6);
    expect(first!.activeMs + second!.activeMs).toBe(end - start);
    expect(first!.costUsd + second!.costUsd).toBeCloseTo(4, 6);
  });

  it('places a zero-length slice in the hour containing it, with no time', () => {
    const buckets = [...toBuckets([slice(T0, T0, { mix: mix({ input: 9 }) })])];
    expect(buckets).toHaveLength(1);
    expect(buckets[0]![1].activeMs).toBe(0);
    expect(buckets[0]![1].mix.input).toBe(9);
  });

  it('round-trips a key whose parts contain delimiters and control characters', () => {
    // Built at runtime rather than written as a literal: a NUL escape in a
    // source file is one editor slip away from a real NUL byte, which turns the
    // whole file binary and removes its diff from review.
    const NUL = String.fromCharCode(0);
    const nasty = `a${NUL}b\tc"d`;
    const model = `m${NUL}x`;
    expect(parseBucketKey(bucketKey('claude-code', nasty, model, 42))).toEqual([
      'claude-code',
      nasty,
      model,
      42,
    ]);
  });
});

describe('summarize', () => {
  it('divides dollars by priced hours, not by every hour', () => {
    const priced = slice(T0, T0 + HOUR_MS, { costUsd: 10, repriceUsd: 10 });
    const unpriced = slice(T0 + HOUR_MS, T0 + 2 * HOUR_MS, {
      model: 'something-unpriced',
      costUsd: null,
      repriceUsd: 10,
    });
    const stats = summarize([...toBuckets([priced, unpriced]).values()], 0);
    expect(stats.activeHours).toBeCloseTo(2, 6);
    // $10 over the one priced hour — not $5 over two.
    expect(stats.usdPerHour?.mean).toBeCloseTo(10, 6);
    expect(stats.usdPerHour?.pricedHours).toBeCloseTo(1, 6);
    // Repricing covers both hours, so it averages over two.
    expect(stats.repricedUsdPerHour?.mean).toBeCloseTo(10, 6);
    expect(stats.repricedUsdPerHour?.pricedHours).toBeCloseTo(2, 6);
  });

  it('excludes sub-floor buckets from the percentiles and says how many survived', () => {
    const big = slice(T0, T0 + HOUR_MS);
    const tiny = slice(T0 + 2 * HOUR_MS, T0 + 2 * HOUR_MS + 1000, { sessionKey: 's2' });
    const stats = summarize([...toBuckets([big, tiny]).values()], 5 * 60_000);
    expect(stats.buckets).toBe(1);
    expect(stats.tokensPerHour.p50).toBeCloseTo(1000, 6);
  });
});

describe('measureFanOut', () => {
  it('counts two overlapping agents as two agent-hours in one wall-clock hour', () => {
    const a = slice(T0, T0 + HOUR_MS);
    const b = slice(T0, T0 + HOUR_MS, { sessionKey: 's2' });
    const out = measureFanOut([a, b]);
    expect(out.agentHours).toBeCloseTo(2, 6);
    expect(out.wallClockHours).toBeCloseTo(1, 6);
    expect(out.fanOut).toBeCloseTo(2, 6);
    expect(out.maxConcurrency).toBe(2);
  });

  it('does not report a handover at an exact tie as two concurrent agents', () => {
    const a = slice(T0, T0 + HOUR_MS);
    const b = slice(T0 + HOUR_MS, T0 + 2 * HOUR_MS, { sessionKey: 's2' });
    const out = measureFanOut([a, b]);
    expect(out.maxConcurrency).toBe(1);
    expect(out.wallClockHours).toBeCloseTo(2, 6);
    expect(out.fanOut).toBeCloseTo(1, 6);
  });

  it('ignores zero-length slices, which occupy no wall-clock', () => {
    const out = measureFanOut([slice(T0, T0), slice(T0, T0 + HOUR_MS)]);
    expect(out.agentHours).toBeCloseTo(1, 6);
    expect(out.maxConcurrency).toBe(1);
  });
});

describe('prices', () => {
  it('resolves a dated snapshot id to its base model', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(priceFor('claude-haiku-4-5'));
    expect(priceFor('gpt-6-astra')).toBeNull();
  });

  it('prices the two cache-write tiers apart', () => {
    const price = { input: 2, output: 10 };
    const fiveMin = priceMix(mix({ cacheWrite5m: 1_000_000 }), price);
    const oneHour = priceMix(mix({ cacheWrite1h: 1_000_000 }), price);
    expect(fiveMin).toBeCloseTo(2 * CACHE_WRITE_5M_RATIO, 6);
    expect(oneHour).toBeCloseTo(2 * CACHE_WRITE_1H_RATIO, 6);
    // The regression this pins: billing 1-hour writes at the 5-minute rate.
    expect(oneHour).toBeGreaterThan(fiveMin);
  });

  it('prices a cache read at a tenth of uncached input', () => {
    const price = { input: 2, output: 10 };
    expect(priceMix(mix({ cacheRead: 1_000_000 }), price)).toBeCloseTo(0.2, 6);
    expect(priceMix(mix({ input: 1_000_000 }), price)).toBeCloseTo(2, 6);
  });
});
