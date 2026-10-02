/**
 * Wait between observations without changing the subject under measurement.
 * @param ms - Delay in milliseconds.
 * @returns A promise resolving after the delay.
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Bound an observation wait; callers retain responsibility for cleaning its underlying resource.
 * @param promise - Operation whose completion to observe; timing out does not cancel it.
 * @param ms - Maximum wait in milliseconds.
 * @returns The operation result when it completes before the deadline.
 * @throws A fixed GATE_TIMEOUT error if the wait expires.
 */
export async function bounded(promise, ms = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('GATE_TIMEOUT')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
