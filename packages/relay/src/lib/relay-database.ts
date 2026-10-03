/** One resolved handle for the derived index and authoritative receipt observer. */
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { DeliveryReceiptStore } from '../delivery-receipt-store.js';

/** Caller-injected handles stay open; standalone handles close after observer release. */
export class RelayDatabase {
  readonly db: Db;
  readonly receipts: DeliveryReceiptStore;
  private readonly owned: boolean;
  private closed = false;
  private cleanupSteps?: (() => void | Promise<void>)[];
  private cleanupIndex = 0;
  private closing: Promise<void> | null = null;
  private cleanupComplete = false;

  constructor(path: string, options?: { db?: Db; receiptNow?: () => number }) {
    this.owned = !options?.db;
    this.db = options?.db ?? createDb(path);
    if (this.owned) {
      try {
        runMigrations(this.db);
      } catch (error) {
        this.db.$client.close();
        throw error;
      }
    }
    this.receipts = new DeliveryReceiptStore(this.db, { now: options?.receiptNow });
  }

  /** Coalesce close calls and retry only the first unfinished cleanup step. */
  close(steps: (() => void | Promise<void>)[]): Promise<void> {
    if (this.cleanupComplete) return Promise.resolve();
    if (this.closing) return this.closing;
    this.cleanupSteps ??= steps;
    this.closing = this.finishClose().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    this.receipts.close();
    const steps = this.cleanupSteps!;
    while (this.cleanupIndex < steps.length) {
      await steps[this.cleanupIndex]();
      this.cleanupIndex++;
    }
    this.closeOwnedHandle();
    this.cleanupComplete = true;
  }

  /** Called only after successful observer release and Relay shutdown. */
  private closeOwnedHandle(): void {
    if (this.owned && !this.closed) {
      this.db.$client.close();
      this.closed = true;
    }
  }
}
