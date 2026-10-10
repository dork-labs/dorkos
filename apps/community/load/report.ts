import { writeFileSync } from 'node:fs';
import { LatencyHistogram } from './histogram.js';
import type { MetricsSnapshot } from './metrics.js';
import type { ReaderOutcome } from './sse.js';
import type { WriterStats } from './writer.js';

/** D12's bar: delivery p95 under one second, and no errors. */
const DELIVERY_P95_TARGET_MS = 1_000;
/**
 * Above this p99 event-loop delay the load generator was too busy to read its streams on time,
 * so its latency figures say as much about this process as about the server.
 */
const GENERATOR_LOOP_DELAY_WARN_MS = 100;

/** The highest figures `/metrics` showed while posts went out. */
export interface PeakFigures {
  openStreams: number;
  poolWaiting: number;
  samples: number;
  sampleErrors: number;
}

type HistogramSummary = ReturnType<LatencyHistogram['summary']>;

/** Everything one load run measured, shaped for both the console and the JSON file. */
export interface LoadReport {
  startedAt: string;
  finishedAt: string;
  target: { url: string; communityId: string; channelId: string };
  requested: { readers: number; writers: number; ratePerSecond: number; durationSeconds: number };
  readerThreads: number;
  readers: {
    opened: number;
    openFailed: number;
    openFailedBy: Record<string, number>;
    openMs: HistogramSummary;
    /** Streams that opened only after posting started: never part of the load being measured. */
    openedLate: number;
    /** Streams that closed or errored before the run ended them: drops. */
    endedEarly: number;
    closeReasons: Record<string, number>;
    /**
     * Posts that succeeded but never reached a stream that was open before the first post and
     * stayed open the whole run, summed over those streams. Above zero is a lost delivery.
     */
    missedDeliveries: number;
  };
  writers: {
    attempted: number;
    succeeded: number;
    failedByStatus: Record<string, number>;
    networkErrors: number;
    postAckMs: HistogramSummary;
    sendLagMs: HistogramSummary;
  };
  delivery: HistogramSummary;
  peak: PeakFigures;
  /** Counter movement between the scrape before streams opened and the one after posting. */
  refusedDuringRun: { host: number; community: number; member: number };
  listenerReconnectsDuringRun: number;
  generatorLoopDelayP99Ms: number;
  /** The generator's own event loop lagged enough to distort its numbers. */
  generatorSaturated: boolean;
  metrics: { before: MetricsSnapshot; after: MetricsSnapshot };
  /**
   * `met`: delivery p95 under a second and no errors of any kind. `not met`: the server missed.
   * `inconclusive`: it missed while the load machine itself was saturated, so the miss may be the
   * load machine's. A pass while saturated still stands: saturation only adds latency.
   */
  verdict: 'met' | 'not met' | 'inconclusive';
}

/** Fold every reader's outcome into the counts the report shows. */
export function summarizeReaders(
  outcomes: readonly ReaderOutcome[],
  succeededPosts: number,
  postingStartedAt: number
): LoadReport['readers'] {
  const closeReasons: Record<string, number> = {};
  const openFailedBy: Record<string, number> = {};
  const openMs = new LatencyHistogram();
  let opened = 0;
  let openedLate = 0;
  let endedEarly = 0;
  let missedDeliveries = 0;
  for (const outcome of outcomes) {
    if (outcome.opened) {
      opened += 1;
      if (outcome.openMs !== undefined) openMs.record(outcome.openMs);
    } else {
      const key = outcome.status ? `HTTP ${outcome.status}` : (outcome.error ?? 'unknown');
      openFailedBy[key] = (openFailedBy[key] ?? 0) + 1;
    }
    const late = outcome.opened && (outcome.openedAt ?? 0) > postingStartedAt;
    if (late) openedLate += 1;
    if (outcome.endedEarly) {
      endedEarly += 1;
      const reason = outcome.closeReason ?? outcome.error ?? 'ended without a reason';
      closeReasons[reason] = (closeReasons[reason] ?? 0) + 1;
    } else if (outcome.opened && !late) {
      missedDeliveries += Math.max(0, succeededPosts - outcome.received);
    }
  }
  return {
    opened,
    openFailed: outcomes.length - opened,
    openFailedBy,
    openMs: openMs.summary(),
    openedLate,
    endedEarly,
    closeReasons,
    missedDeliveries,
  };
}

/** D12's verdict on one run's figures. See {@link LoadReport.verdict}. */
export function verdictFor(input: {
  delivery: HistogramSummary;
  writerStats: Pick<WriterStats, 'attempted' | 'succeeded'>;
  readers: Pick<
    LoadReport['readers'],
    'openFailed' | 'openedLate' | 'endedEarly' | 'missedDeliveries'
  >;
  generatorSaturated: boolean;
}): LoadReport['verdict'] {
  const { delivery, writerStats, readers } = input;
  const met =
    delivery.p95Ms !== null &&
    delivery.p95Ms < DELIVERY_P95_TARGET_MS &&
    writerStats.attempted > 0 &&
    writerStats.succeeded === writerStats.attempted &&
    readers.openFailed === 0 &&
    readers.openedLate === 0 &&
    readers.endedEarly === 0 &&
    readers.missedDeliveries === 0;
  if (met) return 'met';
  return input.generatorSaturated ? 'inconclusive' : 'not met';
}

