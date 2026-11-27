/**
 * How a private seat message ends: how long it waits for a busy room chat, what its sender
 * reads when that wait runs out, and bounded terminal-write ownership for the receipts.
 */
import { logger } from '../../../lib/logger.js';
import type { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import { seatName } from './seat-message-prompt.js';
import type { SeatMessagePending } from './seat-message-types.js';
import { SEAT_REPORT_WAIT_MAX_MS } from './seat-report.js';
import { HANDOFF_SEAT_WAIT_MS } from './seat-stand-in.js';

/*
 * How long a note waits, and what its sender reads when the wait runs out (DOR-5301).
 *
 * A plain note gets {@link SEAT_MESSAGE_WAIT_MS}, the same two minutes a hand-off gets
 * (DOR-4252). A private note needs the agent itself to read it, so no stand-in can post it for
 * the chat; past the window the receipt fails and says why. An answer to the room chat's own
 * question keeps the longer wait spin-off reports have: that chat asked, and is waiting for it.
 *
 * The rechecks every {@link SEAT_MESSAGE_RECHECK_MS} land so the last one comes just before
 * the deadline, never on it, since the inbox's expiry timer fails the note at the deadline. A
 * chat whose runtime refused it as busy gives no release signal, so without that last try a
 * chat that frees late in the window would never be tried again.
 */
/** How long a plain private note waits for a busy room chat, from when it was accepted. */
export const SEAT_MESSAGE_WAIT_MS = HANDOFF_SEAT_WAIT_MS;
/** How long an answer to the room chat's own question waits for it. */
const SEAT_ANSWER_WAIT_MS = SEAT_REPORT_WAIT_MAX_MS;
/** How often a waiting note is tried again when no turn ended. */
export const SEAT_MESSAGE_RECHECK_MS = 30_000;
/** How long before its deadline a waiting note gets its last try. */
const FINAL_TRY_LEAD_MS = 1_000;

/**
 * When a note stops waiting.
 *
 * @param answer - Whether it answers a question the room chat asked.
 * @param acceptedAt - When it was accepted (epoch ms).
 */
export function seatMessageDeadline(answer: boolean, acceptedAt: number): number {
  return acceptedAt + (answer ? SEAT_ANSWER_WAIT_MS : SEAT_MESSAGE_WAIT_MS);
}

/**
 * How long to sleep before the next try: a full recheck, or less so the last try lands just
 * before the deadline. At or inside the lead it sleeps to the deadline, so it never spins.
 *
 * @param deadline - The earliest deadline among the waiting notes (epoch ms).
 * @param now - The current time (epoch ms).
 */
export function seatRecheckDelay(deadline: number, now: number): number {
  const left = deadline - now;
  if (left > SEAT_MESSAGE_RECHECK_MS + FINAL_TRY_LEAD_MS) return SEAT_MESSAGE_RECHECK_MS;
  if (left > FINAL_TRY_LEAD_MS) return left - FINAL_TRY_LEAD_MS;
  return Math.max(0, left);
}

/**
 * Why a note to a busy agent failed, as the sending chat reads it. It names the agent, not its
 * room chat, because the agent may be busy in another room.
 *
 * @param agentName - The receiving agent's display name, if known.
 * @param answer - Whether the note answered the room chat's own question.
 */
export function seatBusyReason(agentName: string | null | undefined, answer: boolean): string {
  const waited = answer ? 'an hour' : 'two minutes';
  return `${seatName(agentName, 'An agent')} stayed busy for ${waited}. Send it again later.`;
}

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
    private readonly release: (item: SeatMessagePending, repliedFrom?: string) => void,
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

  private releaseSafely(item: SeatMessagePending, repliedFrom?: string): void {
    try {
      this.release(item, repliedFrom);
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
        let repliedFrom: string | undefined;
        try {
          const askSender =
            intent.status === 'delivered' && intent.item.row.replyToId
              ? this.store.get(intent.item.row.replyToId)?.fromSessionId
              : undefined;
          const changed = this.store.updatePendingSeatMessage(id, {
            status: intent.status,
            ...(intent.reason ? { failureReason: intent.reason } : {}),
          });
          if (changed) repliedFrom = askSender;
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
        this.releaseSafely(intent.item, repliedFrom);
      }
    } finally {
      this.flushing = false;
      this.notify();
    }
  }
}
