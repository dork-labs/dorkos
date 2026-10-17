/**
 * The server's handle on its one markdown worker (DOR-2984).
 *
 * Every markdown ↔ Yjs conversion goes through here, so none of it runs on the
 * event loop. One worker serves every doc (Blintz builds one model per worker
 * and reuses it); it starts on the first request, stops after a quiet spell so
 * an idle server holds no parser, and starts again when needed.
 *
 * Requests run one at a time, in order, and a request's time limit starts when
 * it reaches the worker, not while it waits behind others. A worker that
 * crashes or hangs fails only the request it was running; the ones still
 * waiting go to a fresh worker, so one doc's bad request never fails another's.
 *
 * @module services/docs/collab/markdown-worker-client
 */
import { Worker } from 'node:worker_threads';
import type {
  MarkdownWorkerFailureCode,
  MarkdownWorkerOp,
  MarkdownWorkerRequest,
  MarkdownWorkerResponse,
  MarkdownWorkerResult,
} from './worker-protocol.js';

/** A request the worker refused or could not finish. */
export class MarkdownWorkerError extends Error {
  /** Why: a base from another copy of the doc, or anything else. */
  readonly code: MarkdownWorkerFailureCode;

  /**
   * A failed worker request.
   *
   * @param code - Why it failed.
   * @param message - What the worker said.
   */
  constructor(code: MarkdownWorkerFailureCode, message: string) {
    super(message);
    this.name = 'MarkdownWorkerError';
    this.code = code;
  }
}

/** How {@link MarkdownWorkerClient} finds and paces its worker. */
export interface MarkdownWorkerClientOptions {
  /** The worker file to start (`resolveMarkdownWorkerEntry`). */
  resolveEntry: () => Promise<string>;
  /** How long one request may take before the worker is replaced. Default 30 s. */
  requestTimeoutMs?: number;
  /** How long the worker may sit unused before it stops. Default 5 minutes. */
  idleMs?: number;
}

/** The result type for one operation. */
type ResultOf<Op extends MarkdownWorkerOp> = Extract<MarkdownWorkerResult, { op: Op }>;

/** A request without its id, which the client assigns. */
type RequestBody = MarkdownWorkerRequest extends infer R
  ? R extends MarkdownWorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

interface Queued {
  id: number;
  request: MarkdownWorkerRequest;
  resolve: (result: MarkdownWorkerResult) => void;
  reject: (error: Error) => void;
}

/** Talks to the markdown worker; see the module doc. */
export class MarkdownWorkerClient {
  readonly #options: Required<MarkdownWorkerClientOptions>;
  #worker: Promise<Worker> | null = null;
  #nextId = 1;
  readonly #queue: Queued[] = [];
  #running: (Queued & { timer: ReturnType<typeof setTimeout>; worker: Worker }) | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  /**
   * A client that starts its worker on first use.
   *
   * @param options - Where the worker is, and how it is paced.
   */
  constructor(options: MarkdownWorkerClientOptions) {
    this.#options = { requestTimeoutMs: 30_000, idleMs: 5 * 60_000, ...options };
  }

