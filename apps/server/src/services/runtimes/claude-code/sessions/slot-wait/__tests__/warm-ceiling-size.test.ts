import { describe, it, expect } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';

import { autoWarmCeiling, resolveMaxWarmSessions } from '../warm-ceiling-size.js';

const GB = 1024 ** 3;

/** A config reader whose `runtimes.claudeCode.maxWarmProcesses` is `value`. */
function configWith(value: number | null) {
  return {
    get: (() => ({ claudeCode: { maxWarmProcesses: value } })) as unknown as <
      K extends keyof UserConfig,
    >(
      key: K
    ) => UserConfig[K],
  };
}

describe('autoWarmCeiling', () => {
  // Purpose: the machine from DOR-3012. 48 GB fit 24 processes with room to
  // spare; the old fixed twelve refused seven agents at once.
  it('gives a 48 GB machine 24 slots', () => {
    expect(autoWarmCeiling(48 * GB)).toBe(24);
  });

  // Purpose: a small machine never drops below the old ceiling, which is what
  // every install has run on until now.
  it('never goes below 12', () => {
    expect(autoWarmCeiling(8 * GB)).toBe(12);
  });

  // Purpose: a very large machine is still bounded.
  it('never goes above 32', () => {
    expect(autoWarmCeiling(256 * GB)).toBe(32);
  });
});

describe('resolveMaxWarmSessions', () => {
  // Purpose: a number the person set wins over the machine's size.
  it('uses a pinned number', () => {
    expect(resolveMaxWarmSessions(configWith(5), 48 * GB)).toBe(5);
  });

  // Purpose: `null`, the default, sizes the ceiling to the machine.
  it('sizes to the machine when unset', () => {
    expect(resolveMaxWarmSessions(configWith(null), 48 * GB)).toBe(24);
  });

  // Purpose: a config that cannot be read still gives a usable ceiling.
  it('sizes to the machine when the config cannot be read', () => {
    const broken = {
      get: (() => {
        throw new Error('no config');
      }) as unknown as <K extends keyof UserConfig>(key: K) => UserConfig[K],
    };
    expect(resolveMaxWarmSessions(broken, 48 * GB)).toBe(24);
  });
});
