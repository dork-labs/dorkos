import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { LatencyHistogram } from './histogram.js';
import {
  startReaderShare,
  type FromReaderShare,
  type ReaderShareInput,
  type ToReaderShare,
} from './reader-share.js';
import type { ReaderOutcome } from './sse.js';

/** Streams opened per batch across ALL reader shares, so thousands never open in one tick. */
const READER_BATCH_SIZE = 250;
/** How long each share waits after one batch before the next. */
const READER_BATCH_SETTLE_MS = 100;

/** Every reader share's results, merged. */
export interface ReaderResults {
  outcomes: ReaderOutcome[];
  deliveries: LatencyHistogram;
  /** The worst p99 event-loop delay any reader share saw while posts went out. */
  loopDelayP99Ms: number;
}

/** A run's readers, from opening their streams to handing back what they measured. */
export interface ReaderPool {
  /** Settles once every stream has opened or failed to, with the totals. */
  settled: Promise<{ opened: number; failed: number }>;
  /** Tell every share posting has begun. */
  startPosting(): void;
  /** Close every stream and collect the results. */
  stop(): Promise<ReaderResults>;
}

/** One share, wherever it runs: a worker thread, or this thread. */
interface Share {
  events: EventEmitter;
  post(message: ToReaderShare): void;
  terminate(): Promise<unknown>;
}

function workerShare(input: ReaderShareInput): Share {
  // The script runs as TypeScript under tsx, whose loader a worker thread does not inherit, so
  // the thread loads its entry through tsx's own API: `./x.js` imports then find `x.ts`.
  const entry = new URL('./reader-worker.ts', import.meta.url).href;
  const tsxApi = import.meta.resolve('tsx/esm/api');
  const worker = new Worker(
    `import(${JSON.stringify(tsxApi)}).then(({ tsImport }) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(entry)}));`,
    { eval: true, workerData: input }
  );
  return {
    events: worker,
    post: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
  };
}

function inlineShare(input: ReaderShareInput): Share {
  const events = new EventEmitter();
  const handle = startReaderShare(input, (message) => events.emit('message', message));
  return { events, post: handle, terminate: async () => undefined };
}

/**
 * Spread `tokens` over `threads` worker threads, each opening and reading its share of the streams
 * on its own event loop. `threads: 0` reads every stream on this thread instead, for small runs
 * and tests.
 */
export function startReaders(input: {
  baseUrl: string;
  communityId: string;
  channelId: string;
  tokens: readonly string[];
  runId: string;
  postCapacity: number;
  threads: number;
}): ReaderPool {
  const inline = input.threads === 0;
  const count = Math.max(1, Math.min(input.threads, input.tokens.length || 1));
  const slices: string[][] = Array.from({ length: count }, () => []);
  input.tokens.forEach((token, i) => slices[i % count].push(token));
  const batchSize = Math.max(1, Math.ceil(READER_BATCH_SIZE / count));

  const shares = slices.map((tokens) =>
    (inline ? inlineShare : workerShare)({
      baseUrl: input.baseUrl,
      communityId: input.communityId,
      channelId: input.channelId,
      tokens,
      runId: input.runId,
      postCapacity: input.postCapacity,
      batchSize,
      batchSettleMs: READER_BATCH_SETTLE_MS,
    })
  );
  const next = <T extends FromReaderShare['type']>(share: Share, type: T) =>
    new Promise<Extract<FromReaderShare, { type: T }>>((resolve, reject) => {
      const onMessage = (message: FromReaderShare) => {
        if (message.type !== type) return;
        share.events.off('message', onMessage);
        share.events.off('error', reject);
        resolve(message as Extract<FromReaderShare, { type: T }>);
      };
      share.events.on('message', onMessage);
      share.events.once('error', reject);
    });
  // Listen for both messages from the start, so neither can arrive before anyone listens.
  const opened = shares.map((share) => next(share, 'opened'));
  const done = shares.map((share) => next(share, 'done'));
  // A share that crashed rejects both; `settled` and `stop` each report it to their caller.
  for (const promise of [...opened, ...done]) promise.catch(() => undefined);

  return {
    settled: Promise.all(opened).then((messages) =>
      messages.reduce(
        (sum, m) => ({ opened: sum.opened + m.opened, failed: sum.failed + m.failed }),
        { opened: 0, failed: 0 }
      )
    ),
    startPosting() {
      for (const share of shares) share.post({ type: 'posting' });
    },
    async stop() {
      for (const share of shares) share.post({ type: 'stop' });
      try {
        const results: ReaderResults = {
          outcomes: [],
          deliveries: new LatencyHistogram(),
          loopDelayP99Ms: 0,
        };
        for (const message of await Promise.all(done)) {
          results.outcomes.push(...message.outcomes);
          results.deliveries.merge(message.deliveries);
          results.loopDelayP99Ms = Math.max(results.loopDelayP99Ms, message.loopDelayP99Ms);
        }
        return results;
      } finally {
        await Promise.all(shares.map((share) => share.terminate()));
      }
    },
  };
}
