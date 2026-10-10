#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseLoadArgs, UsageError } from './args.js';
import { seedLoadFixture } from './fixture.js';
import { LatencyHistogram } from './histogram.js';
import { fetchMetrics, type MetricsSnapshot } from './metrics.js';
import { finishReport, type PeakFigures } from './report.js';
import { openReaderStream, type ReaderOutcome } from './sse.js';
import { runWriters, scheduledPostCount } from './writer.js';

/** Readers open this many streams at a time, so a run of thousands does not try every socket
 *  in the same event-loop tick. */
const READER_BATCH_SIZE = 250;
/** How long a batch waits for its opens to settle before the next one starts. */
const READER_BATCH_SETTLE_MS = 100;
/** How long after the last batch opens before writers start posting. */
const READER_WARMUP_MS = 2_000;
/** How often `/metrics` is read while posts are going out, to catch the peak. */
const METRICS_SAMPLE_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // `pnpm load -- --url …` forwards the `--` itself; parseArgs would read every flag after it as
  // a positional and refuse them all.
  const argv = process.argv.slice(2);
  const args = parseLoadArgs(argv[0] === '--' ? argv.slice(1) : argv);
  for (const warning of args.warnings) console.warn(`Warning: ${warning}`);
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  console.log(
    `Seeding a throwaway community at ${args.url}: ${args.readers} readers, ${args.writers} writers...`
  );
  const fixture = await seedLoadFixture(args.url, {
    communityName: args.communityName,
    channelName: args.channelName,
    readerCount: args.readers,
    writerCount: args.writers,
  });
  console.log(`Seeded community ${fixture.communityId}, channel ${fixture.channelId}.`);

  const metricsBefore: MetricsSnapshot = await fetchMetrics(args.url, fixture.metricsKey);
  const durationMs = args.durationSeconds * 1_000;
  const postCapacity = scheduledPostCount(args.ratePerSecond, durationMs);

  const deliveries = new LatencyHistogram();
  const abortController = new AbortController();
  const readerResults: Promise<ReaderOutcome>[] = [];

  console.log(
    `Opening ${fixture.readers.length} reader streams in batches of ${READER_BATCH_SIZE}...`
  );
  for (let i = 0; i < fixture.readers.length; i += READER_BATCH_SIZE) {
    for (const reader of fixture.readers.slice(i, i + READER_BATCH_SIZE)) {
      readerResults.push(
        openReaderStream({
          baseUrl: args.url,
          communityId: fixture.communityId,
          channelId: fixture.channelId,
          token: reader.token,
          runId,
          postCapacity,
          signal: abortController.signal,
          deliveries,
        })
      );
    }
    await sleep(READER_BATCH_SETTLE_MS);
  }
  if (fixture.readers.length) {
    console.log(
      `Reader streams requested. Warming up ${READER_WARMUP_MS}ms before writers start...`
    );
    await sleep(READER_WARMUP_MS);
  }

  const peak: PeakFigures = { openStreams: 0, poolWaiting: 0, samples: 0, sampleErrors: 0 };
  const takeSample = async () => {
    try {
      const snapshot = await fetchMetrics(args.url, fixture.metricsKey);
      peak.samples += 1;
      peak.openStreams = Math.max(peak.openStreams, snapshot.openStreams ?? 0);
      peak.poolWaiting = Math.max(peak.poolWaiting, snapshot.poolWaiting ?? 0);
    } catch {
      peak.sampleErrors += 1;
    }
  };
  await takeSample();
  // Only the posting window matters for whether the generator kept up.
  loopDelay.reset();
  const sampler = setInterval(() => void takeSample(), METRICS_SAMPLE_MS);

  console.log(
    `Posting ${postCapacity} times at ${args.ratePerSecond}/s across ${fixture.writers.length} writers for ${args.durationSeconds}s...`
  );
  let writerStats;
  let metricsAfter: MetricsSnapshot;
  try {
    writerStats = await runWriters({
      baseUrl: args.url,
      communityId: fixture.communityId,
      channelId: fixture.channelId,
      writers: fixture.writers,
      ratePerSecond: args.ratePerSecond,
      durationMs,
      runId,
    });
    console.log(`Posting done. Waiting ${args.graceMs}ms for in-flight deliveries to land...`);
    await sleep(args.graceMs);
    await takeSample();
    metricsAfter = await fetchMetrics(args.url, fixture.metricsKey);
  } finally {
    clearInterval(sampler);
    // Every path out of here closes every stream, or a failed run would hold them open forever.
    abortController.abort();
  }
  const readerOutcomes = await Promise.all(readerResults);
  loopDelay.disable();

  const report = finishReport({
    startedAt,
    url: args.url,
    communityId: fixture.communityId,
    channelId: fixture.channelId,
    requested: {
      readers: args.readers,
      writers: args.writers,
      ratePerSecond: args.ratePerSecond,
      durationSeconds: args.durationSeconds,
    },
    readerOutcomes,
    writerStats,
    deliveries,
    metricsBefore,
    metricsAfter,
    peak,
    generatorLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    out: args.out,
  });
  if (!report.metD12Target) process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    (error.isHelp ? console.log : console.error)(error.message);
    process.exitCode = error.isHelp ? 0 : 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
