/**
 * Capture the "what was on screen" half of a bug report's diagnostics bundle
 * (DOR-1960).
 *
 * The rest of the bundle answers *which build* a report came from
 * (`build-issue-report.ts`: version, platform, runtimes, flags). This answers
 * *what the reporter was actually looking at* — window size, browser, shell,
 * theme, locale, timezone — which is the half a layout or rendering bug needs
 * and the half triage otherwise has to ask for in a round-trip.
 *
 * Everything here is an environment fact read straight off `window`/`navigator`,
 * never content and never anything the app knows about the user's work: there is
 * no geolocation call, no cwd, no workspace path. It rides inside the
 * consent-gated `diagnostics` bundle, so nothing here is captured — let alone
 * sent — unless the reporter has the Diagnostics toggle on and has seen it in
 * the preview.
 *
 * Every read is individually guarded rather than assuming a browser: this module
 * is imported by the Obsidian embed's bundle too, and a missing `navigator` must
 * degrade to an absent field rather than throwing inside the submit path.
 *
 * @module shared/lib/client-environment
 */
import {
  MAX_CLIENT_REPORT_BROWSER_LEN,
  MAX_CLIENT_REPORT_TAG_LEN,
  type FeedbackDiagnostics,
} from '@dorkos/shared/telemetry-events';
import { isDesktopShell } from './platform';

/**
 * The environment subset of a diagnostics `clientReport`.
 *
 * Derived from the schema rather than redeclared, so adding or renaming a field
 * in `FeedbackDiagnosticsSchema` is a type error here instead of a silently
 * unpopulated field on the wire.
 */
export type ClientEnvironment = Pick<
  FeedbackDiagnostics['clientReport'],
  'viewport' | 'browser' | 'shell' | 'theme' | 'locale' | 'timezone'
>;

/** The reporting window's size and pixel density, or `undefined` off a browser. */
function readViewport(): ClientEnvironment['viewport'] {
  if (typeof window === 'undefined') return undefined;
  const { innerWidth, innerHeight, devicePixelRatio } = window;
  if (typeof innerWidth !== 'number' || typeof innerHeight !== 'number') return undefined;
  return {
    // Fractional CSS pixels are real (a zoomed window reports them) but the
    // schema wants integers, and a sub-pixel width has never been the thing that
    // distinguishes one layout bug from another.
    width: Math.round(innerWidth),
    height: Math.round(innerHeight),
    devicePixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
  };
}

/**
 * The IANA timezone this machine is set to, or `undefined` when the runtime
 * cannot say. `resolvedOptions()` throws on some hosts with a partial `Intl`, so
 * the whole read is guarded — a bug report must never fail to send over a
 * diagnostics nicety.
 */
function readTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture the current window's environment for a diagnostics bundle.
 *
 * @param theme - The color scheme actually in effect, already resolved from the
 *   `light`/`dark`/`system` preference by the shared theme store. Passed in
 *   rather than read here so the captured value is the same one the app is
 *   painted with, and so this stays a pure function of its inputs.
 * @returns The populated environment fields; any field this host cannot answer
 *   is left absent rather than filled with a guess.
 */
export function captureClientEnvironment(theme: 'light' | 'dark'): ClientEnvironment {
  const viewport = readViewport();
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
  const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
  const timezone = readTimezone();

  return {
    theme,
    shell: isDesktopShell() ? 'desktop-app' : 'browser',
    ...(viewport ? { viewport } : {}),
    ...(userAgent ? { browser: userAgent.slice(0, MAX_CLIENT_REPORT_BROWSER_LEN) } : {}),
    ...(locale ? { locale: locale.slice(0, MAX_CLIENT_REPORT_TAG_LEN) } : {}),
    ...(timezone ? { timezone: timezone.slice(0, MAX_CLIENT_REPORT_TAG_LEN) } : {}),
  };
}
