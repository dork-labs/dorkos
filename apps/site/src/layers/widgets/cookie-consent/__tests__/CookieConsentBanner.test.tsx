/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CookieConsentBanner } from '../CookieConsentBanner';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('lucide-react', () => ({
  X: () => <svg data-testid="close-icon" />,
}));

// Mutable so individual tests can flip the kill-switch. vi.hoisted runs before
// the hoisted vi.mock factory, so the factory can close over the same object.
const { siteConfigMock } = vi.hoisted(() => ({ siteConfigMock: { disableCookieBanner: false } }));

vi.mock('@/config/site', () => ({
  siteConfig: siteConfigMock,
}));

// Analytics spies (the banner talks to @/lib/analytics, never posthog-js
// directly). `optedOut` models PostHog's current capture state so we can
// exercise the mount re-sync branches; it defaults to opted-out to match
// instrumentation-client.ts (opt_out_capturing_by_default: true).
const optIn = vi.fn();
const optOut = vi.fn();
let optedOut = true;

vi.mock('@/lib/analytics', () => ({
  optInCapturing: (...args: unknown[]) => optIn(...args),
  optOutCapturing: (...args: unknown[]) => optOut(...args),
  hasOptedOutCapturing: () => optedOut,
}));

const CONSENT_KEY = 'cookie-consent';

function storeConsent(value: 'accepted' | 'rejected') {
  localStorage.setItem(CONSENT_KEY, JSON.stringify({ value, expiry: Date.now() + 1_000_000_000 }));
}

function storedConsentValue(): string | undefined {
  const raw = localStorage.getItem(CONSENT_KEY);
  return raw ? JSON.parse(raw).value : undefined;
}

describe('CookieConsentBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    optedOut = true;
    siteConfigMock.disableCookieBanner = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Discard pending timers (e.g. the 200ms close animation) without running
    // their callbacks, which would update state on an about-to-unmount component.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Render then advance past the 500ms reveal delay so the banner is visible. */
  function revealBanner() {
    render(<CookieConsentBanner />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
  }

  it('enables capture and records the decision when accepted', () => {
    revealBanner();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });

    expect(optIn).toHaveBeenCalledWith({ captureEventName: 'cookie_consent_accepted' });
    expect(optOut).not.toHaveBeenCalled();
    expect(storedConsentValue()).toBe('accepted');
  });

  it('disables capture and sends no event when declined', () => {
    revealBanner();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });

    expect(optOut).toHaveBeenCalledTimes(1);
    // No opt-in and no decline event — capturing after a decline is the dark
    // pattern we fix.
    expect(optIn).not.toHaveBeenCalled();
    expect(storedConsentValue()).toBe('rejected');
  });

  it('shows the banner and makes no capture decision until the visitor chooses', () => {
    revealBanner();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
  });

  it('re-opts-in a returning visitor who previously accepted (migration)', () => {
    storeConsent('accepted');
    optedOut = true; // PostHog has no persisted grant yet (opted out by default)
    render(<CookieConsentBanner />);

    expect(optIn).toHaveBeenCalledWith({ captureEventName: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('re-opts-out a returning visitor who previously declined', () => {
    storeConsent('rejected');
    optedOut = false; // PostHog currently capturing — must be corrected to opted out
    render(<CookieConsentBanner />);

    expect(optOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not redundantly re-opt-in an accepted visitor already opted in', () => {
    storeConsent('accepted');
    optedOut = false; // PostHog already has the grant persisted
    render(<CookieConsentBanner />);

    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
  });

  it('stays hidden and touches no consent state when the banner is disabled', () => {
    siteConfigMock.disableCookieBanner = true;
    revealBanner();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
  });

  it('evicts expired consent and re-shows the banner', () => {
    // Stored choice whose 365-day window has lapsed.
    localStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({ value: 'accepted', expiry: Date.now() - 1 })
    );
    revealBanner();

    // Treated as no choice: banner reappears, stale entry is evicted, and no
    // capture decision is re-applied from the expired value.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
  });
});
