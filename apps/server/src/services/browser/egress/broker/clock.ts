import { BrokerError } from './errors.js';
/** Monotonic authority fails permanently on an invalid, throwing or regressing sample. */
export function checkedClock(read: () => number, onFailure: () => void) {
  let last = -1;
  let failed = false;
  return () => {
    if (failed) throw new BrokerError('CLOCK_UNVERIFIED');
    let current: number;
    try {
      current = read();
    } catch {
      current = NaN;
    }
    if (failed) throw new BrokerError('CLOCK_UNVERIFIED');
    if (!Number.isSafeInteger(current) || current < last || current < 0) {
      failed = true;
      onFailure();
      throw new BrokerError('CLOCK_UNVERIFIED');
    }
    last = current;
    return current;
  };
}
/** A caller deadline does not settle an ignored acquisition; ownership stays with its registry. */
export async function bounded<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrokerError('TIMEOUT')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
