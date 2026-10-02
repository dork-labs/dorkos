export const INPUT_BUDGET_MS = 2000;

/** Host monotonic deadline, independent of frozen/regressing application clocks. */
export class InputDeadline extends Error {
  constructor() {
    super('INPUT_DEADLINE');
    this.name = 'InputDeadline';
  }
}

/** Bound a wait and still observe late rejection, without claiming cancellation or settlement. */
export async function within<T>(
  promise: Promise<T>,
  end: number,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => reject(new InputDeadline());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => reject(new InputDeadline()), Math.max(0, end - performance.now()));
    });
    const result = await Promise.race([promise, cancellation]);
    if (performance.now() >= end || signal?.aborted) throw new InputDeadline();
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
