/** Bounded terminal-write ownership for one private-seat messaging component. */
import { logger } from '../../../lib/logger.js';
import type { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import type { SeatMessagePending } from './seat-message-types.js';

interface Intent {
  item: SeatMessagePending;
  status: 'delivered' | 'failed';
  reason?: string;
}
const LOG_IDS_MAX = 25;

/** No model work: retry only already-decided receipt terminals under the existing capacity bound. */
export class SeatMessageSettlements {
  private readonly pending = new Map<string, Intent>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private flushing = false;
  private waiter?: { promise: Promise<void>; resolve: () => void };

  constructor(
    private readonly store: ChatMessageStore,
    private readonly release: (item: SeatMessagePending) => void,
    private readonly fault: () => void,
    private readonly retryMs: number
  ) {}

  /** First terminal intent wins; Stop or a late completion cannot overwrite it. */
  add(items: SeatMessagePending[], status: Intent['status'], reason?: string): void {
    if (this.stopped || !items.length) return;
    for (const item of items) {
      if (!this.pending.has(item.row.id)) this.pending.set(item.row.id, { item, status, reason });
    }
    if (!this.timer) this.flush();
  }

  /** Wait for an actual completion signal, never spin over an empty set of worker promises. */
  idle(): Promise<void> {
    if (this.stopped || !this.pending.size) return Promise.resolve();
    if (!this.waiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.waiter = { promise, resolve };
    }
    return this.waiter.promise;
  }

  /** One final write pass while storage is open, then explicit handoff to durable boot recovery. */
  stop(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size) {
      logger.warn('[seat-messages] stopped with receipts awaiting restart recovery', {
        count: this.pending.size,
        messageIds: [...this.pending.keys()].slice(0, LOG_IDS_MAX),
      });
      const unwritten = [...this.pending.values()];
      this.pending.clear();
      for (const intent of unwritten) this.releaseSafely(intent.item);
    }
    this.notify();
  }

  private releaseSafely(item: SeatMessagePending): void {
    try {
      this.release(item);
    } catch {
      logger.warn('[seat-messages] receipt release notification failed', {
        messageId: item.row.id,
      });
    }
  }

  private notify(): void {
    if (!this.pending.size || this.stopped) {
      this.waiter?.resolve();
      this.waiter = undefined;
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.retryMs);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.stopped || this.flushing) return;
    this.flushing = true;
    try {
      for (const [id, intent] of this.pending) {
        if (this.stopped) break;
        try {
          this.store.updatePendingSeatMessage(id, {
            status: intent.status,
            ...(intent.reason ? { failureReason: intent.reason } : {}),
          });
        } catch {
          logger.warn('[seat-messages] receipt settlement retained', { messageId: id });
          try {
            this.fault();
          } catch {
            logger.warn('[seat-messages] storage fault notification failed', { messageId: id });
          }
          this.schedule();
          break;
        }
        // Success or a terminal row owned by recovery: both release this reference exactly once.
        this.pending.delete(id);
        this.releaseSafely(intent.item);
      }
    } finally {
      this.flushing = false;
      this.notify();
    }
  }
}
