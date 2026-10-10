import { performance } from 'node:perf_hooks';
import type { LoadPrincipal } from './fixture.js';
import { LatencyHistogram } from './histogram.js';
import type { TimedPost } from './sse.js';

/** A post that has not answered in this long counts as a network error, so a run always ends. */
const POST_TIMEOUT_MS = 30_000;

/** What the writer loop measured, once its posting window closed. */
export interface WriterStats {
  attempted: number;
  succeeded: number;
  /** How many posts got each non-2xx status, keyed by status code. */
  failedByStatus: Map<number, number>;
  /** How many posts errored below HTTP (a dropped connection, a timeout). */
  networkErrors: number;
  /** Round-trip latency of the POST itself (not delivery: see `deliveries` in the report). */
  postAck: LatencyHistogram;
  /**
   * How late each post went out against its schedule. Anything beyond a few milliseconds means
   * the load generator itself, not the server, was the bottleneck.
   */
  sendLag: LatencyHistogram;
}

/** How many posts a run of `ratePerSecond` for `durationMs` schedules. */
export function scheduledPostCount(ratePerSecond: number, durationMs: number): number {
  return ratePerSecond === 0 ? 0 : Math.ceil((durationMs * ratePerSecond) / 1_000);
}

/**
 * Post at a steady `ratePerSecond` across all `writers` combined, round-robin, for `durationMs`.
 * The loop is open: each post is sent on its schedule whether or not earlier posts answered, so
 * a slow server cannot slow the offered load down and hide its own latency. Each post's text is
 * a {@link TimedPost} carrying its SCHEDULED send time, which readers subtract from the moment
 * the post reaches them.
 */
export async function runWriters(input: {
  baseUrl: string;
  communityId: string;
  channelId: string;
  writers: readonly LoadPrincipal[];
  ratePerSecond: number;
  durationMs: number;
  runId: string;
}): Promise<WriterStats> {
  const stats: WriterStats = {
    attempted: 0,
    succeeded: 0,
    failedByStatus: new Map(),
    networkErrors: 0,
    postAck: new LatencyHistogram(),
    sendLag: new LatencyHistogram(),
  };
  const total = scheduledPostCount(input.ratePerSecond, input.durationMs);
  if (input.writers.length === 0 || total === 0) return stats;

  const entriesUrl = `${input.baseUrl}/api/v1/communities/${input.communityId}/channels/${input.channelId}/entries`;
  const intervalMs = 1_000 / input.ratePerSecond;
  const start = performance.now();
  const inFlight: Promise<void>[] = [];

  const post = async (writer: LoadPrincipal, n: number, scheduledAt: number): Promise<void> => {
    stats.attempted += 1;
    const sentAt = performance.now();
    stats.sendLag.record(sentAt - scheduledAt);
    const marker: TimedPost = { r: input.runId, n, t: scheduledAt };
    try {
      const response = await fetch(entriesUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writer.token}` },
        body: JSON.stringify({
          text: JSON.stringify(marker),
          idempotencyKey: `load-${input.runId}-${n}`,
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      // Measured from the schedule too, for the same reason delivery is.
      stats.postAck.record(performance.now() - scheduledAt);
      if (response.ok) stats.succeeded += 1;
      else
        stats.failedByStatus.set(
          response.status,
          (stats.failedByStatus.get(response.status) ?? 0) + 1
        );
    } catch {
      stats.networkErrors += 1;
    }
  };

  for (let n = 0; n < total; n += 1) {
    const scheduledAt = start + n * intervalMs;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    inFlight.push(post(input.writers[n % input.writers.length], n, scheduledAt));
  }
  await Promise.all(inFlight);
  return stats;
}
