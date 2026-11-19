/** Bounded, receipt-backed peer messages into private room-seat asides (DOR-4472). */
import { SeatMessageSettlements } from './seat-message-settlements.js';
import { logger, logError } from '../../../lib/logger.js';
import { ulid } from 'ulidx';
import type { AsideResult } from '../room-trigger/aside.js';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import { ChatMessageError } from '../../session/chat-messages/chat-message-error.js';
import type { RoomCore } from '../service/room-core.js';
import type { RoomPublisher } from '../service/room-publisher.js';
import { agentKey } from '../room-claims.js';
import { carryFrom, withRoomMarks } from './seat-carry.js';
import { SEAT_REPORT_WAIT_MAX_MS } from './seat-report.js';
import {
  currentSeatMessageTarget,
  resolveSeatMessageTarget,
  seatBatchStillCurrent,
} from './seat-message-target.js';
import {
  joinSeatCarry,
  seatCarryOf,
  seatMessageBatch,
  seatMessageNotice,
  SEAT_MESSAGE_BATCH_MAX,
} from './seat-message-prompt.js';
import type {
  RoomSeatMessagesPort,
  SeatMessageAdmission,
  SeatMessageLimits,
  SeatMessageTarget,
  SeatMessagePending as Pending,
} from './seat-message-types.js';

/** Resource defaults, not calibrated ideal values; active rows count toward both bounds. */
export const SEAT_MESSAGE_PENDING_MAX = 25;
/** Maximum pending/active receipt references owned by this inbox across all seats. */
export const SEAT_MESSAGE_GLOBAL_MAX = 1_000;
const DEFAULT_LIMITS: SeatMessageLimits = {
  pendingMax: SEAT_MESSAGE_PENDING_MAX,
  globalMax: SEAT_MESSAGE_GLOBAL_MAX,
};
const RECHECK_MS = 30_000;
interface Inbox {
  items: Pending[];
  active: Pending[];
  done: Promise<void>;
  wake?: () => void;
  expiry?: ReturnType<typeof setTimeout>;
}

/** One bounded inbox per room service and receipt store; ordinary dispatch never owns these rows. */
export class RoomSeatMessages implements RoomSeatMessagesPort {
  private readonly queues = new Map<string, Inbox>();
  private count = 0;
  private stopped = false;
  private faulted = false;
  private readonly settlements: SeatMessageSettlements;
  private resolveStopped?: () => void;
  private readonly stoppedSignal = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  constructor(
    private readonly core: RoomCore,
    private readonly publisher: RoomPublisher,
    private readonly receipts: ChatMessageStore,
    private readonly emit: (sessionId: string) => void,
    // Smaller bounds exist so tests can reach them without thousands of rows (DOR-4722).
    private readonly limits: SeatMessageLimits = DEFAULT_LIMITS
  ) {
    this.settlements = new SeatMessageSettlements(
      receipts,
      (item, repliedFrom) => this.release(item, repliedFrom),
      () => this.closeOnStorageFault(),
      RECHECK_MS
    );
    this.recoverInterrupted();
  }

  /** Resolve an authoritative current seat, never a historical seat-move redirect. */
  resolveSeatTarget(sessionId: string): SeatMessageTarget | null {
    return resolveSeatMessageTarget(this.core, sessionId);
  }

