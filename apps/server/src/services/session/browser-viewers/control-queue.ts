import { BrowserViewerError } from './viewer-contract.js';

/** One bounded logical queue per Page. Physical ownership remains in BrowserPageWork. */
export class ViewerControlQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private tokens = 120;
  private updatedAt = Date.now();
  submit<T>(operation: () => Promise<T>): Promise<T> {
    const admittedAt = Date.now();
    this.tokens = Math.min(
      120,
      this.tokens + (Math.max(0, admittedAt - this.updatedAt) * 60) / 1000
    );
    this.updatedAt = Math.max(admittedAt, this.updatedAt);
    if (this.pending >= 64 || this.tokens < 1) throw new BrowserViewerError('viewer_busy');
    this.tokens--;
    this.pending++;
    const result = this.tail.then(() => {
      if (Date.now() - admittedAt > 2000) throw new BrowserViewerError('viewer_stale');
      return operation();
    });
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
    return result;
  }
}
