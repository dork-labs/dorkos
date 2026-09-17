/**
 * Bounded retry worker for confirmed remote community delivery.
 *
 * @module services/communities/remote/community-outbox-worker
 */
import type { CommunityOutboxItem, CommunityOutboxStore } from './community-outbox-store.js';
import type { CommunityRef } from '@dorkos/shared/community-adapter';

/** The only outcomes the native delivery adapter may report to this worker. */
export type CommunityDeliveryResult =
  | { kind: 'confirmed'; remoteEntryId: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'permanent'; reason: string }
  | { kind: 'stopped'; reason: string };

/** Recheck local Stop/enrollment/connection state immediately before network work. */
export interface CommunityOutboxAuthority {
  canDeliver(item: CommunityOutboxItem): boolean | Promise<boolean>;
}

/**
 * Native delivery port. It calls `stillAuthorized` before every upload and the
 * final post, so Stop/revocation that lands while a file is in flight closes
 * the next network boundary instead of waiting for another worker tick.
 */
export interface CommunityOutboxDelivery {
  deliver(
    item: CommunityOutboxItem,
    stillAuthorized: () => boolean | Promise<boolean>,
    signal?: AbortSignal
  ): Promise<CommunityDeliveryResult>;
}

/** Publishes a new owner-safe projection after delivery state changes. */
export interface CommunityOutboxChangeListener {
  changed(ownerAuthorId: string): void;
}

/** The owner-scoped identity of a delivery the person wants to retry now. */
export interface CommunityOutboxRetryInput {
  communityRef: CommunityRef;
  remoteRoomId: string;
  ownerAuthorId: string;
  idempotencyKey: string;
}

/** Result of asking the one worker to release a pending transient backoff. */
export type CommunityOutboxRetryResult = 'retried' | 'missing' | 'terminal' | 'in-flight';

/** One-process worker; remote I/O never runs inside the writer transaction. */
export class CommunityOutboxWorker {
  private readonly inFlight = new Map<
    string,
    { item: CommunityOutboxItem; abort: AbortController }
  >();

  constructor(
    private readonly store: CommunityOutboxStore,
    private readonly authority: CommunityOutboxAuthority,
    private readonly delivery: CommunityOutboxDelivery,
    private readonly now: () => number = () => Date.now(),
    private readonly changes?: CommunityOutboxChangeListener
  ) {}

  /** Whether this worker is currently holding an item across an authority or delivery await. */
  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Abort delivery already in progress for one owner-qualified remote room. */
  abortForRoom(communityRef: CommunityRef, remoteRoomId: string, ownerAuthorId: string): void {
    this.abortWhere(
      (item) =>
        item.communityRef === communityRef &&
        item.remoteRoomId === remoteRoomId &&
        item.ownerAuthorId === ownerAuthorId
    );
  }

  /** Abort delivery in progress for one agent leaving one qualified remote room. */
  abortForAgentInRoom(
    communityRef: CommunityRef,
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): void {
    this.abortWhere(
      (item) =>
        item.communityRef === communityRef &&
        item.remoteRoomId === remoteRoomId &&
        item.localAgentId === localAgentId &&
        item.ownerAuthorId === ownerAuthorId
    );
  }

  /** Abort delivery already in progress for one owner-qualified local agent. */
  abortForAgent(communityRef: CommunityRef, localAgentId: string, ownerAuthorId: string): void {
    this.abortWhere(
      (item) =>
        item.communityRef === communityRef &&
        item.localAgentId === localAgentId &&
        item.ownerAuthorId === ownerAuthorId
    );
  }

  /** Abort all active delivery during process shutdown. */
  abortAll(): void {
    this.abortWhere(() => true);
  }

  /** Release one pending transient backoff only when this worker is not already delivering it. */
  retryNow(input: CommunityOutboxRetryInput): CommunityOutboxRetryResult {
    const item = this.store.deliveryForOwner(
      input.communityRef,
      input.remoteRoomId,
      input.ownerAuthorId,
      input.idempotencyKey
    );
    if (!item) return 'missing';
    if (this.inFlight.has(item.id)) return 'in-flight';
    const result = this.store.retryPendingBackoff(
      input.communityRef,
      input.remoteRoomId,
      input.ownerAuthorId,
      input.idempotencyKey,
      new Date(this.now()).toISOString()
    );
    if (result === 'retried') this.changes?.changed(input.ownerAuthorId);
    return result;
  }

  /** Deliver a bounded due batch, preserving idempotency keys across every retry. */
  async runOnce(): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const expiredOwners = this.store.expire(now);
    for (const ownerAuthorId of expiredOwners) this.changes?.changed(ownerAuthorId);
    for (const item of this.store.due(now)) {
      const abort = new AbortController();
      this.inFlight.set(item.id, { item, abort });
      // The owner SSE must expose this held delivery before any remote I/O can
      // block, while the projection still reports it as non-retryable in flight.
      this.changes?.changed(item.ownerAuthorId);
      let changed = false;
      try {
        if (!(await this.authority.canDeliver(item))) {
          this.store.stop([item.id], 'stopped-or-unauthorized');
          changed = true;
          continue;
        }
        let result: CommunityDeliveryResult;
        try {
          result = await this.delivery.deliver(
            item,
            () => this.authority.canDeliver(item),
            abort.signal
          );
        } catch (error) {
          result = {
            kind: abort.signal.aborted ? 'stopped' : 'retry',
            reason: abort.signal.aborted
              ? 'stopped-or-unauthorized'
              : error instanceof Error
                ? error.message
                : 'network delivery failed',
          };
        }
        if (abort.signal.aborted) result = { kind: 'stopped', reason: 'stopped-or-unauthorized' };
        if (result.kind === 'confirmed') {
          this.store.confirm(item.id, result.remoteEntryId);
          changed = true;
        } else if (result.kind === 'stopped') {
          this.store.stop([item.id], result.reason);
          changed = true;
        } else if (result.kind === 'permanent') {
          this.store.fail(item.id, result.reason);
          changed = true;
        } else {
          const attempts = item.attempts + 1;
          this.store.retry(
            item.id,
            attempts,
            new Date(this.now() + retryDelayMs(attempts)).toISOString()
          );
          changed = true;
        }
      } finally {
        this.inFlight.delete(item.id);
        if (changed) this.changes?.changed(item.ownerAuthorId);
      }
    }
  }

  private abortWhere(matches: (item: CommunityOutboxItem) => boolean): void {
    for (const { item, abort } of this.inFlight.values()) if (matches(item)) abort.abort();
  }
}

/** 1, 2, 4, 8, 16, then 30 seconds, with bounded positive jitter. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30, 2 ** Math.max(0, attempts - 1)) * 1_000;
  return base + Math.floor(Math.max(0, Math.min(1, random())) * Math.min(1_000, base / 4));
}

/** Starts one bounded polling loop and exposes an explicit shutdown boundary. */
export class CommunityOutboxRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly worker: CommunityOutboxWorker,
    private readonly intervalMs = 1_000,
    private readonly logFailure: (error: unknown) => void = () => undefined
  ) {}

  /** Begin delivery immediately, then continue while this process owns the subsystem. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  /** Stop scheduling new remote work; an in-flight request rechecks authority itself. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.worker.abortAll();
  }

  private async tick(): Promise<void> {
    try {
      await this.worker.runOnce();
    } catch (error) {
      this.logFailure(error);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }
}
