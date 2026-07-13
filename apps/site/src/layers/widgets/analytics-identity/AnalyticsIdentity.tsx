'use client';

import { useEffect, useRef } from 'react';

import {
  CONSENT_CHANGED_EVENT,
  hasOptedOutCapturing,
  identifyAccount,
  resetIdentity,
} from '@/lib/analytics';
import { useSession } from '@/lib/auth-client';

import { decideIdentity } from './identity-decision';

/**
 * The account-identity bridge (ADR 260713-143958 Phase 4, Tier 2 — opt-in).
 * Mounted once in the root layout beside {@link CookieConsentBanner}, it is the
 * single place that connects the Better Auth session to PostHog identity:
 *
 * - When a visitor is **signed in and opted in** (cookies mode), it identifies
 *   them by their account UUID — merging their prior anonymous browser history
 *   into the account person.
 * - When they **log out** — or a *different* account signs in on the same
 *   browser — it resets PostHog identity religiously, so a shared browser never
 *   carries one account's identified events into the next visitor.
 * - It never identifies an anonymous-floor visitor — the gate lives in
 *   {@link identifyAccount}, and the transition logic in {@link decideIdentity}.
 *
 * It re-evaluates on two signals: the session changing (login/logout, via
 * `useSession`) and capture state flipping (accept/decline/toggle, via the
 * {@link CONSENT_CHANGED_EVENT} window event). Renders nothing.
 */
export function AnalyticsIdentity() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  // WHICH account the previous evaluation left identified (null = none) —
  // drives the once-only identify, the logout-only reset, and the direct A→B
  // account-switch reset (a ref so it never triggers a re-render). An id, not a
  // boolean: a boolean can't tell account A from account B, which would let B's
  // events attribute to A on a shared browser.
  const identifiedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    function sync() {
      const decision = decideIdentity({
        userId,
        optedOut: hasOptedOutCapturing(),
        identifiedUserId: identifiedUserIdRef.current,
      });
      identifiedUserIdRef.current = decision.identifiedUserId;
      if (decision.action === 'identify' && userId) {
        identifyAccount(userId);
      } else if (decision.action === 'reset-then-identify' && userId) {
        // Direct account switch (A→B without a logged-out tick in between):
        // sever A's identity first so B's events never attribute to A.
        resetIdentity();
        identifyAccount(userId);
      } else if (decision.action === 'reset') {
        resetIdentity();
      }
    }

    // Evaluate now (session resolved / route changed) and whenever consent flips.
    sync();
    window.addEventListener(CONSENT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, sync);
  }, [userId]);

  return null;
}
