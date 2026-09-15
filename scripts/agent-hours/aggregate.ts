/**
 * Turn per-turn usage into per-active-hour rates.
 *
 * The three steps are: give each turn the slice of wall-clock it occupied
 * (`toSlices`), pool those slices into session-hour buckets (`toBuckets`), and
 * reduce buckets to a mean and a spread (`summarize`). `measureFanOut` answers
 * the separate question of how many agents were running at once.
 *
 * @module scripts/agent-hours/aggregate
 */
import {
  addMix,
  emptyMix,
  mixTotal,
  priceFor,
  priceMix,
  type ModelPrice,
  type TokenMix,
} from './prices.js';
import type { Runtime, Turn } from './readers.js';

export const HOUR_MS = 3_600_000;

/**
 * What a turn costs at list price.
 *
 * Falls back to a cost the runtime reported itself when the model has no
 * published rate — OpenCode reports one — and to `null` when neither is
 * available, so an unpriceable turn stays visibly absent instead of silently
 * becoming a zero that drags every average down.
 */
function costOf(turn: Turn): number | null {
  const price = priceFor(turn.model);
  if (!price) return turn.reportedCostUsd;
  return priceMix(turn.mix, price);
}

/** One turn's slice of wall-clock, with the usage that slice accounts for. */
export interface Slice {
  readonly runtime: Runtime;
  readonly sessionKey: string;
  readonly model: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly mix: TokenMix;
  /** Cost at the turn's own model's list price, or `null` when unpriceable. */
  readonly costUsd: number | null;
  /** The same tokens priced at one chosen model, for a like-for-like comparison. */
  readonly repriceUsd: number | null;
}

/**
 * Turn each session's turns into active intervals.
 *
 * A turn's interval runs from the previous turn in the same session up to the
 * turn itself, clamped to `gapMs`: that window covers the model generating and
 * whatever tool call filled the rest of the wait. Anything longer than the clamp
 * is idle — the operator walked away — and is not charged to the agent.
 *
 * **The first turn of a session gets a zero-length slice rather than no slice.**
 * It has no predecessor, so there is no interval to measure; but its tokens were
 * still spent, and dropping the slice entirely would drop them from the
 * numerator too. That matters most for exactly the sessions where it is easiest
 * to miss: a single-turn session would contribute literally nothing, and the
 * first turn of any session carries the initial full-context cache write, which
 * is the most expensive write it will ever make.
 */
export function toSlices(
  turns: readonly Turn[],
  gapMs: number,
  reprice: ModelPrice | null
): Slice[] {
  const bySession = new Map<string, Turn[]>();
  for (const turn of turns) {
    const list = bySession.get(turn.sessionKey);
    if (list) list.push(turn);
    else bySession.set(turn.sessionKey, [turn]);
  }

  const slices: Slice[] = [];
  for (const [sessionKey, list] of bySession) {
    list.sort((a, b) => a.atMs - b.atMs);
    for (let i = 0; i < list.length; i += 1) {
      const turn = list[i];
      if (!turn) continue;
      const previous = i > 0 ? list[i - 1] : undefined;
      const activeMs = previous ? Math.min(Math.max(0, turn.atMs - previous.atMs), gapMs) : 0;
      slices.push({
        runtime: turn.runtime,
        sessionKey,
        model: turn.model,
        startMs: turn.atMs - activeMs,
        endMs: turn.atMs,
        mix: turn.mix,
        costUsd: costOf(turn),
        repriceUsd: reprice ? priceMix(turn.mix, reprice) : null,
      });
    }
  }
  return slices;
}

/** One session's active time inside one UTC clock hour, for one model. */
export interface Bucket {
  activeMs: number;
  mix: TokenMix;
  costUsd: number;
  repriceUsd: number;
  /** False once any slice in the bucket had no price, so dollars are partial. */
  costComplete: boolean;
  /** False once any slice could not be repriced. */
  repriceComplete: boolean;
}

/**
 * The key identifying one bucket.
 *
 * Built with `JSON.stringify` rather than a delimiter join. Two of the four
 * parts — the session key and the model id — come from parsed JSON written by
 * another program, so no byte can be assumed illegal in them; `JSON.stringify`
 * of an array is unambiguous whatever they contain, and it survives being read
 * back with `JSON.parse`.
 */
export function bucketKey(runtime: string, sessionKey: string, model: string, hourStart: number) {
  return JSON.stringify([runtime, sessionKey, model, hourStart]);
}

/** The parts of a bucket key, in the order `bucketKey` wrote them. */
export function parseBucketKey(key: string): [string, string, string, number] {
  return JSON.parse(key) as [string, string, string, number];
}

