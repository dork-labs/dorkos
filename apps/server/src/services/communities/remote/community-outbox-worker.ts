/**
 * Bounded retry worker for confirmed remote community delivery.
 *
 * @module services/communities/remote/community-outbox-worker
 */
import type { CommunityOutboxItem, CommunityOutboxStore } from './community-outbox-store.js';

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
    stillAuthorized: () => boolean | Promise<boolean>
  ): Promise<CommunityDeliveryResult>;
}

/** Publishes a new owner-safe projection after delivery state changes. */
export interface CommunityOutboxChangeListener {
  changed(ownerAuthorId: string): void;
}

/** One-process worker; remote I/O never runs inside the writer transaction. */
export class CommunityOutboxWorker {
  constructor(
    private readonly store: CommunityOutboxStore,
    private readonly authority: CommunityOutboxAuthority,
    private readonly delivery: CommunityOutboxDelivery,
    private readonly now: () => number = () => Date.now(),
    private readonly changes?: CommunityOutboxChangeListener
  ) {}

  /** Deliver a bounded due batch, preserving idempotency keys across every retry. */
  async runOnce(): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const expiredOwners = this.store.expire(now);
    for (const ownerAuthorId of expiredOwners) this.changes?.changed(ownerAuthorId);
    for (const item of this.store.due(now)) {
      if (!(await this.authority.canDeliver(item))) {
        this.store.stop([item.id], 'stopped-or-unauthorized');
        this.changes?.changed(item.ownerAuthorId);
        continue;
      }
      let result: CommunityDeliveryResult;
      try {
        result = await this.delivery.deliver(item, () => this.authority.canDeliver(item));
      } catch (error) {
        result = {
          kind: 'retry',
          reason: error instanceof Error ? error.message : 'network delivery failed',
        };
      }
      if (result.kind === 'confirmed') {
        this.store.confirm(item.id, result.remoteEntryId);
        this.changes?.changed(item.ownerAuthorId);
      } else if (result.kind === 'stopped') {
        this.store.stop([item.id], result.reason);
        this.changes?.changed(item.ownerAuthorId);
      } else if (result.kind === 'permanent') {
        this.store.fail(item.id, result.reason);
        this.changes?.changed(item.ownerAuthorId);
      } else {
        const attempts = item.attempts + 1;
        this.store.retry(
          item.id,
          attempts,
          new Date(this.now() + retryDelayMs(attempts)).toISOString()
        );
        this.changes?.changed(item.ownerAuthorId);
      }
    }
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
