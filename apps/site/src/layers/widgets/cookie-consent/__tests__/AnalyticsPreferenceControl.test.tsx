/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalyticsPreferenceControl } from '../AnalyticsPreferenceControl';

// Analytics spies (the control talks to @/lib/analytics, never posthog-js
// directly). `optedOut` models PostHog's current capture state; the consent
// helpers (@/lib/consent) run for real against localStorage / navigator.
const optIn = vi.fn();
const optOut = vi.fn();
let optedOut = false;

vi.mock('@/lib/analytics', () => ({
  optInCapturing: (...args: unknown[]) => {
    optedOut = false;
    optIn(...args);
  },
  optOutCapturing: (...args: unknown[]) => {
    optedOut = true;
    optOut(...args);
  },
  hasOptedOutCapturing: () => optedOut,
}));

const CONSENT_KEY = 'cookie-consent';

function storedConsentValue(): string | undefined {
  const raw = localStorage.getItem(CONSENT_KEY);
  return raw ? JSON.parse(raw).value : undefined;
}

function getSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Cookie-based analytics' });
}

describe('AnalyticsPreferenceControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    optedOut = false;
  });

  it('renders the switch off and disabled when GPC is set (forced-off lock)', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    render(<AnalyticsPreferenceControl />);

    const control = getSwitch();
    expect(control.getAttribute('aria-checked')).toBe('false');
    // Base UI renders a non-native switch: disabled state is the data-disabled attribute.
    expect(control.hasAttribute('data-disabled')).toBe(true);
    // Toggling must be inert: no consent write, no capture change.
    fireEvent.click(control);
    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).not.toHaveBeenCalled();
    expect(storedConsentValue()).toBeUndefined();
  });

  it('renders the switch off and disabled when Do Not Track is on', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    render(<AnalyticsPreferenceControl />);

    const control = getSwitch();
    expect(control.getAttribute('aria-checked')).toBe('false');
    // Base UI renders a non-native switch: disabled state is the data-disabled attribute.
    expect(control.hasAttribute('data-disabled')).toBe(true);
  });

  it('toggling on stores an accepted decision and opts in without a consent event', () => {
    optedOut = true; // currently on the cookieless floor
    render(<AnalyticsPreferenceControl />);

    const control = getSwitch();
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);

    expect(storedConsentValue()).toBe('accepted');
    expect(optIn).toHaveBeenCalledWith({ captureEventName: false });
    expect(optOut).not.toHaveBeenCalled();
  });

  it('toggling off stores a rejected decision and opts out', () => {
    optedOut = false; // currently capturing with cookies
    render(<AnalyticsPreferenceControl />);

    const control = getSwitch();
    expect(control.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(control);

    expect(storedConsentValue()).toBe('rejected');
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(optIn).not.toHaveBeenCalled();
  });
});
