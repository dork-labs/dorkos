/**
 * Consent decision logic for the site's hybrid analytics model.
 *
 * The site runs `posthog-js` in `cookieless_mode: 'on_reject'` (see
 * instrumentation-client.ts), so there is no "capture nothing" state: every
 * visitor produces analytics. What this module decides is which *kind*:
 *
 * - **cookies** — normal cookie-based capture (opted in). Identity persists
 *   across days; a person profile can be created on `identify`.
 * - **cookieless** — PostHog's daily-salted server-side hash. No cookies, no
 *   local storage, no cross-day identity. Genuinely anonymous, GDPR-out-of-scope.
 *
 * The choice depends on region, the visitor's stored decision, and the two
 * browser decline signals (Do Not Track and Global Privacy Control):
 *
 * | Signal                                   | Result               |
 * | ---------------------------------------- | -------------------- |
 * | Stored decline, DNT, or GPC              | cookieless (never cookies) |
 * | Stored accept                            | cookies              |
 * | Undecided, open region                   | cookies (silent opt-in) |
 * | Undecided, gated region                  | cookieless + show banner |
 *
 * GPC is checked here because `posthog-js` does not honor it natively —
 * `respect_dnt: true` covers Do Not Track only. We fold both signals in so a
 * declined/DNT/GPC visitor stays cookieless even if they had previously
 * accepted.
 *
 * The pure {@link decideConsent} function holds the whole policy and is unit
 * tested exhaustively; the browser-facing readers below guard on `window` so
 * they are safe to import into server components.
 *
 * @module lib/consent
 */
import { parseRegionCookie, REGION_COOKIE, type Region } from '@/lib/region';

/** localStorage key holding the visitor's explicit accept/decline choice. */
export const COOKIE_CONSENT_KEY = 'cookie-consent';

/** How long a stored consent choice stays valid before the banner asks again. */
export const CONSENT_EXPIRY_DAYS = 365;

/** A visitor's explicit choice, or `null` when they have not decided. */
export type StoredConsent = 'accepted' | 'rejected' | null;

/** The kind of analytics capture a visitor should receive. */
export type CaptureKind = 'cookies' | 'cookieless';

/** The three inputs to a consent decision, read once on mount. */
export interface ConsentSignals {
  /** Edge-computed region (from the `dorkos_region` cookie; gated when absent). */
  region: Region;
  /** The visitor's stored accept/decline choice. */
  storedConsent: StoredConsent;
  /** `navigator.globalPrivacyControl === true` — a legal decline signal. */
  gpc: boolean;
  /** Do Not Track is enabled — a legal decline signal. */
  dnt: boolean;
}

/** The outcome of a consent decision. */
export interface ConsentDecision {
  /** Which capture kind PostHog should be reconciled to. */
  capture: CaptureKind;
  /** Whether to show the opt-in banner (gated region, undecided, no decline signal). */
  showBanner: boolean;
}

/**
 * The whole consent policy as one pure function. Deterministic in its inputs so
 * it can be exhaustively unit tested without a DOM.
 *
 * Precedence: any decline signal (stored reject, DNT, or GPC) wins over
 * everything and yields cookieless with no banner. Then an explicit accept
 * yields cookies. Otherwise an undecided visitor gets cookies in an open region
 * (silent opt-in under the US opt-out regime) or the banner in a gated region
 * (cookieless until they choose).
 *
 * @param signals - Region, stored decision, and the DNT/GPC decline signals.
 */
export function decideConsent(signals: ConsentSignals): ConsentDecision {
  const { region, storedConsent, gpc, dnt } = signals;

  // Decline signals are absolute and never show a banner: an explicit reject,
  // Do Not Track, or Global Privacy Control all pin the visitor to cookieless.
  if (storedConsent === 'rejected' || gpc || dnt) {
    return { capture: 'cookieless', showBanner: false };
  }

  // Explicit acceptance upgrades to cookie-based capture.
  if (storedConsent === 'accepted') {
    return { capture: 'cookies', showBanner: false };
  }

  // Undecided, no decline signal.
  if (region === 'open') {
    // US-style opt-out regime: on by default, no banner. The visitor can turn
    // it off from /privacy, which stores a decline and flips this to cookieless.
    return { capture: 'cookies', showBanner: false };
  }

  // Gated region (EU/EEA/UK/CH or unknown): ask first. Stay cookieless — still
  // fully anonymous analytics — until the visitor accepts or declines.
  return { capture: 'cookieless', showBanner: true };
}

/**
 * Reads the visitor's stored consent choice, evicting it if the 365-day window
 * has lapsed. Returns `null` (undecided) on the server, when nothing is stored,
 * when the entry has expired, or when the value is unparseable.
 */
export function getStoredConsent(): StoredConsent {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(COOKIE_CONSENT_KEY);
  if (!stored) return null;

  try {
    const { value, expiry } = JSON.parse(stored) as { value: StoredConsent; expiry: number };
    if (Date.now() > expiry) {
      window.localStorage.removeItem(COOKIE_CONSENT_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Persists an explicit accept/decline choice with a 365-day expiry. No-ops on
 * the server.
 *
 * @param value - The visitor's explicit choice.
 */
export function setStoredConsent(value: 'accepted' | 'rejected'): void {
  if (typeof window === 'undefined') return;
  const expiry = Date.now() + CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  window.localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ value, expiry }));
}

/**
 * Whether the browser is sending Global Privacy Control. `posthog-js` does not
 * honor GPC natively (only DNT via `respect_dnt`), so we read it ourselves and
 * treat it as a decline. Returns `false` on the server.
 */
export function hasGpcSignal(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

/**
 * Whether the browser has Do Not Track enabled. PostHog also enforces this via
 * `respect_dnt: true`; we mirror it in the decision so the stored preference
 * and the banner state stay consistent. Returns `false` on the server.
 */
export function hasDntSignal(): boolean {
  if (typeof navigator === 'undefined' && typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const raw =
    nav?.doNotTrack ??
    (typeof window !== 'undefined'
      ? (window as Window & { doNotTrack?: string }).doNotTrack
      : undefined) ??
    (nav as (Navigator & { msDoNotTrack?: string }) | undefined)?.msDoNotTrack;
  return raw === '1' || raw === 'yes';
}

/**
 * Reads the edge-computed region from the `dorkos_region` cookie. Falls back to
 * `'gated'` when the cookie is absent (local dev, a non-Vercel host) or on the
 * server, matching the fail-closed classifier.
 */
export function getRegion(): Region {
  if (typeof document === 'undefined') return 'gated';
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${REGION_COOKIE}=([^;]*)`));
  return parseRegionCookie(match ? decodeURIComponent(match[1]) : undefined);
}

/**
 * Reads all three consent signals from the browser in one call: the region
 * cookie, the stored decision, and the DNT/GPC decline signals.
 */
export function readConsentSignals(): ConsentSignals {
  return {
    region: getRegion(),
    storedConsent: getStoredConsent(),
    gpc: hasGpcSignal(),
    dnt: hasDntSignal(),
  };
}
