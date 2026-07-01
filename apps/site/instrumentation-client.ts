import posthog from 'posthog-js';
import { env } from '@/env';

posthog.init(env.NEXT_PUBLIC_POSTHOG_KEY ?? '', {
  api_host: '/ingest',
  ui_host: 'https://us.posthog.com',
  // Include the defaults option as required by PostHog
  defaults: '2025-11-30',
  // Opt out by default so nothing is captured until the visitor accepts the
  // cookie banner. CookieConsentBanner flips this via opt_in_capturing() on
  // accept and re-syncs stored consent on mount. Without this, capture() would
  // fire on first load before any consent choice is made.
  opt_out_capturing_by_default: true,
  // Enables capturing unhandled exceptions via Error Tracking
  capture_exceptions: true,
  // Turn on debug in development mode
  debug: env.NODE_ENV === 'development',
});

// IMPORTANT: Never combine this approach with other client-side PostHog initialization approaches,
// especially components like a PostHogProvider. instrumentation-client.ts is the correct solution
// for initializing client-side PostHog in Next.js 15.3+ apps.