const delta = (after: number | null, before: number | null) => (after ?? 0) - (before ?? 0);

/** Build the full report, decide whether D12's bar was met, and print + write it. */
export function finishReport(input: {
  startedAt: Date;
  url: string;
  communityId: string;
  channelId: string;
  requested: LoadReport['requested'];
  readerThreads: number;
  postingStartedAt: number;
  readerOutcomes: readonly ReaderOutcome[];
  writerStats: WriterStats;
  deliveries: LatencyHistogram;
  metricsBefore: MetricsSnapshot;
  metricsAfter: MetricsSnapshot;
  peak: PeakFigures;
  generatorLoopDelayP99Ms: number;
  out: string;
}): LoadReport {
  const { writerStats, metricsBefore: before, metricsAfter: after } = input;
  const readers = summarizeReaders(
    input.readerOutcomes,
    writerStats.succeeded,
    input.postingStartedAt
  );
  const delivery = input.deliveries.summary();
  const failedByStatus = Object.fromEntries(
    [...writerStats.failedByStatus.entries()].map(([status, n]) => [String(status), n])
  );
  const refusedDuringRun = {
    host: delta(after.refusedHost, before.refusedHost),
    community: delta(after.refusedCommunity, before.refusedCommunity),
    member: delta(after.refusedMember, before.refusedMember),
  };
  const generatorSaturated = input.generatorLoopDelayP99Ms > GENERATOR_LOOP_DELAY_WARN_MS;
  const report: LoadReport = {
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target: { url: input.url, communityId: input.communityId, channelId: input.channelId },
    requested: input.requested,
    readerThreads: input.readerThreads,
    readers,
    writers: {
      attempted: writerStats.attempted,
      succeeded: writerStats.succeeded,
      failedByStatus,
      networkErrors: writerStats.networkErrors,
      postAckMs: writerStats.postAck.summary(),
      sendLagMs: writerStats.sendLag.summary(),
    },
    delivery,
    peak: input.peak,
    refusedDuringRun,
    listenerReconnectsDuringRun: delta(after.listenerReconnects, before.listenerReconnects),
    generatorLoopDelayP99Ms: input.generatorLoopDelayP99Ms,
    generatorSaturated,
    metrics: { before, after },
    verdict: verdictFor({ delivery, writerStats, readers, generatorSaturated }),
  };
  printReport(report);
  writeFileSync(input.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nFull results written to ${input.out}\n`);
  return report;
}

function printReport(report: LoadReport): void {
  const { readers, writers, delivery } = report;
  const line = (label: string, value: string) => console.log(`${label.padEnd(32)}: ${value}`);
  const pcts = (s: HistogramSummary) =>
    `p50 ${fmt(s.p50Ms)}  p95 ${fmt(s.p95Ms)}  p99 ${fmt(s.p99Ms)}  max ${fmt(s.maxMs)}`;
  console.log('\n=== Community load test ===');
  line('Target', report.target.url);
  line('Community / channel', `${report.target.communityId} / ${report.target.channelId}`);
  line(
    'Requested',
    `${report.requested.readers} readers, ${report.requested.writers} writers, ` +
      `${report.requested.ratePerSecond} posts/s for ${report.requested.durationSeconds}s`
  );
  line(
    'Reader streams opened',
    `${readers.opened} on ${report.readerThreads ? `${report.readerThreads} thread(s)` : 'the main thread'} (${readers.openFailed} failed, ` +
      `${readers.openedLate} opened after posting began)`
  );
  if (readers.openFailed) line('  failed by', JSON.stringify(readers.openFailedBy));
  line('Stream open time', pcts(readers.openMs));
  line('Peak open streams (server)', String(report.peak.openStreams));
  line('Stream drops', String(readers.endedEarly));
  if (readers.endedEarly) line('  by reason', JSON.stringify(readers.closeReasons));
  line(
    'Stream refusals during run',
    `host ${report.refusedDuringRun.host}, community ${report.refusedDuringRun.community}, ` +
      `member ${report.refusedDuringRun.member}`
  );
  line(
    'Posts',
    `${writers.attempted} attempted, ${writers.succeeded} succeeded, ` +
      `${writers.networkErrors} network errors`
  );
  if (Object.keys(writers.failedByStatus).length)
    line('  failed by status', JSON.stringify(writers.failedByStatus));
  line('Post answered (from schedule)', pcts(writers.postAckMs));
  line('Delivery (from schedule)', `${pcts(delivery)}  (${delivery.count} deliveries)`);
  line('Missed deliveries', String(readers.missedDeliveries));
  line('Peak pool waiting (server)', String(report.peak.poolWaiting));
  line('Listener reconnects', String(report.listenerReconnectsDuringRun));
  line(
    'Generator loop delay p99',
    `${fmt(report.generatorLoopDelayP99Ms)}${report.generatorSaturated ? '  (SATURATED: figures include generator lag)' : ''}`
  );
  line('Generator send lag', pcts(writers.sendLagMs));
  line('D12 (p95 < 1s, no errors)', report.verdict.toUpperCase());
}

function fmt(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms.toFixed(0)}ms`;
}
