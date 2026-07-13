/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideConsent,
  getStoredConsent,
  setStoredConsent,
  getRegion,
  hasGpcSignal,
  hasDntSignal,
  type ConsentSignals,
} from '@/lib/consent';

const base: ConsentSignals = { region: 'open', storedConsent: null, gpc: false, dnt: false };

describe('decideConsent', () => {
  it('pins a stored decline to cookieless with no banner', () => {
    expect(decideConsent({ ...base, region: 'gated', storedConsent: 'rejected' })).toEqual({
      capture: 'cookieless',
      showBanner: false,
    });
  });

  it('treats GPC as a decline that overrides a stored accept', () => {
    expect(decideConsent({ ...base, storedConsent: 'accepted', gpc: true })).toEqual({
      capture: 'cookieless',
      showBanner: false,
    });
  });

  it('treats DNT as a decline that overrides a stored accept', () => {
    expect(
      decideConsent({ ...base, region: 'gated', storedConsent: 'accepted', dnt: true })
    ).toEqual({ capture: 'cookieless', showBanner: false });
  });

  it('honors an explicit accept as cookie-based capture', () => {
    expect(decideConsent({ ...base, region: 'gated', storedConsent: 'accepted' })).toEqual({
      capture: 'cookies',
      showBanner: false,
    });
  });

  it('silently opts in an undecided visitor in an open region (no banner)', () => {
    expect(decideConsent({ ...base, region: 'open', storedConsent: null })).toEqual({
      capture: 'cookies',
      showBanner: false,
    });
  });

  it('shows the banner and stays cookieless for an undecided visitor in a gated region', () => {
    expect(decideConsent({ ...base, region: 'gated', storedConsent: null })).toEqual({
      capture: 'cookieless',
      showBanner: true,
    });
  });

  it('never shows a banner to an open-region visitor even when undecided', () => {
    expect(decideConsent({ ...base, region: 'open' }).showBanner).toBe(false);
  });
});

describe('getStoredConsent / setStoredConsent', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips an explicit choice', () => {
    setStoredConsent('accepted');
    expect(getStoredConsent()).toBe('accepted');
    setStoredConsent('rejected');
    expect(getStoredConsent()).toBe('rejected');
  });

  it('returns null when nothing is stored', () => {
    expect(getStoredConsent()).toBeNull();
  });

  it('evicts and returns null for an expired entry', () => {
    localStorage.setItem(
      'cookie-consent',
      JSON.stringify({ value: 'accepted', expiry: Date.now() - 1 })
    );
    expect(getStoredConsent()).toBeNull();
    expect(localStorage.getItem('cookie-consent')).toBeNull();
  });

  it('returns null for an unparseable entry', () => {
    localStorage.setItem('cookie-consent', 'not-json');
    expect(getStoredConsent()).toBeNull();
  });
});

describe('getRegion', () => {
  afterEach(() => {
    document.cookie = 'dorkos_region=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('reads an open region from the cookie', () => {
    document.cookie = 'dorkos_region=open';
    expect(getRegion()).toBe('open');
  });

  it('reads a gated region from the cookie', () => {
    document.cookie = 'dorkos_region=gated';
    expect(getRegion()).toBe('gated');
  });

  it('fails closed to gated when the cookie is absent', () => {
    expect(getRegion()).toBe('gated');
  });
});

describe('hasGpcSignal', () => {
  afterEach(() => {
    delete (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
  });

  it('is true when navigator.globalPrivacyControl is true', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    expect(hasGpcSignal()).toBe(true);
  });

  it('is false when the signal is absent', () => {
    expect(hasGpcSignal()).toBe(false);
  });
});

describe('hasDntSignal', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  });

  it('is true when Do Not Track is "1"', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    expect(hasDntSignal()).toBe(true);
  });

  it('is false when Do Not Track is unset', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    expect(hasDntSignal()).toBe(false);
  });
});
