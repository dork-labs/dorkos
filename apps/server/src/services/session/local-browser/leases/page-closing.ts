import { responseDeadline, CLOSE_RESPONSE_TIMEOUT_MS, closingError } from '../lifecycle.js';

/** A timeout never releases a physical close; failures retain the reservation until restart. */
export class BrowserPageClosing {
  private pending?: Promise<void>;
  private failed = false;
  private completed?: Promise<void>;

  get active(): boolean {
    return !!this.pending;
  }

  /** An opaque receipt is true only for this exact close settling successfully. */
  capture(): (() => boolean) | undefined {
    const pending = this.pending;
    return pending ? () => !this.failed && this.completed === pending : undefined;
  }

  /** New work cannot pass a close that is pending or failed. */
  assertAvailable(): void {
    if (this.pending) throw closingError(this.failed);
  }

  /** Fence synchronously, then keep one teardown promise through every bounded response. */
  async run(fence: () => void, release: () => Promise<void>): Promise<void> {
    if (!this.pending) {
      fence();
      const pending = Promise.resolve().then(release);
      this.pending = pending;
      void pending
        .then(() => {
          if (this.pending === pending) {
            this.completed = pending;
            this.pending = undefined;
          }
        })
        .catch(() => {
          this.failed = true;
        });
    }
    await responseDeadline(this.pending, CLOSE_RESPONSE_TIMEOUT_MS, () =>
      closingError(this.failed)
    ).catch(() => {
      throw closingError(this.failed);
    });
  }
}
