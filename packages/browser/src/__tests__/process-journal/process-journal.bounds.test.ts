import { describe, expect, it, vi } from 'vitest';
import { JOURNAL_LIMITS, validateJournalSnapshot } from '../../lifecycle/process-journal.js';
import { binding, snapshot } from './process-journal.fixtures.js';

// Keep actual filesystem methods while exposing a configurable module for close-acknowledgement spies.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

/** Pure snapshot contract controls complement the real-filesystem cases above. */
describe('journal bounded retained generation data', () => {
  it('admits the full 512 identity cap and refuses cap+1 without silently dropping an old lifetime', () => {
    const full = snapshot();
    for (let i = 1; i < JOURNAL_LIMITS.identities; i++) {
      const identity = { pid: 1000 + i, birth: 'synthetic-child-' + i };
      const window = {
        startSequence: 0,
        checkpointSequence: 0,
        endSequence: 0,
        startMonotonic: 0,
        endMonotonic: 0,
      };
      full.retainedIdentities.push({
        identity,
        role: 'descendant',
        parent: binding.manager,
        currentParent: binding.manager,
        association: {
          parentBefore: binding.manager,
          parentAfter: binding.manager,
          child: identity,
          childParentPid: binding.manager.pid,
          window,
          recordedSequence: 0,
          parentDeathSequence: null,
        },
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 0,
        relationWindow: window,
        lifecycle: 'alive',
      });
    }
    expect(validateJournalSnapshot(full).retainedIdentities).toHaveLength(512);
    const overflow = {
      ...full,
      retainedIdentities: [
        ...full.retainedIdentities,
        {
          ...full.retainedIdentities[1]!,
          identity: { pid: 9999, birth: 'overflow' },
        },
      ],
    };
    expect(() => validateJournalSnapshot(overflow)).toThrow();
    expect(full.retainedIdentities).toHaveLength(512);
    expect(validateJournalSnapshot(full).retainedIdentities[1]!.identity.birth).toBe(
      'synthetic-child-1'
    );
  });
});