/**
 * Split slices into `(runtime, session, model, UTC hour)` buckets, apportioning
 * tokens and dollars across hour boundaries in proportion to time.
 *
 * Bucketing is what makes a percentile meaningful: without it there is one
 * number per corpus and nothing to take a spread over. The hour is the natural
 * unit because the question is denominated in hours. A zero-length slice — the
 * first turn of a session — lands wholly in the hour containing it, contributing
 * its tokens and no time.
 */
export function toBuckets(slices: readonly Slice[]): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  const at = (slice: Slice, hourStart: number): Bucket => {
    const key = bucketKey(slice.runtime, slice.sessionKey, slice.model, hourStart);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        activeMs: 0,
        mix: emptyMix(),
        costUsd: 0,
        repriceUsd: 0,
        costComplete: true,
        repriceComplete: true,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const credit = (bucket: Bucket, slice: Slice, share: number, ms: number) => {
    bucket.activeMs += ms;
    addMix(bucket.mix, slice.mix, share);
    if (slice.costUsd === null) bucket.costComplete = false;
    else bucket.costUsd += slice.costUsd * share;
    if (slice.repriceUsd === null) bucket.repriceComplete = false;
    else bucket.repriceUsd += slice.repriceUsd * share;
  };

  for (const slice of slices) {
    const span = slice.endMs - slice.startMs;
    if (span <= 0) {
      credit(at(slice, Math.floor(slice.endMs / HOUR_MS) * HOUR_MS), slice, 1, 0);
      continue;
    }
    let cursor = slice.startMs;
    while (cursor < slice.endMs) {
      const hourStart = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      const chunkEnd = Math.min(slice.endMs, hourStart + HOUR_MS);
      const chunk = chunkEnd - cursor;
      credit(at(slice, hourStart), slice, chunk / span, chunk);
      cursor = chunkEnd;
    }
  }
  return buckets;
}

/** A weighted sample: a rate and the active time that produced it. */
interface Weighted {
  readonly value: number;
  readonly weight: number;
}

/**
 * The weighted percentile of a set of rates.
 *
 * Weighting by active time is what stops a six-minute bucket from carrying the
 * same vote as a full hour. Returns `null` for an empty or zero-weight sample
 * rather than a misleading 0.
 */
export function weightedPercentile(samples: readonly Weighted[], p: number): number | null {
  const usable = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return null;
  const target = total * p;
  let seen = 0;
  for (const sample of sorted) {
    seen += sample.weight;
    if (seen >= target) return sample.value;
  }
  const last = sorted[sorted.length - 1];
  return last ? last.value : null;
}

