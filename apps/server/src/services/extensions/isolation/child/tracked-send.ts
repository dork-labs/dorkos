/**
 * Sending to the host while knowing when everything sent has been written
 * (DOR-2686). The child must not exit while its last messages are still
 * queued: on Windows the IPC pipe is asynchronous, so `process.exit` right
 * after `process.send` can drop what a stopping extension's cleanup just
 * sent. Every send is counted until Node calls its callback (written, or
 * failed), and {@link TrackedSend.whenDrained} resolves once none is left.
 *
 * @module services/extensions/isolation/child/tracked-send
 */

/** `process.send`'s shape, as far as this needs it. */
export type RawSend = (message: unknown, callback: (err: Error | null) => void) => unknown;

/** A counted sender. */
export interface TrackedSend {
  /**
   * Send one message. Throws (synchronously) when it cannot be serialized.
   *
   * @param onWritten - Called once Node has written it (or failed to), so a
   *   caller can apply backpressure to the channel.
   */
  send(message: unknown, onWritten?: () => void): void;
  /** Resolves once every message sent so far has been written or has failed. */
  whenDrained(): Promise<void>;
}

/**
 * Wrap a raw sender with a count of messages not yet written.
 *
 * @param raw - `process.send`, bound.
 */
export function createTrackedSend(raw: RawSend): TrackedSend {
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  const settle = () => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    send(message, onWritten) {
      inFlight++;
      try {
        raw(message, () => {
          settle();
          onWritten?.();
        });
      } catch (err) {
        settle();
        throw err;
      }
    },
    whenDrained() {
      if (inFlight === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
