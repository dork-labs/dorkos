#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseLoadArgs, UsageError } from './args.js';
import { seedLoadFixture } from './fixture.js';
import { fetchMetrics, type MetricsSnapshot } from './metrics.js';
import { finishReport, type PeakFigures } from './report.js';
import { startReaders, type ReaderResults } from './readers.js';
import { loadClock } from './sse.js';
import { runWriters, scheduledPostCount, type WriterStats } from './writer.js';

/** How long after every stream opened before writers start posting. */
const READER_WARMUP_MS = 2_000;
/** How often `/metrics` is read while posts are going out, to catch the peak. */
const METRICS_SAMPLE_MS = 5_000;
/** Streams one reader thread is given by default. */
const READERS_PER_THREAD = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `auto`: one thread per 1,000 readers, leaving a core for the writers. */
function readerThreadCount(requested: number | 'auto', readers: number): number {
  if (requested !== 'auto') return requested;
  const cores = Math.max(1, availableParallelism() - 1);
  return Math.max(1, Math.min(cores, Math.ceil(readers / READERS_PER_THREAD)));
}

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
  const threads = readerThreadCount(args.readerThreads, fixture.readers.length);
  if (fixture.readers.length / Math.max(1, threads) > 2 * READERS_PER_THREAD)
    console.warn(
      `Warning: ${fixture.readers.length} streams on ${threads || 1} thread(s) is more than ` +
        `${2 * READERS_PER_THREAD} per thread; the load machine may saturate. Use one with more cores.`
    );

  console.log(
    `Opening ${fixture.readers.length} reader streams on ${threads ? `${threads} thread(s)` : 'the main thread'}...`
  );
  const readers = startReaders({
    baseUrl: args.url,
    communityId: fixture.communityId,
    channelId: fixture.channelId,
    tokens: fixture.readers.map((reader) => reader.token),
    runId,
    postCapacity,
    threads,
  });

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

  let sampler: NodeJS.Timeout | undefined;
  let postingStartedAt!: number;
  let writerStats!: WriterStats;
  let metricsAfter!: MetricsSnapshot;
  let readerResults!: ReaderResults;
  let mainLoopDelayP99Ms!: number;
  try {
    // Every stream must be open before the first post, or the run never holds the number of
    // streams it claims while posting, and late streams fake lost messages.
    let openTimer: NodeJS.Timeout | undefined;
    const openWait = await Promise.race([
      readers.settled,
      new Promise<null>((resolve) => {
        openTimer = setTimeout(() => resolve(null), args.openTimeoutSeconds * 1_000);
      }),
    ]).finally(() => clearTimeout(openTimer));
    if (openWait) console.log(`Streams open: ${openWait.opened} (${openWait.failed} failed).`);
    else
      console.warn(
        `Not every stream opened within ${args.openTimeoutSeconds}s; posting anyway. ` +
          'Streams that open later count as failures.'
      );
    await sleep(READER_WARMUP_MS);
    await takeSample();

    console.log(
      `Posting ${postCapacity} times at ${args.ratePerSecond}/s across ${fixture.writers.length} writers for ${args.durationSeconds}s...`
    );
    // Only the posting window matters for whether the generator kept up.
    loopDelay.reset();
    readers.startPosting();
    sampler = setInterval(() => void takeSample(), METRICS_SAMPLE_MS);
    postingStartedAt = loadClock();
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
    // Read before closing the streams, so the teardown is not mistaken for saturation.
    mainLoopDelayP99Ms = loopDelay.percentile(99) / 1e6;
    loopDelay.disable();
    // Every path out of here closes every stream, or a failed run would hold them open forever.
    readerResults = await readers.stop();
  }

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
    readerThreads: threads,
    postingStartedAt,
    readerOutcomes: readerResults.outcomes,
    writerStats,
    deliveries: readerResults.deliveries,
    metricsBefore,
    metricsAfter,
    peak,
    generatorLoopDelayP99Ms: Math.max(mainLoopDelayP99Ms, readerResults.loopDelayP99Ms),
    out: args.out,
  });
  // 0 met, 2 not met, 3 inconclusive (the load machine could not keep up); 1 is a setup error.
  process.exitCode = { met: 0, 'not met': 2, inconclusive: 3 }[report.verdict];
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
