import { describe, expect, it } from 'vitest';
import { DetachedTurnLifecycle } from '../trigger-turn.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  isOriginalNativeSessionAcquisitionAlias,
} from '../session-lock.js';

describe('original launch alias acquisition', () => {
  it('requires the exact current launching holder and refuses a separately held retired key', () => {
    const manager = new SessionLockManager();
    const launching = new DetachedTurnLifecycle();
    const other = new DetachedTurnLifecycle();
    const token = Symbol('original launching acquisition');
    let failed = false,
      first: unknown;
    try {
      expect(manager.acquireLock('canonical', 'launching', launching, token)).toBe(true);
      const acquired = captureNativeSessionAcquisition(manager, 'canonical', launching);
      expect(acquired).toBeDefined();
      if (!acquired) throw new Error('Actual launching acquisition missing');
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, launching, 'canonical', 'old')
      ).toBe(true);
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, other, 'canonical', 'old')
      ).toBe(false);
      expect(
        isOriginalNativeSessionAcquisitionAlias(
          new SessionLockManager(),
          acquired,
          launching,
          'canonical',
          'old'
        )
      ).toBe(false);
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, launching, 'different', 'old')
      ).toBe(false);
      expect(
        isOriginalNativeSessionAcquisitionAlias(
          manager,
          acquired,
          launching,
          'canonical',
          'canonical'
        )
      ).toBe(false);
      expect(
        manager.acquireLock('old', 'other', other, Symbol('independent old acquisition'))
      ).toBe(true);
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, launching, 'canonical', 'old')
      ).toBe(false);
      other.close();
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, launching, 'canonical', 'old')
      ).toBe(true);
      launching.close();
      expect(
        isOriginalNativeSessionAcquisitionAlias(manager, acquired, launching, 'canonical', 'old')
      ).toBe(false);
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      for (const holder of [launching, other]) {
        try {
          holder.close();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      }
    }
    if (failed) throw first;
  });
});
