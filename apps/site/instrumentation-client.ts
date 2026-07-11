import posthog from 'posthog-js';
import { env } from '@/env';
import { deriveUiHost } from '@/lib/posthog-host';

// PostHog stays entirely uninitialized until NEXT_PUBLIC_POSTHOG_KEY is set —
// no init call, no config fetch, no script load, zero network requests and
// zero console noise. This is the literal claim the /privacy and /cookies
// pages make ("wired up... but switched off by default"); keep it true.
if (env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: '/ingest',
    ui_host: deriveUiHost(env.NEXT_PUBLIC_POSTHOG_HOST),
    // Include the defaults option as required by PostHog
    defaults: '2025-11-30',
    // Next.js App Router navigates via the History API, not full page loads —
    // without this, only the very first pageview of a session is captured and
    // every funnel step past the landing page goes uncounted.
    capture_pageview: 'history_change',
    // Opt out by default so nothing is captured until the visitor accepts the
    // cookie banner. CookieConsentBanner flips this via opt_in_capturing() on
    // accept and re-syncs stored consent on mount. Without this, capture() would
    // fire on first load before any consent choice is made.
    opt_out_capturing_by_default: true,
    // Privacy defaults (see the module doc in src/lib/analytics.ts): no
    // autocapture — only the named funnel events fire — and no session
    // recording. Never initialize for a visitor with Do Not Track enabled.
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
    // Enables capturing unhandled exceptions via Error Tracking
    capture_exceptions: true,
    // Turn on debug in development mode
    debug: env.NODE_ENV === 'development',
  });
}

// IMPORTANT: Never combine this approach with other client-side PostHog initialization approaches,
// especially components like a PostHogProvider. instrumentation-client.ts is the correct solution
// for initializing client-side PostHog in Next.js 15.3+ apps.
