import { BrowserLifecycleError } from './errors.js';

/** Bound a fallible operation without claiming cancellation undoes its effects. */
export async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  code: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserLifecycleError(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait only between authoritative process observations. */
export const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Parent waits share an absolute host-monotonic end; elapsed waits never create a new budget. */
export async function until<T>(operation: Promise<T>, end: number, code: string): Promise<T> {
  // Expired admission still owns rejection observation of this already-created original.
  void operation.catch(() => {});
  const remaining = end - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new BrowserLifecycleError(code);
  const value = await deadline(operation, remaining, code);
  if (performance.now() >= end) throw new BrowserLifecycleError(code);
  return value;
}
