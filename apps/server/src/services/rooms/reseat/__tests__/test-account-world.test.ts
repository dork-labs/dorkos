/**
 * The forced-limit seam (DOR-3143) is inert outside the test runtime: nothing
 * can set a world there, and with no world every reader is a no-op, so the
 * production limit, account and ranking paths run untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { storedUsageLimit } from '../../notices/usage-limit.js';
import { createTestAccountWorldRoutes } from '../../../../routes/test-account-world.js';
import {
  forcedLimitFor,
  hasTestAccountWorld,
  noteTestWorldLaunch,
  setTestAccountWorld,
  testWorldLimitOf,
  testWorldRanking,
  testWorldSeatAccount,
} from '../test-account-world.js';
import { forcedLimitScenario } from '../forced-limit-turn.js';

const WORLD = {
  accounts: [{ id: 'claude4' }, { id: 'claude3' }],
  startAccount: 'claude4',
  force: { accountId: 'claude4', at: 'turn-start' as const },
};

afterEach(() => setTestAccountWorld(null, true));

describe('outside the test runtime', () => {
  it('refuses to set a world, and every reader stays a no-op', () => {
    expect(() => setTestAccountWorld(WORLD, false)).toThrow(/only available to the test runtime/);
    expect(hasTestAccountWorld()).toBe(false);
    noteTestWorldLaunch('s1', undefined);
    expect(forcedLimitFor('s1')).toBeNull();
    expect(testWorldLimitOf('s1')).toBeNull();
    expect(testWorldRanking()).toBeNull();
    expect(testWorldSeatAccount('s1')).toBeNull();
    expect(forcedLimitScenario('s1', undefined)).toBeUndefined();
    expect(storedUsageLimit('s1')).toBeNull();
  });

  it('refuses the route with 403 and sets nothing', async () => {
    const res = await createTestAccountWorldRoutes(false).request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(WORLD),
    });
    expect(res.status).toBe(403);
    expect(hasTestAccountWorld()).toBe(false);
  });
});

describe('under the test runtime', () => {
  it('forces the named account out on its first turn, and reports the limit after', () => {
    setTestAccountWorld(WORLD, true);
    expect(testWorldLimitOf('s1')).toBeNull();
    expect(forcedLimitScenario('s1', undefined)).toBeDefined();
    expect(testWorldLimitOf('s1')).not.toBeNull();
    expect(storedUsageLimit('s1')).not.toBeNull();
    expect(testWorldRanking()?.map((row) => [row.id, row.eligible])).toEqual([
      ['claude4', false],
      ['claude3', true],
    ]);
  });

  it('runs a moved session on the account it was hinted onto, with no forced limit there', () => {
    setTestAccountWorld(WORLD, true);
    expect(forcedLimitScenario('moved', { accountHint: 'claude3' })).toBeUndefined();
    expect(testWorldSeatAccount('moved')?.id).toBe('claude3');
    expect(testWorldLimitOf('moved')).toBeNull();
  });
});
