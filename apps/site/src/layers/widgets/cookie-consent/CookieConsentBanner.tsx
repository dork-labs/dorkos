'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hasOptedOutCapturing, optInCapturing, optOutCapturing } from '@/lib/analytics';
import { decideConsent, readConsentSignals, setStoredConsent } from '@/lib/consent';
import { siteConfig } from '@/config/site';

/** Attribute set on `<html>` while the banner is open, so the pill nav can hide behind it. */
const BANNER_OPEN_ATTR = 'data-consent-banner-open';

/**
 * The site's consent controller. Mounted once in the root layout, it does two
 * things on every page:
 *
 * 1. **Reconciles PostHog's capture state** to the visitor's region + choice
 *    (see src/lib/consent.ts). Open regions silently opt in; gated regions stay
 *    cookieless until a choice; any decline/DNT/GPC signal pins to cookieless.
 *    Because the site runs `cookieless_mode: 'on_reject'`, "opted out" still
 *    produces anonymous, cookieless analytics — never zero.
 * 2. **Shows the opt-in banner** only when the decision calls for it (a gated
 *    region, undecided, no decline signal).
 *
 * While the banner is open it flags `<html>` with `data-consent-banner-open` so
 * the bottom pill nav (MarketingNav) hides instead of overlapping it.
 */
export function CookieConsentBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    // Kill switch: hide the banner and touch no consent state.
    if (siteConfig.disableCookieBanner) return;

    const decision = decideConsent(readConsentSignals());

    // Reconcile PostHog to the desired capture kind. Only act when the current
    // state differs, and never emit a consent event here (captureEventName:
    // false) — the only event-emitting opt-in is an explicit banner Accept.
    if (decision.capture === 'cookies' && hasOptedOutCapturing()) {
      optInCapturing({ captureEventName: false });
    } else if (decision.capture === 'cookieless' && !hasOptedOutCapturing()) {
      optOutCapturing();
    }

    if (decision.showBanner) {
      // Small delay to prevent flash on page load.
      const timer = setTimeout(() => setIsVisible(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  // Flag <html> while the banner is on screen so the pill nav hides behind it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (isVisible) {
      root.setAttribute(BANNER_OPEN_ATTR, '');
      return () => root.removeAttribute(BANNER_OPEN_ATTR);
    }
    root.removeAttribute(BANNER_OPEN_ATTR);
  }, [isVisible]);

  const handleClose = (accepted: boolean) => {
    setIsClosing(true);
    setStoredConsent(accepted ? 'accepted' : 'rejected');

    if (accepted) {
      // Enable cookie-based capture and record the decision as the opt-in event
      // in one call.
      optInCapturing({ captureEventName: 'cookie_consent_accepted' });
    } else {
      // Drop to the cookieless anonymous floor. We intentionally do NOT capture
      // a decline event — sending analytics after a decline is the dark pattern
      // this fixes.
      optOutCapturing();
    }

    // Wait for animation to complete
    setTimeout(() => {
      setIsVisible(false);
      setIsClosing(false);
    }, 200);
  };

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        // z-[110] sits above the bottom pill nav (z-100); the nav also hides
        // itself via [data-consent-banner-open] while this is open.
        'fixed right-0 bottom-0 left-0 z-[110] p-4 sm:p-6',
        'transition-all duration-200 ease-out',
        isClosing ? 'translate-y-full opacity-0' : 'translate-y-0 opacity-100'
      )}
      role="dialog"
      aria-label="Cookie consent"
      aria-describedby="cookie-consent-description"
    >
      <div className="container-default">
        <div className="bg-card shadow-elevated relative rounded-xl border p-4 sm:p-6">
          {/* Close button */}
          <button
            onClick={() => handleClose(false)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground absolute top-3 right-3 rounded-md p-1 transition-colors"
            aria-label="Dismiss cookie banner"
          >
            <X className="size-4" />
          </button>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="space-y-1 pr-8 sm:pr-0">
              <p className="font-medium">We value your privacy</p>
              <p id="cookie-consent-description" className="text-muted-foreground text-sm">
                Accept to let us count visits with cookies. Decline and we still count you, but
                anonymously, with no cookies and no cross-day tracking.{' '}
                <Link href="/cookies" className="text-primary underline-offset-4 hover:underline">
                  Learn more
                </Link>
              </p>
            </div>

            <div className="flex shrink-0 gap-3">
              <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
                Decline
              </Button>
              <Button size="sm" onClick={() => handleClose(true)}>
                Accept
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
