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
 * - When they **log out**, it resets PostHog identity religiously, so a shared
 *   browser never carries one account's identified events into the next visitor.
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
  // Whether the previous evaluation left us identified — drives the once-only
  // identify and the logout-only reset (a ref so it never triggers a re-render).
  const identifiedRef = useRef(false);

  useEffect(() => {
    function sync() {
      const decision = decideIdentity({
        userId,
        optedOut: hasOptedOutCapturing(),
        identified: identifiedRef.current,
      });
      identifiedRef.current = decision.identified;
      if (decision.action === 'identify' && userId) {
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
