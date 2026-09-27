import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import { moveAccountReferences } from '../account-reference-move.js';

describe('moveAccountReferences', () => {
  it('says once, not on every scan, that the agent registry is not running', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const sites = {
      agents: undefined,
      renameScheduleAccount: vi.fn(),
    };
    const renames = [{ from: 'default', to: 'default-2' }];
    expect(await moveAccountReferences(renames, sites)).toBe(false);
    expect(await moveAccountReferences(renames, sites)).toBe(false);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('agent registry'))).toHaveLength(1);
    expect(sites.renameScheduleAccount).not.toHaveBeenCalled();
  });
});
