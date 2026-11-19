/**
 * Where the load gate reads how busy the machine is (DOR-4209).
 *
 * @module services/core/load-gate/load-source
 */
import os from 'node:os';

/** Something that answers how busy this machine is right now. */
export interface LoadSource {
  /** The five-minute load average, as `uptime` prints it. */
  fiveMinute(): number;
}

/** Where `os.loadavg()` keeps the five-minute figure. */
const FIVE_MINUTE_INDEX = 1;

/**
 * The machine's own load average. On Windows, where Node reports zeros, the
 * gate never sees the machine as busy and only the slot count holds jobs back.
 */
export const systemLoadSource: LoadSource = {
  fiveMinute: () => os.loadavg()[FIVE_MINUTE_INDEX] ?? 0,
};

/** A load source a test sets by hand. */
export interface FixedLoadSource extends LoadSource {
  /**
   * Change the load every later reading returns.
   *
   * @param load - The new five-minute load average.
   */
  set(load: number): void;
}

/**
 * A load source that returns whatever it was last set to, for tests.
 *
 * @param initial - The load it reports until {@link FixedLoadSource.set} changes it.
 */
export function fixedLoadSource(initial: number): FixedLoadSource {
  let load = initial;
  return {
    fiveMinute: () => load,
    set: (next) => {
      load = next;
    },
  };
}
