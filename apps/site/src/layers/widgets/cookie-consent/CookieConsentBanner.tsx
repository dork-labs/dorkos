'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import posthog from 'posthog-js';
import { siteConfig } from '@/config/site';

const COOKIE_CONSENT_KEY = 'cookie-consent';
const CONSENT_EXPIRY_DAYS = 365;

type ConsentValue = 'accepted' | 'rejected' | null;

function getStoredConsent(): ConsentValue {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(COOKIE_CONSENT_KEY);
  if (!stored) return null;

  try {
    const { value, expiry } = JSON.parse(stored);
    if (Date.now() > expiry) {
      localStorage.removeItem(COOKIE_CONSENT_KEY);
      return null;
    }
    return value as ConsentValue;
  } catch {
    return null;
  }
}

function setStoredConsent(value: 'accepted' | 'rejected') {
  const expiry = Date.now() + CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ value, expiry }));
}

export function CookieConsentBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    // Skip if banner is disabled in site config
    if (siteConfig.disableCookieBanner) return;

    // Check if user has already made a choice
    const consent = getStoredConsent();

    // Stored consent is the source of truth. PostHog is opted out by default
    // (see instrumentation-client.ts), so re-sync its capture state to the
    // stored choice on mount — a visitor who accepted in a prior session, or
    // before this gating shipped, must be re-opted-in here. captureEventName:
    // false avoids emitting a duplicate opt-in event on every page load.
    if (consent === 'accepted' && posthog.has_opted_out_capturing()) {
      posthog.opt_in_capturing({ captureEventName: false });
    } else if (consent === 'rejected' && !posthog.has_opted_out_capturing()) {
      posthog.opt_out_capturing();
    }

    if (consent === null) {
      // Small delay to prevent flash on page load
      const timer = setTimeout(() => setIsVisible(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleClose = (accepted: boolean) => {
    setIsClosing(true);
    setStoredConsent(accepted ? 'accepted' : 'rejected');

    if (accepted) {
      // Enable capture and record the decision as the opt-in event in one call.
      posthog.opt_in_capturing({ captureEventName: 'cookie_consent_accepted' });
    } else {
      // Stop all capture. We intentionally do NOT capture a decline event —
      // sending analytics after a decline is the dark pattern this fixes.
      posthog.opt_out_capturing();
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
        'fixed right-0 bottom-0 left-0 z-50 p-4 sm:p-6',
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
                We use cookies to enhance your browsing experience and analyze site traffic. By
                clicking &quot;Accept&quot;, you consent to our use of cookies.{' '}
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