  /** Commit admission and any constant trace, reserve bounded ownership, then return promptly. */
  admit(input: SeatMessageAdmission) {
    if (this.stopped || this.faulted)
      throw new ChatMessageError('UNAVAILABLE', 'Seat messages are unavailable. Try again.');
    const currentSession = currentSeatMessageTarget(this.core, input.target);
    if (!currentSession) this.refuseTarget();
    const remaining = this.core.triggers.deps.budget.remaining(input.target.roomId);
    if (remaining.room === 0 || remaining.global === 0)
      throw new ChatMessageError('NOT_ALLOWED', 'budget: The room has no automatic turns left.');
    if (seatMessageBatch([input.rendered]).length > SEAT_MESSAGE_BATCH_MAX)
      throw new ChatMessageError(
        'INVALID_INPUT',
        'That message is too long for a private seat turn.'
      );
    const key = agentKey(input.target.roomId, input.target.authorId);
    const queue = this.queues.get(key);
    if (
      this.count >= this.limits.globalMax ||
      (queue && queue.items.length + queue.active.length >= this.limits.pendingMax)
    ) {
      throw new ChatMessageError('UNAVAILABLE', 'The seat message queue is full. Try again later.');
    }
    // A committed pending exchange is identified by actor and authoritative seat generation,
    // never by the display name or the drafting chat. No marker outlives its owned receipts.
    const noticePending = [...(queue?.items ?? []), ...(queue?.active ?? [])].some(
      (pending) =>
        pending.unsolicited &&
        pending.row.fromAgentId === input.row.fromAgentId &&
        (input.row.fromAgentId !== null || pending.row.fromAgentPath === input.row.fromAgentPath) &&
        currentSeatMessageTarget(this.core, pending.target) === currentSession
    );
    const { row, trace } = this.receipts.insertWithTrace(
      {
        ...input.row,
        deliveryRoute: 'seat',
        seatRoomId: input.target.roomId,
        seatAuthorId: input.target.authorId,
        seatJoinedAt: input.target.joinedAt,
        seatSessionId: input.target.sessionId,
      },
      (stored) => {
        const unsolicited = stored.replyToId === null;
        // Classification is transactional: a reserved/stale ask may have become a new ask.
        // This guard must run even when an existing notice would be coalesced.
        if (unsolicited && this.core.bridges.findBridgeByRoom(input.target.roomId) !== null)
          throw new ChatMessageError('NOT_ALLOWED', 'That room seat is unavailable.');
        return unsolicited && !noticePending ? this.writeTrace(input) : null;
      }
    );
    const pending: Pending = {
      ...input,
      row,
      unsolicited: row.replyToId === null,
      deadline: Date.now() + SEAT_REPORT_WAIT_MAX_MS,
    };
    this.count++;
    if (queue) {
      queue.items.push(pending);
      this.scheduleExpiry(queue);
    } else {
      const inbox: Inbox = { items: [pending], active: [], done: Promise.resolve() };
      this.queues.set(key, inbox);
      this.scheduleExpiry(inbox);
      inbox.done = Promise.resolve().then(() => this.drain(key, inbox));
    }
    if (trace) {
      try {
        this.publisher.publishEntry(trace, [], { localOnly: true });
      } catch (error) {
        logger.warn('[seat-messages] committed trace could not publish', logError(error));
      }
    }
    this.activity(pending);
    return {
      messageId: row.id,
      chatId: row.toSessionId,
      status: 'queued' as const,
      ...(row.delivery !== 'queue' ? { note: 'Seat messages wait for a private turn.' } : {}),
    };
  }

  /** Fail leftover route-owned work once at boot; never replay it through normal dispatch. */
  recoverInterrupted(): number {
    const rows = this.receipts.pendingSeatMessages();
    for (const row of rows) {
      this.receipts.update(row.id, {
        status: 'failed',
        failureReason: 'The server restarted before the seat message finished.',
      });
      this.emitSafely(row.fromSessionId);
      this.emitSafely(row.toSessionId);
    }
    return rows.length;
  }

  /** Reject new work, fail pending receipts and cancel owned waits, without stopping any agent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const queue of this.queues.values()) {
      if (queue.expiry) clearTimeout(queue.expiry);
      queue.expiry = undefined;
      this.settle(queue.active.splice(0), 'failed', 'The server stopped before delivery.');
      this.settle(queue.items.splice(0), 'failed', 'The server stopped before delivery.');
      queue.wake?.();
    }
    this.settlements.stop();
    this.queues.clear();
    this.resolveStopped?.();
  }

  /** Resolve after all currently owned batches/waits finish; tests only. */
  async idle(): Promise<void> {
    while (!this.stopped && this.queues.size) {
      await Promise.race([
        Promise.allSettled([...this.queues.values()].map((q) => q.done)),
        this.stoppedSignal,
      ]);
    }
    await this.settlements.idle();
  }