/** A mean with its spread. */
export interface Rate {
  readonly mean: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

/** A dollar rate, with the hours it was actually computed over. */
export interface DollarRate extends Rate {
  /**
   * Hours whose model had a published price. Always compare this to
   * `activeHours`: when it is smaller, the dollar rate describes a subset of the
   * time and must never be multiplied by the full hour count.
   */
  readonly pricedHours: number;
  readonly totalUsd: number;
}

/** Headline rates for one slice of the corpus. */
export interface Stats {
  /** Buckets that survived the minimum-size filter and so fed the percentiles. */
  readonly buckets: number;
  readonly activeHours: number;
  readonly totalTokens: number;
  /** Share of all tokens by class — cache reads usually dominate heavily. */
  readonly tokenShare: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
  readonly tokensPerHour: Rate;
  /** At each turn's own model's list price. `null` when nothing was priceable. */
  readonly usdPerHour: DollarRate | null;
  /** The same tokens at one chosen model's list price. */
  readonly repricedUsdPerHour: DollarRate | null;
}

/**
 * Reduce a set of buckets to headline rates.
 *
 * Dollar means are divided by *priced* hours, never by all hours. Blending the
 * two quietly halves the rate for any group that mixes a priced runtime with an
 * unpriced one, and the halved number looks entirely reasonable — which is how
 * it would survive review.
 *
 * Means are total-over-total across every bucket; percentiles see only buckets
 * above `minBucketMs`. The two therefore answer slightly different questions,
 * and a group with no bucket above the floor reports a mean with no spread — so
 * `buckets` is part of the result and callers are expected to show it.
 */
export function summarize(buckets: readonly Bucket[], minBucketMs: number): Stats {
  let activeMs = 0;
  const mix = emptyMix();
  let cost = 0;
  let costMs = 0;
  let reprice = 0;
  let repriceMs = 0;
  const tokenSamples: Weighted[] = [];
  const costSamples: Weighted[] = [];
  const repriceSamples: Weighted[] = [];

  for (const bucket of buckets) {
    activeMs += bucket.activeMs;
    addMix(mix, bucket.mix, 1);
    if (bucket.costComplete) {
      cost += bucket.costUsd;
      costMs += bucket.activeMs;
    }
    if (bucket.repriceComplete) {
      reprice += bucket.repriceUsd;
      repriceMs += bucket.activeMs;
    }
    // Below the floor the denominator is too small to carry a rate: a bucket of
    // twelve seconds turns one ordinary turn into a spectacular per-hour number.
    if (bucket.activeMs < minBucketMs) continue;
    const hours = bucket.activeMs / HOUR_MS;
    tokenSamples.push({ value: mixTotal(bucket.mix) / hours, weight: bucket.activeMs });
    if (bucket.costComplete) {
      costSamples.push({ value: bucket.costUsd / hours, weight: bucket.activeMs });
    }
    if (bucket.repriceComplete) {
      repriceSamples.push({ value: bucket.repriceUsd / hours, weight: bucket.activeMs });
    }
  }

  const activeHours = activeMs / HOUR_MS;
  const tokens = mixTotal(mix);
  const share = (part: number) => (tokens > 0 ? part / tokens : 0);
  const dollars = (total: number, ms: number, samples: readonly Weighted[]): DollarRate | null => {
    if (ms <= 0) return null;
    const hours = ms / HOUR_MS;
    return {
      mean: total / hours,
      p50: weightedPercentile(samples, 0.5),
      p95: weightedPercentile(samples, 0.95),
      pricedHours: hours,
      totalUsd: total,
    };
  };

  return {
    buckets: tokenSamples.length,
    activeHours,
    totalTokens: tokens,
    tokenShare: {
      input: share(mix.input),
      output: share(mix.output),
      cacheRead: share(mix.cacheRead),
      cacheWrite5m: share(mix.cacheWrite5m),
      cacheWrite1h: share(mix.cacheWrite1h),
    },
    tokensPerHour: {
      mean: activeHours > 0 ? tokens / activeHours : 0,
      p50: weightedPercentile(tokenSamples, 0.5),
      p95: weightedPercentile(tokenSamples, 0.95),
    },
    usdPerHour: dollars(cost, costMs, costSamples),
    repricedUsdPerHour: dollars(reprice, repriceMs, repriceSamples),
  };
}

/** How many agents ran at once, and how much that multiplies wall-clock. */
export interface FanOut {
  readonly agentHours: number;
  readonly wallClockHours: number;
  /** Agent-hours per wall-clock hour: 1 means never more than one agent at a time. */
  readonly fanOut: number;
  readonly p50Concurrency: number | null;
  readonly p95Concurrency: number | null;
  /**
   * The highest concurrency reached at any instant. Unweighted, so a single
   * millisecond of coincidence sets it — the weighted percentiles above are the
   * numbers to plan against.
   */
  readonly maxConcurrency: number;
}

/**
 * Sweep the union of every session's intervals to find how many agents were
 * active at each moment.
 *
 * The concurrency distribution is measured over *busy* time only: idle stretches
 * are not agents running at a concurrency of zero, they are stretches with no
 * agent-hour in them, and averaging them in would report a fan-out below 1 for a
 * machine that never runs fewer than three agents at a time.
 */
export function measureFanOut(slices: readonly Slice[]): FanOut {
  const events: { at: number; delta: number }[] = [];
  let agentMs = 0;
  for (const slice of slices) {
    const span = slice.endMs - slice.startMs;
    if (span <= 0) continue;
    agentMs += span;
    events.push({ at: slice.startMs, delta: 1 }, { at: slice.endMs, delta: -1 });
  }
  // At a tie, closes are applied before opens. Handing over — one agent ending
  // exactly as another starts — must not register as two concurrent agents for
  // an instant of zero length, which is what `maxConcurrency` would otherwise
  // report. No time is attributed either way, since the span is zero.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const timeAtLevel = new Map<number, number>();
  let depth = 0;
  let previous = 0;
  let unionMs = 0;
  let maxDepth = 0;
  for (const event of events) {
    if (depth > 0 && event.at > previous) {
      const span = event.at - previous;
      unionMs += span;
      timeAtLevel.set(depth, (timeAtLevel.get(depth) ?? 0) + span);
    }
    depth += event.delta;
    if (depth > maxDepth) maxDepth = depth;
    previous = event.at;
  }

  const samples = [...timeAtLevel].map(([level, ms]) => ({ value: level, weight: ms }));
  const wallClockHours = unionMs / HOUR_MS;
  const agentHours = agentMs / HOUR_MS;
  return {
    agentHours,
    wallClockHours,
    fanOut: wallClockHours > 0 ? agentHours / wallClockHours : 0,
    p50Concurrency: weightedPercentile(samples, 0.5),
    p95Concurrency: weightedPercentile(samples, 0.95),
    maxConcurrency: maxDepth,
  };
}
