import { describe, expect, it } from 'vitest';

import { decideIdentity } from '../identity-decision';

describe('decideIdentity', () => {
  it('identifies a signed-in, opted-in visitor once, then holds', () => {
    const first = decideIdentity({ userId: 'acct-1', optedOut: false, identified: false });
    expect(first).toEqual({ action: 'identify', identified: true });
    // A subsequent tick with the same state does not re-identify.
    expect(decideIdentity({ userId: 'acct-1', optedOut: false, identified: true })).toEqual({
      action: 'none',
      identified: true,
    });
  });

  it('never identifies a signed-in but opted-out (cookieless floor) visitor', () => {
    expect(decideIdentity({ userId: 'acct-1', optedOut: true, identified: false })).toEqual({
      action: 'none',
      identified: false,
    });
  });

  it('re-identifies after a decline-then-accept while staying signed in', () => {
    // Opt out clears the identified flag (SDK reset), so a later opt-in re-identifies.
    const declined = decideIdentity({ userId: 'acct-1', optedOut: true, identified: true });
    expect(declined).toEqual({ action: 'none', identified: false });
    expect(
      decideIdentity({ userId: 'acct-1', optedOut: false, identified: declined.identified })
    ).toEqual({ action: 'identify', identified: true });
  });

  it('resets exactly once on logout, then holds', () => {
    const loggedOut = decideIdentity({ userId: null, optedOut: false, identified: true });
    expect(loggedOut).toEqual({ action: 'reset', identified: false });
    // Still logged out on the next tick: no repeated reset (which would churn the anon id).
    expect(decideIdentity({ userId: null, optedOut: false, identified: false })).toEqual({
      action: 'none',
      identified: false,
    });
  });

  it('does nothing for an anonymous visitor who was never identified', () => {
    expect(decideIdentity({ userId: null, optedOut: false, identified: false })).toEqual({
      action: 'none',
      identified: false,
    });
  });
});