  private closeOnStorageFault(): void {
    if (this.stopped || this.faulted) return;
    this.faulted = true;
    for (const queue of this.queues.values()) {
      if (queue.expiry) clearTimeout(queue.expiry);
      queue.expiry = undefined;
      this.settle(queue.items.splice(0), 'failed', 'Storage failed before delivery.');
      queue.wake?.();
    }
  }

  private writeTrace(input: SeatMessageAdmission): RoomEntry {
    const id = ulid();
    const receiver = this.core.authors.getById(input.target.authorId)?.displayName ?? 'An agent';
    return this.core.store.appendEntry({
      roomId: input.target.roomId,
      id,
      authorId: this.core.authors.system().id,
      kind: 'notice',
      body: { text: seatMessageNotice(input.row.fromAgentName, receiver) },
      mentions: [],
      sessionId: null,
      cascadeRoot: id,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      createdAt: new Date().toISOString(),
    });
  }

  private refuseTarget(): never {
    throw new ChatMessageError('NOT_ALLOWED', 'That room seat no longer matches the target chat.');
  }

  private emitSafely(sessionId: string): void {
    try {
      this.emit(sessionId);
    } catch {
      logger.warn('[seat-messages] receipt notification failed', { sessionId });
    }
  }

  private activity(item: Pending): void {
    this.emitSafely(item.row.fromSessionId);
    this.emitSafely(item.row.toSessionId);
  }

  private release(item: Pending, repliedFrom?: string): void {
    this.count--;
    this.activity(item);
    if (
      repliedFrom &&
      repliedFrom !== item.row.fromSessionId &&
      repliedFrom !== item.row.toSessionId
    )
      this.emitSafely(repliedFrom);
  }

  private settle(items: Pending[], status: 'delivered' | 'failed', reason?: string): void {
    this.settlements.add(items, status, reason);
  }

  /** A post-claim busy result keeps its original FIFO place, deadline and capacity. */
  private requeueBusy(queue: Inbox): void {
    while (queue.active.length) {
      const item = queue.active.at(-1)!;
      // Keep the reference owned until its CAS finishes. If storage throws,
      // outer cleanup still owns both this active prefix and earlier requeues.
      let pending: boolean;
      try {
        pending = this.receipts.updatePendingSeatMessage(item.row.id, { status: 'queued' });
      } catch (error) {
        this.closeOnStorageFault();
        throw error;
      }
      queue.active.pop();
      if (pending) {
        queue.items.unshift(item);
        this.activity(item);
      } else this.release(item); // Recovery/stop already owns its terminal row.
    }
    this.scheduleExpiry(queue);
  }

  private batch(queue: Inbox): Pending[] {
    const batch: Pending[] = [];
    for (const item of queue.items) {
      if (seatMessageBatch([...batch, item].map((v) => v.rendered)).length > SEAT_MESSAGE_BATCH_MAX)
        break;
      batch.push(item);
    }
    return batch;
  }

  /** Pending deadlines run independently of the active aside; no queued row can wait forever behind it. */
  private scheduleExpiry(queue: Inbox): void {
    if (queue.expiry) clearTimeout(queue.expiry);
    queue.expiry = undefined;
    if (this.stopped || this.faulted || !queue.items.length) return;
    const deadline = Math.min(...queue.items.map((item) => item.deadline));
    queue.expiry = setTimeout(
      () => {
        queue.expiry = undefined;
        const expired = queue.items.filter((item) => item.deadline <= Date.now());
        queue.items = queue.items.filter((item) => item.deadline > Date.now());
        this.settle(expired, 'failed', 'The seat stayed busy for an hour.');
        this.scheduleExpiry(queue);
        if (!queue.items.length) queue.wake?.();
      },
      Math.max(0, deadline - Date.now())
    );
    queue.expiry.unref?.();
  }

  private async wait(queue: Inbox, deadline: number): Promise<void> {
    const ms = Math.max(0, Math.min(RECHECK_MS, deadline - Date.now()));
    const controller = new AbortController();
    queue.wake = () => controller.abort();
    await this.core.triggers.nextRelease(ms, undefined, controller.signal).finally(() => {
      queue.wake = undefined;
    });
  }

