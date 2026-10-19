import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LatencyHistogram, type HistogramData } from './histogram.js';
import { openReaderStream, type ReaderOutcome } from './sse.js';

/** How often a share reports how many deliveries it has seen. */
const PROGRESS_MS = 1_000;

/** What one share of the run's readers is started with. */
export interface ReaderShareInput {
  baseUrl: string;
  communityId: string;
  channelId: string;
  tokens: string[];
  runId: string;
  postCapacity: number;
  batchSize: number;
  batchSettleMs: number;
}

/** Main thread to a reader share. */
export type ToReaderShare = { type: 'posting' } | { type: 'stop' };

/** A reader share to the main thread. */
export type FromReaderShare =
  | { type: 'opened'; opened: number; failed: number }
  /** How many (stream, post) deliveries this share has seen so far; sent about once a second. */
  | { type: 'progress'; received: number }
  | {
      type: 'done';
      outcomes: ReaderOutcome[];
      deliveries: HistogramData;
      loopDelayP99Ms: number;
    };

/**
 * One share of a run's readers: opens its streams in batches, sends `opened` once every one has
 * opened or failed to, and reads them until told to stop, then sends `done` with what it measured.
 * Runs in a worker thread (`reader-worker.ts`) or, for one share, on the calling thread. Messages
 * are plain data either way, so both paths behave the same.
 */
export function startReaderShare(
  input: ReaderShareInput,
  send: (message: FromReaderShare) => void
): (message: ToReaderShare) => void {
  const deliveries = new LatencyHistogram();
  const abortController = new AbortController();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  let pending = input.tokens.length;
  let opened = 0;
  const settled = (ok: boolean) => {
    if (ok) opened += 1;
    pending -= 1;
    if (pending === 0) send({ type: 'opened', opened, failed: input.tokens.length - opened });
  };
  if (pending === 0) queueMicrotask(() => send({ type: 'opened', opened: 0, failed: 0 }));

  let received = 0;
  let reported = 0;
  const progress = setInterval(() => {
    if (received === reported) return;
    reported = received;
    send({ type: 'progress', received });
  }, PROGRESS_MS);

  const results: Promise<ReaderOutcome>[] = [];
  void (async () => {
    for (let i = 0; i < input.tokens.length; i += input.batchSize) {
      if (abortController.signal.aborted) return;
      for (const token of input.tokens.slice(i, i + input.batchSize)) {
        results.push(
          openReaderStream({
            baseUrl: input.baseUrl,
            communityId: input.communityId,
            channelId: input.channelId,
            token,
            runId: input.runId,
            postCapacity: input.postCapacity,
            signal: abortController.signal,
            deliveries,
            onSettled: settled,
            onReceived: () => {
              received += 1;
            },
          })
        );
      }
      await new Promise((resolve) => setTimeout(resolve, input.batchSettleMs));
    }
  })();

  return (message) => {
    if (message.type === 'posting') {
      // Only the posting window matters for whether this share kept up.
      loopDelay.reset();
      return;
    }
    if (abortController.signal.aborted) return;
    // Read before closing every stream, so the teardown is not mistaken for saturation.
    const loopDelayP99Ms = loopDelay.percentile(99) / 1e6;
    loopDelay.disable();
    clearInterval(progress);
    abortController.abort();
    void Promise.all(results).then((outcomes) => {
      // Stopped before this share asked for every stream: the rest never opened.
      while (outcomes.length < input.tokens.length)
        outcomes.push({
          opened: false,
          endedEarly: false,
          error: 'not asked for before the run ended',
          received: 0,
        });
      send({
        type: 'done',
        outcomes,
        deliveries: deliveries.toData(),
        loopDelayP99Ms,
      });
    });
  };
}
