/**
 * @vitest-environment jsdom
 *
 * Renders the real AnalyticsIdentity bridge and asserts the ACTUAL
 * identify/reset call sequence through the full shared-browser story:
 * login → consent accept → logout → re-login as a DIFFERENT user — including
 * the direct A→B account switch (no logged-out tick), the exact case a
 * boolean identified-flag would miss and bleed B's events into A's person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';

import { AnalyticsIdentity } from '../AnalyticsIdentity';

// Analytics spies — the bridge talks to @/lib/analytics, never posthog-js
// directly. `optedOut` models PostHog's live capture state; the real
// CONSENT_CHANGED_EVENT name is re-created here (a string constant) so the
// component's listener wiring runs for real.
const identifyAccount = vi.fn();
const resetIdentity = vi.fn();
let optedOut = true;

vi.mock('@/lib/analytics', () => ({
  CONSENT_CHANGED_EVENT: 'dorkos:consent-changed',
  identifyAccount: (...args: unknown[]) => identifyAccount(...args),
  resetIdentity: () => resetIdentity(),
  hasOptedOutCapturing: () => optedOut,
}));

// Session mock — a mutable holder the component reads through useSession();
// rerender() re-evaluates it, modeling Better Auth session transitions.
let sessionUserId: string | null = null;

vi.mock('@/lib/auth-client', () => ({
  useSession: () => ({
    data: sessionUserId ? { user: { id: sessionUserId } } : null,
    isPending: false,
    error: null,
    refetch: () => {},
  }),
}));

/** Interleaved call log so the tests assert ORDER, not just counts. */
function callSequence(): string[] {
  const calls = [
    ...identifyAccount.mock.invocationCallOrder.map((order, i) => ({
      order,
      label: `identify:${identifyAccount.mock.calls[i][0]}`,
    })),
    ...resetIdentity.mock.invocationCallOrder.map((order) => ({ order, label: 'reset' })),
  ];
  return calls.sort((a, b) => a.order - b.order).map((c) => c.label);
}

function flipConsent(nowOptedOut: boolean) {
  optedOut = nowOptedOut;
  act(() => {
    window.dispatchEvent(new Event('dorkos:consent-changed'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUserId = null;
  optedOut = true;
});

describe('AnalyticsIdentity', () => {
  it('drives the full sequence: login → accept → logout → login as another user', () => {
    // Anonymous, opted out: mount does nothing.
    const { rerender } = render(<AnalyticsIdentity />);
    expect(callSequence()).toEqual([]);

    // Login as A while still opted out: still nothing (Tier 2 invariant).
    sessionUserId = 'acct-A';
    rerender(<AnalyticsIdentity />);
    expect(callSequence()).toEqual([]);

    // Consent accepted: identify A exactly once.
    flipConsent(false);
    expect(callSequence()).toEqual(['identify:acct-A']);

    // A stray re-render with unchanged state does not re-identify.
    rerender(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A']);

    // Logout: reset once, no identify.
    sessionUserId = null;
    rerender(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A', 'reset']);

    // Re-login as B (still opted in): identify B — no stale-A reset needed,
    // the logout already severed A.
    sessionUserId = 'acct-B';
    rerender(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A', 'reset', 'identify:acct-B']);
  });

  it('resets THEN identifies on a direct A→B switch with no logged-out tick', () => {
    sessionUserId = 'acct-A';
    optedOut = false;
    const { rerender } = render(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A']);

    // The session flips straight from A to B (e.g. another tab signed B in and
    // useSession revalidated) — the bleed case: B must never inherit A's person.
    sessionUserId = 'acct-B';
    rerender(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A', 'reset', 'identify:acct-B']);
  });

  it('never identifies while opted out, and recovers identity on a later accept', () => {
    sessionUserId = 'acct-A';
    optedOut = false;
    render(<AnalyticsIdentity />);
    expect(callSequence()).toEqual(['identify:acct-A']);

    // Decline while signed in: the SDK reset already severed identity; the
    // bridge itself neither identifies nor resets.
    flipConsent(true);
    expect(callSequence()).toEqual(['identify:acct-A']);

    // Accept again: re-identify the same signed-in account.
    flipConsent(false);
    expect(callSequence()).toEqual(['identify:acct-A', 'identify:acct-A']);
  });

  it('does not reset for an anonymous visitor who was never identified', () => {
    optedOut = false;
    render(<AnalyticsIdentity />);
    flipConsent(true);
    flipConsent(false);
    expect(callSequence()).toEqual([]);
  });
});
