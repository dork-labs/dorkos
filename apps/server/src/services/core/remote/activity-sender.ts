/**
 * Sends the managed remote access activity reports the outbox holds
 * (`POST /v1/remote/events`, DOR-2086), oldest first, each under the
 * `Idempotency-Key` it was stored with.
 *
 * - **Same batch, same key.** A batch is sent exactly as stored, under its own
 *   key, however many times it takes: after a timeout, a lost answer or a
 *   restart. The outbox never edits one, so the key changes only with the
 *   contents.
 * - **Accepted means gone.** Any success retires the batch. `{ accepted: 0 }`
 *   cannot tell "already applied" from "empty", but an empty batch is never
 *   stored, so for a stored one it can only mean Cloud already holds it.
 * - **Refused is retried, then let go.** A refusal keeps its key and is tried
 *   again on the backoff below; a batch refused {@link EVENTS_MAX_REFUSALS}
 *   times (counted apart from other failures, and kept across restarts) is
 *   dropped with a warning rather than blocking every later one. An
 *   outage, a timeout, an expired key or a rate limit is retried without limit
 *   (the outbox's own bounds still apply).
 * - **Never in the way.** Nothing local waits on it: withdrawal, closing and
 *   shutdown go ahead whatever it is doing. Only under the link it was built
 *   for, and only for that link's instance.
 *
 * @module services/core/remote/activity-sender
 */
import {
  REMOTE_EVENTS_IDEMPOTENCY_HEADER,
  RemoteEventBatchResponseSchema,
  V1_ROUTES,
} from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import { problemOf } from '../cloud/v1-client.js';
import type { ActivityOutbox, OutboxBatch } from './activity-outbox.js';
import type { CommandLink } from './command-dispatcher.js';
import { errorName } from './managed-remote-support.js';

/** How long one send may take before it counts as lost. */
export const EVENTS_TIMEOUT_MS = 15_000;
/** The first retry wait after a failed send, before jitter. */
export const EVENTS_RETRY_BASE_MS = 5_000;
/** The ceiling of the retry wait. */
export const EVENTS_RETRY_MAX_MS = 10 * 60_000;
/** How many refusals a batch gets before it is dropped. */
export const EVENTS_MAX_REFUSALS = 5;
/** Failures in a row after which the backlog is reported as not getting through. */
export const EVENTS_STUCK_AFTER = 5;

/** Statuses that say "try again later", never "this batch is refused". */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 425, 429]);

/** What the sender touches, injectable for tests. */
export interface ActivitySenderDeps {
  outbox: Pick<ActivityOutbox, 'pending' | 'noteAttempt' | 'noteRefusal' | 'retire'>;
  random?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Bounds one send; defaults to {@link EVENTS_TIMEOUT_MS}. */
  timeoutSignal?: () => AbortSignal;
}

type SendResult = 'done' | 'retry';

/** Sends what the outbox holds for one link. One per command stream session. */
export class ActivitySender {
  private flushing: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private stopped = false;
  private readonly random: () => number;
  private readonly timers: NonNullable<ActivitySenderDeps['timers']>;

  /**
   * Build the sender for one link.
   *
   * @param link - The link whose instance the batches belong to.
   * @param deps - The outbox and the clock seams.
   */
  constructor(
    private readonly link: CommandLink,
    private readonly deps: ActivitySenderDeps
  ) {
    this.random = deps.random ?? Math.random;
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** Whether sends have failed often enough in a row that reports are not getting through. */
  get stuck(): boolean {
    return this.failures >= EVENTS_STUCK_AFTER;
  }

  /**
   * Send everything waiting now. A flush already running picks up anything
   * added meanwhile. Resolves when this round is done; never rejects.
   */
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.clearRetry();
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Stop sending, and cancel any retry. What is waiting stays in the outbox. */
  stop(): void {
    this.stopped = true;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.link.context.isCurrent()) return;
      this.again = false;
      const [next] = this.deps.outbox.pending(this.link.instanceId, 1);
      if (!next) {
        if (this.again) continue;
        return;
      }
      if ((await this.send(next)) === 'retry') return this.scheduleRetry();
      this.failures = 0;
    }
  }

  private async send(item: OutboxBatch): Promise<SendResult> {
    this.deps.outbox.noteAttempt(item.id);
    try {
      await this.link.context.client.post(V1_ROUTES.remoteEvents, RemoteEventBatchResponseSchema, {
        body: item.batch,
        headers: { [REMOTE_EVENTS_IDEMPOTENCY_HEADER]: item.idempotencyKey },
        signal: this.deps.timeoutSignal?.() ?? AbortSignal.timeout(EVENTS_TIMEOUT_MS),
      });
    } catch (error) {
      const problem = problemOf(error);
      const status = problem?.status;
      const refused =
        status !== undefined && status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status);
      // Only refusals count toward giving up: an outage never drops a batch.
      if (refused && item.refusals + 1 >= EVENTS_MAX_REFUSALS) {
        this.deps.outbox.retire(item.id);
        logger.warn('[RemoteAccess] Cloud kept refusing an activity report; dropped it', {
          code: problem?.code,
        });
        return 'done';
      }
      if (refused) this.deps.outbox.noteRefusal(item.id);
      logger.warn('[RemoteAccess] Activity report not delivered; will retry', {
        error: problem?.code ?? errorName(error),
      });
      return 'retry';
    }
    // Stored batches are never empty, so `accepted: 0` here means Cloud already has it.
    this.deps.outbox.retire(item.id);
    return 'done';
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures === EVENTS_STUCK_AFTER) {
      logger.warn('[RemoteAccess] Activity reports are not getting through to DorkOS Cloud');
    }
    const ceiling = Math.min(EVENTS_RETRY_MAX_MS, EVENTS_RETRY_BASE_MS * 2 ** (this.failures - 1));
    const wait = Math.max(EVENTS_RETRY_BASE_MS / 4, Math.floor(this.random() * ceiling));
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, wait);
  }
}
