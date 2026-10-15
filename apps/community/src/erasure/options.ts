/** The erasure procedure's public shapes: its retryable error, its steps, hooks and options. */

/** A named, content-free reason an erasure could not finish yet; the worker retries it. */
export class ErasureError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ErasureError';
  }
}

/** One step of the membership procedure, named for crash and lock tests. */
export type ErasureStep =
  'end-access' | 'files' | 'exports' | 'tombstones' | 'mentions' | 'seal' | 'account';

/** Test seams: pause inside a batch transaction, or fail after a step commits. */
export interface ErasureHooks {
  /** Runs after a step's transactions commit. Throwing simulates a worker that died there. */
  afterStep?: (step: ErasureStep) => Promise<void>;
  /** Runs inside each batch transaction, after its changes and before it commits. */
  inBatch?: (step: ErasureStep) => Promise<void>;
}

/** How one erasure run reports and journals itself. */
export interface ErasureOptions {
  /** Append each completion line here too (`COMMUNITY_ERASURE_JOURNAL`). */
  journalPath?: string;
  hooks?: ErasureHooks;
  /** Rows per locked batch; at most 500. */
  batchSize?: number;
  /** Receives each completion line; defaults to standard output. */
  log?: (line: string) => void;
  /** The running account request this erasure belongs to; its lease is renewed too. */
  requestId?: string;
}
