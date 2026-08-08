import { describe, it, expect } from 'vitest';
import { approvalExitTransition, MELT_S, RESOLVE_HOLD_S } from '../lib/approval-exit-transition';

describe('approvalExitTransition', () => {
  it('holds an answered card long enough to read its checkmark', () => {
    expect(approvalExitTransition({ decided: true, reducedMotion: false })).toEqual({
      delay: RESOLVE_HOLD_S,
      duration: MELT_S,
    });
  });

  it('keeps the hold under reduced motion, and drops only the melt', () => {
    // The hold is feedback and the melt is decoration. Removing the hold too
    // would make a checkmark nobody had time to read — that is a missing
    // interface, not a calmer one.
    expect(approvalExitTransition({ decided: true, reducedMotion: true })).toEqual({
      delay: RESOLVE_HOLD_S,
      duration: 0,
    });
  });

  it('lets a card that was never answered here go straight away', () => {
    // It expired, or somebody answered it in another window: there is no
    // checkmark on it to hold.
    expect(approvalExitTransition({ decided: false, reducedMotion: false })).toEqual({
      delay: 0,
      duration: MELT_S,
    });
    expect(approvalExitTransition({ decided: false, reducedMotion: true })).toEqual({
      delay: 0,
      duration: 0,
    });
  });
});
