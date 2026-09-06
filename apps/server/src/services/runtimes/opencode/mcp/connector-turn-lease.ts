/**
 * Abortable FIFO leases for OpenCode turns that reconcile connector state.
 *
 * OpenCode stores one MCP registration per directory. A connector bearer is
 * bound to one DorkOS session, so no other turn in the same directory may
 * reconcile that shared registration while either turn is live. This manager
 * serializes only equal canonical directory keys; unrelated directories remain
 * parallel.
 *
 * @module services/runtimes/opencode/mcp/connector-turn-lease
 */

/** One acquired directory turn lease. Release is safe to call more than once. */
export interface ConnectorTurnLease {
  /** Release the directory for the next queued turn. */
  release(): void;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (lease: ConnectorTurnLease) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
  granted: boolean;
}

interface DirectoryQueue {
  active: Waiter | undefined;
  readonly waiting: Waiter[];
}

/** Create the standard cancellation error used by abortable platform APIs. */
function abortError(): Error {
  const error = new Error('Connector turn lease acquisition was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Serializes MCP reconciliation and turn execution by canonical directory.
 */
export class ConnectorTurnLeaseManager {
  private readonly queues = new Map<string, DirectoryQueue>();

  /**
   * Acquire a directory lease in FIFO order.
   *
   * A cancelled waiter is removed without consuming the next grant. Aborting an
   * already acquired lease does not release it automatically; the turn's
   * `finally` owns cleanup so revocation can complete before handoff.
   *
   * @param canonicalCwd - Directory identity returned by the OpenCode sidecar.
   * @param signal - Turn cancellation signal.
   * @returns The acquired lease.
   */
  acquire(canonicalCwd: string, signal: AbortSignal): Promise<ConnectorTurnLease> {
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise<ConnectorTurnLease>((resolve, reject) => {
      const queue = this.queues.get(canonicalCwd) ?? { active: undefined, waiting: [] };
      this.queues.set(canonicalCwd, queue);

      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        granted: false,
        onAbort: () => {
          if (waiter.granted) return;
          const index = queue.waiting.indexOf(waiter);
          if (index >= 0) queue.waiting.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortError());
          this.deleteIfEmpty(canonicalCwd, queue);
        },
      };

      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (queue.active) {
        queue.waiting.push(waiter);
      } else {
        this.grant(canonicalCwd, queue, waiter);
      }
    });
  }

  private grant(canonicalCwd: string, queue: DirectoryQueue, waiter: Waiter): void {
    waiter.granted = true;
    queue.active = waiter;
    waiter.signal.removeEventListener('abort', waiter.onAbort);

    let released = false;
    waiter.resolve({
      release: () => {
        if (released) return;
        released = true;
        if (queue.active !== waiter) return;
        queue.active = undefined;

        let next = queue.waiting.shift();
        while (next?.signal.aborted) {
          next.signal.removeEventListener('abort', next.onAbort);
          next.reject(abortError());
          next = queue.waiting.shift();
        }
        if (next) this.grant(canonicalCwd, queue, next);
        else this.deleteIfEmpty(canonicalCwd, queue);
      },
    });
  }

  private deleteIfEmpty(canonicalCwd: string, queue: DirectoryQueue): void {
    if (!queue.active && queue.waiting.length === 0) this.queues.delete(canonicalCwd);
  }
}
