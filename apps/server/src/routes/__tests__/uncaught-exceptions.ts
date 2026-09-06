/**
 * Catch what a route throws where no request can see it.
 *
 * A stream that faults after the response has been decided does not fail the
 * request — it emits `error`, and with no listener that is a process-level
 * uncaught exception. Vitest reports one as an unhandled error and reds the
 * shard, but it does not attribute it to the test that caused it, so a test
 * written to prove the fault is absent has to intercept it itself.
 *
 * @module routes/__tests__/uncaught-exceptions
 */

/** A capture in progress. Always `stop()` it, in a `finally`. */
export interface UncaughtCapture {
  /** Everything `uncaughtException` delivered while the capture was armed. */
  readonly errors: Error[];
  /**
   * Wait for the fault to arrive, or give up.
   *
   * Resolves as soon as anything has been caught, so proving the bug is
   * instant; the timeout is only paid when nothing goes wrong, which is the
   * whole point of the assertion that follows.
   */
  settle(): Promise<void>;
  /** Put the process's own handlers back. */
  stop(): void;
}

/**
 * Arm an `uncaughtException` capture for the duration of one test.
 *
 * Vitest's own handler is removed for the window and restored by `stop()`, so
 * the fault lands here rather than being reported against whichever test the
 * runner happened to be inside.
 *
 * @param timeoutMs - How long `settle()` waits before concluding nothing faulted.
 */
export function captureUncaughtExceptions(timeoutMs = 250): UncaughtCapture {
  const errors: Error[] = [];
  const displaced = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  const handler = (err: Error): void => {
    errors.push(err);
  };
  process.on('uncaughtException', handler);

  return {
    errors,
    async settle() {
      const deadline = Date.now() + timeoutMs;
      while (errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    stop() {
      process.off('uncaughtException', handler);
      for (const listener of displaced) process.on('uncaughtException', listener);
    },
  };
}