  /**
   * Build a fresh document from markdown.
   *
   * @param markdown - The doc's text.
   * @returns The new document's whole state.
   */
  async seed(markdown: string): Promise<Uint8Array> {
    return (await this.#request({ op: 'seed', markdown })).state;
  }

  /**
   * The markdown a document state holds.
   *
   * @param state - A full Yjs state.
   */
  async serialize(state: Uint8Array): Promise<string> {
    return (await this.#request({ op: 'serialize', state })).markdown;
  }

  /**
   * Write markdown into a copy of `state`; see {@link MarkdownWorkerRequest}.
   *
   * @param state - The document as it is now.
   * @param markdown - What the writer wants it to say.
   * @param base - What the writer read, for a three-way merge.
   * @throws MarkdownWorkerError with code `BASE_MISMATCH` for a base from elsewhere.
   */
  async merge(state: Uint8Array, markdown: string, base?: Uint8Array): Promise<ResultOf<'merge'>> {
    return this.#request({ op: 'merge', state, markdown, ...(base ? { base } : {}) });
  }

  /** Stop the worker and refuse every request, running or waiting. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#clearIdle();
    const stopped = new MarkdownWorkerError('FAILED', 'The markdown worker stopped.');
    for (const queued of this.#queue.splice(0)) queued.reject(stopped);
    this.#failRunning(stopped);
    const worker = await this.#worker?.catch(() => null);
    this.#worker = null;
    await worker?.terminate();
  }

  #request<Op extends MarkdownWorkerOp>(
    body: Extract<RequestBody, { op: Op }>
  ): Promise<ResultOf<Op>> {
    if (this.#closed) {
      return Promise.reject(new MarkdownWorkerError('FAILED', 'The markdown worker stopped.'));
    }
    this.#clearIdle();
    const id = this.#nextId++;
    return new Promise<MarkdownWorkerResult>((resolve, reject) => {
      this.#queue.push({ id, request: { ...body, id } as MarkdownWorkerRequest, resolve, reject });
      void this.#pump();
    }) as Promise<ResultOf<Op>>;
  }

  /** Send the next waiting request, when nothing is running. */
  async #pump(): Promise<void> {
    if (this.#running || this.#closed) return;
    const next = this.#queue[0];
    if (!next) {
      this.#armIdle();
      return;
    }
    let worker: Worker;
    try {
      worker = await this.#ensureWorker();
    } catch (error) {
      // No worker file: nothing can run, so every waiting request fails.
      const failure = new MarkdownWorkerError(
        'FAILED',
        error instanceof Error ? error.message : String(error)
      );
      for (const queued of this.#queue.splice(0)) queued.reject(failure);
      return;
    }
    if (this.#running || this.#closed || this.#queue[0] !== next) return;
    this.#queue.shift();
    const timer = setTimeout(() => {
      // A request that hangs takes its worker with it; the rest start fresh.
      this.#replaceWorker(
        worker,
        new MarkdownWorkerError('FAILED', 'The markdown worker took too long.')
      );
    }, this.#options.requestTimeoutMs);
    this.#running = { ...next, timer, worker };
    worker.postMessage(next.request);
  }

  #ensureWorker(): Promise<Worker> {
    if (!this.#worker) {
      const starting = this.#options.resolveEntry().then((entry) => {
        const worker = new Worker(entry);
        // Never what keeps a process alive: a CLI or test that is done must exit.
        worker.unref();
        worker.on('message', (response: MarkdownWorkerResponse) => this.#settle(worker, response));
        worker.on('error', (error) =>
          this.#replaceWorker(worker, new MarkdownWorkerError('FAILED', error.message))
        );
        worker.on('exit', () =>
          this.#replaceWorker(
            worker,
            new MarkdownWorkerError('FAILED', 'The markdown worker exited.')
          )
        );
        return worker;
      });
      this.#worker = starting;
      // A worker file that cannot be found is retried on the next request.
      starting.catch(() => {
        if (this.#worker === starting) this.#worker = null;
      });
    }
    return this.#worker;
  }

  #settle(worker: Worker, response: MarkdownWorkerResponse): void {
    const running = this.#running;
    if (!running || running.worker !== worker || running.id !== response.id) return;
    clearTimeout(running.timer);
    this.#running = null;
    if (response.ok) {
      const { id: _id, ok: _ok, ...result } = response;
      running.resolve(result as MarkdownWorkerResult);
    } else {
      running.reject(new MarkdownWorkerError(response.code, response.message));
    }
    void this.#pump();
  }

  /** `worker` failed: fail what it was running, drop it, and carry on with a fresh one. */
  #replaceWorker(worker: Worker, error: Error): void {
    if (this.#running?.worker === worker) this.#failRunning(error);
    void this.#worker?.then((current) => {
      if (current !== worker) return;
      this.#worker = null;
      void worker.terminate();
      void this.#pump();
    });
  }

  #failRunning(error: Error): void {
    const running = this.#running;
    if (!running) return;
    clearTimeout(running.timer);
    this.#running = null;
    running.reject(error);
  }

  #armIdle(): void {
    this.#clearIdle();
    if (this.#closed || !this.#worker) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#running || this.#queue.length > 0) return;
      const current = this.#worker;
      this.#worker = null;
      void current?.then((worker) => worker.terminate()).catch(() => undefined);
    }, this.#options.idleMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}