  private claimBatch(queue: Inbox, batch: Pending[], state: { canRun: boolean }): void {
    queue.active = queue.items.splice(0, batch.length);
    this.scheduleExpiry(queue);
    for (const item of batch) {
      try {
        const toSessionId =
          currentSeatMessageTarget(this.core, item.target) ?? item.row.toSessionId;
        state.canRun =
          this.receipts.updatePendingSeatMessage(item.row.id, { status: 'working', toSessionId }) &&
          state.canRun;
      } catch {
        state.canRun = false;
        this.closeOnStorageFault();
        logger.warn('[seat-messages] claim receipt failed', { messageId: item.row.id });
      }
      this.activity(item);
    }
  }

  private async launchBatch(queue: Inbox, batch: Pending[]): Promise<AsideResult> {
    const first = batch[0]!;
    const room = this.core.store.getRoom(first.target.roomId);
    if (!room) return { outcome: 'refused', why: 'gone', text: null };
    const [lastEntry] = this.core.store.listEntries(first.target.roomId, { limit: 1 });
    // A valid private reply needs no public notice, even in an empty room. This
    // context-only anchor is never persisted/published and advances no read cursor.
    const latest: RoomEntry = lastEntry ?? {
      roomId: room.id,
      seq: 1,
      id: first.row.id,
      authorId: this.core.authors.system().id,
      kind: 'notice',
      body: { text: 'Private seat message.' },
      mentions: [],
      sessionId: null,
      cascadeRoot: first.row.id,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      signature: null,
      createdAt: new Date().toISOString(),
    };
    const state = { canRun: true };
    return this.core.triggers.askAside({
      room,
      entry: latest,
      authorId: first.target.authorId,
      prompt: seatMessageBatch(batch.map((v) => v.rendered)),
      untrustedText: true,
      validateTarget: () =>
        !this.stopped && !this.faulted && state.canRun && seatBatchStillCurrent(this.core, batch),
      prepareCarry: () =>
        withRoomMarks(
          this.core,
          first.target.authorId,
          joinSeatCarry(
            ...batch.flatMap((item) => [
              item.carried,
              seatCarryOf(item.row),
              carryFrom(item.row.fromSessionId, item.row.fromAgentPath),
            ])
          ),
          room,
          latest
        ),
      onClaimed: () => this.claimBatch(queue, batch, state),
    });
  }

  private async drain(key: string, queue: Inbox): Promise<void> {
    try {
      while (!this.stopped && !this.faulted && queue.items.length) {
        const first = queue.items[0]!;
        if (first.deadline <= Date.now()) {
          this.settle(queue.items.splice(0, 1), 'failed', 'The seat stayed busy for an hour.');
          continue;
        }
        if (!currentSeatMessageTarget(this.core, first.target)) {
          this.settle(queue.items.splice(0, 1), 'failed', 'NOT_ALLOWED: The room seat changed.');
          continue;
        }
        const batch = this.batch(queue);
        const result = await this.launchBatch(queue, batch);
        if (result.outcome === 'busy') {
          // A runner may refuse busy after onClaimed moved the batch to active.
          if (this.stopped || this.faulted) break;
          this.requeueBusy(queue);
          if (this.stopped || this.faulted || !queue.items.length) break;
          await this.wait(queue, first.deadline);
          continue;
        }
        const launched = queue.active.length
          ? queue.active.splice(0)
          : queue.items.splice(0, batch.length);
        const delivered = result.outcome === 'answered' || result.outcome === 'quiet';
        this.settle(
          launched,
          delivered ? 'delivered' : 'failed',
          delivered
            ? undefined
            : result.why === 'gone'
              ? 'NOT_ALLOWED: The room seat changed.'
              : (result.why ?? result.outcome)
        );
      }
    } catch {
      this.settle(queue.active.splice(0), 'failed', 'The private seat turn failed.');
      this.settle(queue.items.splice(0), 'failed', 'The private seat turn failed.');
    } finally {
      this.settle(queue.active.splice(0), 'failed', 'The private seat turn was interrupted.');
      this.settle(queue.items.splice(0), 'failed', 'The private seat turn was interrupted.');
      if (queue.expiry) clearTimeout(queue.expiry);
      queue.expiry = undefined;
      this.queues.delete(key);
    }
  }
}
