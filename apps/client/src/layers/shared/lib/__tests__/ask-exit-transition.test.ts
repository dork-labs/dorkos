import { describe, it, expect } from 'vitest';
import { askExitTransition, MELT_S, RESOLVE_HOLD_S } from '../ask-exit-transition';

describe('askExitTransition', () => {
  it('holds an answered card long enough to read its checkmark', () => {
    expect(askExitTransition({ decided: true, reducedMotion: false })).toEqual({
      delay: RESOLVE_HOLD_S,
      duration: MELT_S,
    });
  });

  it('keeps the hold under reduced motion, and drops only the melt', () => {
    // The hold is feedback and the melt is decoration. Removing the hold too
    // would make a checkmark nobody had time to read — that is a missing
    // interface, not a calmer one.
    expect(askExitTransition({ decided: true, reducedMotion: true })).toEqual({
      delay: RESOLVE_HOLD_S,
      duration: 0,
    });
  });

  it('lets a card that was never answered here go straight away', () => {
    // It expired, or somebody answered it in another window: there is no
    // checkmark on it to hold.
    expect(askExitTransition({ decided: false, reducedMotion: false })).toEqual({
      delay: 0,
      duration: MELT_S,
    });
    expect(askExitTransition({ decided: false, reducedMotion: true })).toEqual({
      delay: 0,
      duration: 0,
    });
  });
});
