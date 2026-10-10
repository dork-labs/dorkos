/**
 * Sends the acknowledgements the command journal owes DorkOS Cloud
 * (`POST /v1/remote/commands/ack`, DOR-2086), until each is accepted or
 * explicitly refused, across restarts.
 *
 * - **Durable.** What is owed lives in the journal, not in memory, so an
 *   acknowledgement lost to a crash or a restart is sent again on the next
 *   connection.
 * - **Never trusts a count alone.** When Cloud settles as many leases as were
 *   sent, they are all done. When the count differs, there is no telling which
 *   were settled, so each is sent again on its own: one settled is done, one
 *   Cloud settles nothing for is `unconfirmed` (its lease has ended; a
 *   redelivery under a new lease puts it back in the queue).
 * - **Refusals are per lease.** A batch Cloud refuses outright is split the
 *   same way, and a single acknowledgement refused with a client error is
 *   `rejected` and not sent again. An outage, a timeout, an expired key or a
 *   rate limit is retried with capped exponential backoff and full jitter.
 * - **Only under its own link.** Acknowledgements go out under the link the
 *   commands arrived on, never a later one.
 *
 * @module services/core/remote/command-acks
 */
import { RemoteCommandAckResponseSchema, V1_ROUTES } from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import { problemOf } from '../cloud/v1-client.js';
import type { CommandJournal, PendingAck } from './command-journal.js';
import type { CommandLink } from './command-dispatcher.js';
import { errorName } from './managed-remote-support.js';

/** The ack route takes at most this many items at once. */
export const ACK_BATCH_MAX = 100;
/** The first retry wait after a failed send, before jitter. */
export const ACK_RETRY_BASE_MS = 2_000;
/** The ceiling of the retry wait. */
export const ACK_RETRY_MAX_MS = 5 * 60_000;

/** Statuses that say "try again later", never "this lease is refused". */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 425, 429]);

/** What the sender touches, injectable for tests. */
export interface CommandAcksDeps {
  journal: Pick<CommandJournal, 'pendingAcks' | 'noteAttempt' | 'finish'>;
  random?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

type SendResult = 'done' | 'split' | 'retry';

/** Sends what the journal owes. One per command stream session. */
export class CommandAcks {
  private flushing: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private stopped = false;
  private readonly random: () => number;
  private readonly timers: NonNullable<CommandAcksDeps['timers']>;

  /**
   * Build the sender for one link.
   *
   * @param link - The link the commands arrived on.
   * @param deps - The journal and the clock seams.
   */
  constructor(
    private readonly link: CommandLink,
    private readonly deps: CommandAcksDeps
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

  /**
   * Send everything owed now. A flush already running picks up anything added
   * meanwhile. Resolves when this round is done; never rejects.
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

  /** Stop sending, and cancel any retry. What is owed stays in the journal. */
  stop(): void {
    this.stopped = true;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async drain(): Promise<void> {
    let batchSize = ACK_BATCH_MAX;
    for (;;) {
      if (this.stopped || !this.link.context.isCurrent()) return;
      this.again = false;
      const items = this.deps.journal.pendingAcks(this.link.instanceId, batchSize);
      if (items.length === 0) {
        if (this.again) continue;
        return;
      }
      const result = await this.send(items);
      if (result === 'retry') return this.scheduleRetry();
      this.failures = 0;
      if (result === 'split') batchSize = 1;
    }
  }

  private async send(items: PendingAck[]): Promise<SendResult> {
    const sent = items.map(({ id, leaseToken }) => ({ id, leaseToken }));
    this.deps.journal.noteAttempt(sent.map((item) => item.id));
    let acknowledged: number;
    try {
      const response = await this.link.context.client.post(
        V1_ROUTES.remoteCommandsAck,
        RemoteCommandAckResponseSchema,
        {
          body: {
            items: items.map(({ id, leaseToken, outcome }) => ({ id, leaseToken, outcome })),
          },
        }
      );
      acknowledged = response.acknowledged;
    } catch (error) {
      const problem = problemOf(error);
      const status = problem?.status;
      if (
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        !TRANSIENT_STATUSES.has(status)
      ) {
        if (items.length > 1) return 'split';
        this.deps.journal.finish(sent, 'rejected');
        logger.warn('[RemoteAccess] Cloud refused a command acknowledgement', {
          commandId: sent[0]!.id,
          code: problem?.code,
        });
        return 'done';
      }
      logger.warn('[RemoteAccess] Command acknowledgement not delivered; will retry', {
        error: problem?.code ?? errorName(error),
      });
      return 'retry';
    }
    if (acknowledged === items.length) {
      this.deps.journal.finish(sent, 'acked');
      return 'done';
    }
    if (items.length > 1) return 'split';
    // One lease, and Cloud settled nothing for it: its lease has ended.
    this.deps.journal.finish(sent, acknowledged > 0 ? 'acked' : 'unconfirmed');
    return 'done';
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.failures += 1;
    const ceiling = Math.min(ACK_RETRY_MAX_MS, ACK_RETRY_BASE_MS * 2 ** (this.failures - 1));
    const wait = Math.max(ACK_RETRY_BASE_MS / 4, Math.floor(this.random() * ceiling));
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, wait);
  }
}
