/** Each bucket's upper bound is this much larger than the one before: 5% resolution. */
const GROWTH = 1.05;
const LOG_GROWTH = Math.log(GROWTH);
/** Bucket 0 holds everything at or under 1 ms; the last holds everything past ~2 minutes. */
const BUCKETS = Math.ceil(Math.log(120_000) / LOG_GROWTH) + 2;

/** Upper bound, in milliseconds, of bucket `i`. */
function upperBound(i: number): number {
  return i >= BUCKETS - 1 ? Infinity : GROWTH ** i;
}

/**
 * A log-bucketed latency histogram.
 *
 * A load run records one sample per post per open stream: at 20,000 streams and 3,000 posts that
 * is sixty million samples, far too many to keep and sort. Buckets grow by 5%, so a percentile is
 * an estimate within 5% of the true value, at constant memory and constant time per sample.
 */
export class LatencyHistogram {
  private readonly counts = new Float64Array(BUCKETS);
  private total = 0;
  private sumMs = 0;
  private minMs = Infinity;
  private maxMs = -Infinity;

  /** Record one latency sample, in milliseconds. A negative one is recorded as 0. */
  record(rawMs: number): void {
    const ms = Math.max(0, rawMs);
    this.total += 1;
    this.sumMs += ms;
    if (ms < this.minMs) this.minMs = ms;
    if (ms > this.maxMs) this.maxMs = ms;
    const index = ms <= 1 ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms) / LOG_GROWTH));
    this.counts[index] += 1;
  }

  /** How many samples this histogram has recorded. */
  get count(): number {
    return this.total;
  }

  /**
   * Estimate the `p`th percentile (0-100): find the bucket holding that rank and interpolate
   * across it, clamped to the smallest and largest sample actually seen. `null` when empty.
   */
  percentile(p: number): number | null {
    if (this.total === 0) return null;
    const rank = (p / 100) * this.total;
    let seen = 0;
    for (let i = 0; i < BUCKETS; i += 1) {
      const inBucket = this.counts[i];
      if (inBucket > 0 && seen + inBucket >= rank) {
        const lower = i === 0 ? 0 : upperBound(i - 1);
        const upper = Math.min(upperBound(i), this.maxMs);
        const estimate = lower + ((rank - seen) / inBucket) * (upper - lower);
        return Math.min(this.maxMs, Math.max(this.minMs, estimate));
      }
      seen += inBucket;
    }
    return this.maxMs;
  }

  /** A plain summary ready to print or serialize. */
  summary(): {
    count: number;
    meanMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    minMs: number | null;
    maxMs: number | null;
  } {
    const empty = this.total === 0;
    return {
      count: this.total,
      meanMs: empty ? null : this.sumMs / this.total,
      p50Ms: this.percentile(50),
      p95Ms: this.percentile(95),
      p99Ms: this.percentile(99),
      minMs: empty ? null : this.minMs,
      maxMs: empty ? null : this.maxMs,
    };
  }
}
