import { describe, it, expect, vi, afterEach } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';

import { logger } from '../../../../../../lib/logger.js';
import { autoWarmCeiling, resolveMaxWarmSessions } from '../warm-ceiling-size.js';

const GB = 1024 ** 3;

/**
 * A config reader whose `runtimes.claudeCode.maxWarmProcesses` is `value` and
 * whose `runtimes.maxAgentChats` is `chats`.
 */
function configWith(value: number | null, chats?: number) {
  return {
    get: (() => ({
      claudeCode: { maxWarmProcesses: value },
      ...(chats === undefined ? {} : { maxAgentChats: chats }),
    })) as unknown as <K extends keyof UserConfig>(key: K) => UserConfig[K],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('resolveMaxWarmSessions and the agent chat cap (DOR-4498)', () => {
  // Purpose: unset, the ceiling keeps a warm process for every chat agents may
  // run, so chats under the cap do not take each other's processes.
  it('rises to maxAgentChats when that is above the machine size', () => {
    expect(resolveMaxWarmSessions(configWith(null, 28), 48 * GB)).toBe(28);
  });

  // Purpose: the automatic bound still holds over a very high chat cap.
  it('stays within the automatic bound', () => {
    expect(resolveMaxWarmSessions(configWith(null, 40), 48 * GB)).toBe(32);
  });

  // Purpose: a chat cap below the machine size changes nothing.
  it('keeps the machine size when the chat cap is lower', () => {
    expect(resolveMaxWarmSessions(configWith(null, 8), 48 * GB)).toBe(24);
  });

  // Purpose: what a person set is never overridden. A pin below the chat cap is
  // kept, and said once per change, not on every launch.
  it('keeps a pin below the chat cap and warns once per change', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveMaxWarmSessions(configWith(14, 20), 48 * GB)).toBe(14);
    expect(resolveMaxWarmSessions(configWith(14, 20), 48 * GB)).toBe(14);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('warm processes (14) is below agent chats (20)');

    expect(resolveMaxWarmSessions(configWith(15, 20), 48 * GB)).toBe(15);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // Purpose: a pin at or above the chat cap is fine and says nothing.
  it('stays quiet when the pin covers the chat cap', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(resolveMaxWarmSessions(configWith(20, 20), 48 * GB)).toBe(20);
    expect(warn).not.toHaveBeenCalled();
  });
});
