/**
 * Wait for a promise, but only so long. Split out of
 * `extension-server-lifecycle.ts`, which uses it for `register()`, to keep
 * that file under its size limit.
 *
 * @module services/extensions/settle-within
 */

/**
 * Wait for `promise`, but no longer than `ms`.
 *
 * @param promise - What to wait for.
 * @param ms - The longest to wait.
 * @returns Its value, or that it did not settle in time (with the promise, so
 *   the caller can clean up whatever it resolves to later).
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ timedOut: false; value: T } | { timedOut: true; late: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([promise.then((value) => ({ value })), timeout]);
    if (first === 'timeout') return { timedOut: true, late: promise };
    return { timedOut: false, value: first.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
