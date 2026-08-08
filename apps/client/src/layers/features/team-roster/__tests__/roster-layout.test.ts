/**
 * The one decision that arms the roster's layout animation.
 *
 * It is a pure function rather than an inline expression for a testing reason
 * the design spec names outright (§4.3): `test-setup.ts` strips `layout`,
 * `layoutId`, `initial`, `animate` and `exit` from every `motion.*` component,
 * so **no motion prop can be asserted in jsdom, ever**. A test that appears to
 * check one is checking nothing. Pulling the gate out means the rule itself is
 * assertable at full strength, and the component test only has to prove it is
 * wired to the same boolean the attribute reports.
 */
import { describe, it, expect } from 'vitest';
import { ROSTER_LAYOUT_LIMIT, shouldAnimateRoster } from '../lib/roster-layout';

describe('shouldAnimateRoster', () => {
  it('animates a roster small enough to stay calm', () => {
    expect(shouldAnimateRoster({ memberCount: 3, reducedMotion: false })).toBe(true);
  });

  it('animates right up to the limit, and stops one card past it', () => {
    // The pair is the point: a boundary asserted on one side only cannot tell a
    // `<=` from a `<`, which is the exact mistake this rule invites.
    expect(shouldAnimateRoster({ memberCount: ROSTER_LAYOUT_LIMIT, reducedMotion: false })).toBe(
      true
    );
    expect(
      shouldAnimateRoster({ memberCount: ROSTER_LAYOUT_LIMIT + 1, reducedMotion: false })
    ).toBe(false);
  });

  it('is off under reduced motion however small the roster is', () => {
    // Not "shorter" — off. `motion/react` writes inline styles from JS, so the
    // global CSS reset in `index.css` never touches it; a card teleporting
    // 400px in 10ms is worse than a card that does not move (spec §2.6).
    expect(shouldAnimateRoster({ memberCount: 3, reducedMotion: true })).toBe(false);
    expect(shouldAnimateRoster({ memberCount: 0, reducedMotion: true })).toBe(false);
  });

  it('lets reduced motion win over a roster the size alone would animate', () => {
    // The two gates are AND, not OR — the preference is not a tiebreak.
    expect(shouldAnimateRoster({ memberCount: 1, reducedMotion: true })).toBe(false);
  });

  it('bounds the limit where a 3-column grid stops fitting a couple of screens', () => {
    expect(ROSTER_LAYOUT_LIMIT).toBe(120);
  });
});
