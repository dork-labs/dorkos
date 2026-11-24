/** DOR-4626: a crash loop spends the chat's room-recovery record under every id the chat answers to. */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSeatFailures } from '@dorkos/db';
import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import type { FailedSeatRecord } from '../../../../rooms/reseat/failed-seat-ledger.js';
import { SessionCrashRecovery } from '../session-crash-recovery.js';

const RECORD: FailedSeatRecord = {
  dispatchId: 'dsp_failed',
  entryId: 'entry-1',
  root: '/fixture/account',
  inference: 'own-account',
  billing: 'subscription',
  carry: {
    externalAuthor: true,
    permissionCeiling: { asks: 'always', reach: 'read', outsider: true },
  },
};

const crash = (sessionId: string) => ({
  sessionId,
  stateAtCrash: 'running' as const,
  error: new Error('fixture process died'),
});

/** A crash policy whose process is filed under the first id, after the SDK re-minted its id. */
function policyFor(key: string, sdkId: string) {
  return new SessionCrashRecovery({
    sessionId: key,
    aliases: () => [sdkId],
    pump: { state: 'running' },
    windows: {
      onCrash() {},
      dispatch: async () => {
        throw new Error('fixture never dispatches');
      },
    },
  });
}

afterEach(() => {
  runtimeRegistry.setDb(createTestDb());
});

describe('crash-loop refusal of a failed room chat', () => {
  it('spends the record written under the re-minted id when the process key differs', () => {
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    runtimeRegistry.requiredLaunches().failures.record('sdk-new', RECORD);
    const policy = policyFor('request-key', 'sdk-new');
    policy.handleCrash(crash('request-key'));
    const consumed = () =>
      db.select().from(roomSeatFailures).where(eq(roomSeatFailures.sessionId, 'sdk-new')).get()
        ?.consumedAt;
    // One crash still relaunches: nothing is refused yet.
    expect(consumed()).toBeNull();
    policy.handleCrash(crash('request-key'));
    expect(policy.willAutoResume).toBe(false);
    expect(consumed()).toEqual(expect.any(Number));
  });
});
