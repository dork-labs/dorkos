/**
 * The server's handle on its one markdown worker (DOR-2984).
 *
 * Every markdown ↔ Yjs conversion goes through here, so none of it runs on the
 * event loop. One worker serves every doc (Blintz builds one model per worker
 * and reuses it); it starts on the first request, stops after a quiet spell so
 * an idle server holds no parser, and starts again when needed. A worker that
 * crashes or hangs fails only the requests it held: the next request gets a
 * fresh one.
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

interface Pending {
  resolve: (result: MarkdownWorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Talks to the markdown worker; see the module doc. */
export class MarkdownWorkerClient {
  readonly #options: Required<MarkdownWorkerClientOptions>;
  #worker: Promise<Worker> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
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

  /** Stop the worker and refuse further requests. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#stopWorker(new MarkdownWorkerError('FAILED', 'The markdown worker stopped.'));
  }

  async #request<Op extends MarkdownWorkerOp>(
    body: Extract<RequestBody, { op: Op }>
  ): Promise<ResultOf<Op>> {
    if (this.#closed) throw new MarkdownWorkerError('FAILED', 'The markdown worker stopped.');
    this.#clearIdle();
    const worker = await this.#ensureWorker();
    const id = this.#nextId++;
    const result = await new Promise<MarkdownWorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A request that hangs takes its worker with it; the next one starts fresh.
        void this.#stopWorker(
          new MarkdownWorkerError('FAILED', 'The markdown worker took too long.')
        );
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...body, id } as MarkdownWorkerRequest);
    });
    return result as ResultOf<Op>;
  }

  #ensureWorker(): Promise<Worker> {
    this.#worker ??= this.#options.resolveEntry().then((entry) => {
      const worker = new Worker(entry);
      // Never what keeps a process alive: a CLI or test that is done must exit.
      worker.unref();
      worker.on('message', (response: MarkdownWorkerResponse) => this.#settle(response));
      worker.on('error', (error) =>
        this.#failWorker(worker, new MarkdownWorkerError('FAILED', error.message))
      );
      worker.on('exit', () =>
        this.#failWorker(worker, new MarkdownWorkerError('FAILED', 'The markdown worker exited.'))
      );
      return worker;
    });
    // A worker file that cannot be found fails this request, not the next one.
    this.#worker.catch(() => {
      this.#worker = null;
    });
    return this.#worker;
  }

  #settle(response: MarkdownWorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      const { id: _id, ok: _ok, ...result } = response;
      pending.resolve(result as MarkdownWorkerResult);
    } else {
      pending.reject(new MarkdownWorkerError(response.code, response.message));
    }
    if (this.#pending.size === 0) this.#armIdle();
  }

  /** Fail what `worker` held, once, and forget it if it is still the current one. */
  #failWorker(worker: Worker, error: Error): void {
    void this.#worker?.then((current) => {
      if (current !== worker) return;
      this.#worker = null;
      this.#rejectAll(error);
    });
  }

  async #stopWorker(error: Error): Promise<void> {
    this.#clearIdle();
    const current = this.#worker;
    this.#worker = null;
    this.#rejectAll(error);
    const worker = await current?.catch(() => null);
    await worker?.terminate();
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #armIdle(): void {
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => {
      void this.#stopWorker(new MarkdownWorkerError('FAILED', 'The markdown worker stopped.'));
    }, this.#options.idleMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}
