import { describe, it, expect } from 'vitest';
import { createMockSessionLimit } from '@dorkos/test-utils';
import { sessionLimitDisplay, sessionLimitText } from '../session-limit-text';

describe('sessionLimitText', () => {
  it('says "out · handing off" while the work is about to move on its own', () => {
    expect(sessionLimitText(createMockSessionLimit('auto'))).toBe('out · handing off');
  });

  it.each(['limited', 'wait-only', 'all-accounts-out', 'model-limited'] as const)(
    'says "out · needs you" for an account-wide `%s` limit that waits on the person',
    (state) => {
      expect(sessionLimitText(createMockSessionLimit('ask', { scope: 'account', state }))).toBe(
        'out · needs you'
      );
    }
  );

  it.each(['waiting-reset', 'reset-ready'] as const)(
    'says "out · waiting for reset" once the person chose to wait (`%s`)',
    (state) => {
      expect(sessionLimitText(createMockSessionLimit('waiting', { scope: 'account', state }))).toBe(
        'out · waiting for reset'
      );
    }
  );

  it('says nothing for a moved session (Q14)', () => {
    expect(sessionLimitText(createMockSessionLimit('continued'))).toBeNull();
  });

  it('says nothing for a limit on one model, in any state', () => {
    expect(
      sessionLimitText(createMockSessionLimit('ask', { scope: 'model', state: 'model-limited' }))
    ).toBeNull();
    expect(sessionLimitText(createMockSessionLimit('waiting', { scope: 'model' }))).toBeNull();
    expect(sessionLimitText(createMockSessionLimit('auto', { scope: 'model' }))).toBeNull();
  });

  it('says nothing without a limit', () => {
    expect(sessionLimitText(null)).toBeNull();
    expect(sessionLimitText(undefined)).toBeNull();
  });

  it('reads an older server’s limit (no `state`, no `scope`) from its plan', () => {
    const { state: _state, scope: _scope, ...older } = createMockSessionLimit('auto');
    expect(sessionLimitText(older as never)).toBe('out · handing off');
  });
});

describe('sessionLimitDisplay', () => {
  it.each(['limited', 'wait-only', 'all-accounts-out', 'handing-off'] as const)(
    'needs action in `%s` (the red tint, Q13)',
    (state) => {
      expect(sessionLimitDisplay(createMockSessionLimit('ask', { state }))?.needsAction).toBe(true);
    }
  );

  it.each(['waiting-reset', 'reset-ready'] as const)(
    'no longer needs action in `%s` (neutral, Q13)',
    (state) => {
      expect(sessionLimitDisplay(createMockSessionLimit('waiting', { state }))?.needsAction).toBe(
        false
      );
    }
  );
});
