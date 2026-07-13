import { describe, expect, it } from 'vitest';

import { decideIdentity } from '../identity-decision';

describe('decideIdentity', () => {
  it('identifies a signed-in, opted-in visitor once, then holds', () => {
    const first = decideIdentity({ userId: 'acct-1', optedOut: false, identifiedUserId: null });
    expect(first).toEqual({ action: 'identify', identifiedUserId: 'acct-1' });
    // A subsequent tick with the same state does not re-identify.
    expect(
      decideIdentity({ userId: 'acct-1', optedOut: false, identifiedUserId: 'acct-1' })
    ).toEqual({ action: 'none', identifiedUserId: 'acct-1' });
  });

  it('never identifies a signed-in but opted-out (cookieless floor) visitor', () => {
    expect(decideIdentity({ userId: 'acct-1', optedOut: true, identifiedUserId: null })).toEqual({
      action: 'none',
      identifiedUserId: null,
    });
  });

  it('re-identifies after a decline-then-accept while staying signed in', () => {
    // Opt out clears the identified account (SDK reset), so a later opt-in re-identifies.
    const declined = decideIdentity({
      userId: 'acct-1',
      optedOut: true,
      identifiedUserId: 'acct-1',
    });
    expect(declined).toEqual({ action: 'none', identifiedUserId: null });
    expect(
      decideIdentity({
        userId: 'acct-1',
        optedOut: false,
        identifiedUserId: declined.identifiedUserId,
      })
    ).toEqual({ action: 'identify', identifiedUserId: 'acct-1' });
  });

  it('resets exactly once on logout, then holds', () => {
    const loggedOut = decideIdentity({
      userId: null,
      optedOut: false,
      identifiedUserId: 'acct-1',
    });
    expect(loggedOut).toEqual({ action: 'reset', identifiedUserId: null });
    // Still logged out on the next tick: no repeated reset (which would churn the anon id).
    expect(decideIdentity({ userId: null, optedOut: false, identifiedUserId: null })).toEqual({
      action: 'none',
      identifiedUserId: null,
    });
  });

  it('resets then identifies on a direct A→B account switch (no logged-out tick)', () => {
    // The shared-browser bleed case: account B signs in while account A is still
    // the identified person. A boolean "identified" flag would return 'none'
    // here and attribute B's events to A; tracking the id catches it.
    expect(
      decideIdentity({ userId: 'acct-B', optedOut: false, identifiedUserId: 'acct-A' })
    ).toEqual({ action: 'reset-then-identify', identifiedUserId: 'acct-B' });
    // And the next tick holds steady as B.
    expect(
      decideIdentity({ userId: 'acct-B', optedOut: false, identifiedUserId: 'acct-B' })
    ).toEqual({ action: 'none', identifiedUserId: 'acct-B' });
  });

  it('does nothing for an anonymous visitor who was never identified', () => {
    expect(decideIdentity({ userId: null, optedOut: false, identifiedUserId: null })).toEqual({
      action: 'none',
      identifiedUserId: null,
    });
  });
});
