/**
 * Main-listener admission state, independent of active work or resource disposal.
 *
 * @module server/services/core/lifecycle/main-request-admission
 */

/** Passive, process-local gate shared by HTTP requests and WebSocket upgrades. */
export class MainRequestAdmission {
  private closed = false;

  /** Whether new main-listener work must be refused. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Permanently close admission without canceling or draining previously admitted work. */
  close(): void {
    this.closed = true;
  }
}
