import posthog from 'posthog-js';
import { env } from '@/env';
import { deriveUiHost } from '@/lib/posthog-host';

// PostHog stays entirely uninitialized until NEXT_PUBLIC_POSTHOG_KEY is set
// (a BUILD-time value: changing it in Vercel requires a fresh, uncached build).
// Without it: no init call, no config fetch, no script load, zero requests and
// zero console noise. This is the literal claim the /privacy and /cookies
// pages make ("wired up... but switched off by default"); keep it true.
if (env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(env.NEXT_PUBLIC_POSTHOG_KEY, {
    // Neutral proxy path (renamed off PostHog's blocklist-matched `/ingest`
    // default) so ad/tracker blockers don't drop analytics. Matches the
    // next.config.ts rewrite. See src/lib/posthog-host.ts.
    api_host: '/hub',
    ui_host: deriveUiHost(env.NEXT_PUBLIC_POSTHOG_HOST),
    // Include the defaults option as required by PostHog
    defaults: '2025-11-30',
    // ── Hybrid cookieless + geo-gated consent (ADR 260713-143958, Phase 0) ──
    //
    // `cookieless_mode: 'on_reject'` means: a visitor who has NOT opted in is
    // captured in cookieless mode — PostHog generates a privacy-preserving,
    // daily-salted hash server-side, sets no cookies, and uses no local
    // storage (no cross-day identity). A visitor who opts in
    // (`opt_in_capturing()`) gets normal cookie-based capture instead.
    //   Verified against the installed posthog-js 1.395.0 types
    //   (@posthog/types posthog-config.d.ts) and `is_capturing()`'s TSDoc:
    //   "if cookieless_mode is 'on_reject', we capture events in cookieless
    //   mode if the user has opted out OR been defaulted to opt-out."
    //   NOTE: cookieless mode must also be enabled in the PostHog *project*
    //   settings, or these events are dropped server-side.
    cookieless_mode: 'on_reject',
    // `opt_out_capturing_by_default: true` is DELIBERATELY KEPT under
    // cookieless_mode. It no longer means "capture nothing" — it means an
    // undecided visitor is *defaulted to opt-out*, which under 'on_reject'
    // yields the cookieless anonymous floor rather than full cookie capture.
    // Removing it would default undecided visitors to cookie-based opt-in,
    // breaking the gated-region requirement (EU/UK visitors must not get
    // cookies until they accept). The SDK's explicit-consent 'pending' status
    // reflects only whether the visitor made a choice; it does NOT by itself
    // force opt-out — that is governed by this flag. CookieConsentBanner
    // reconciles the actual capture state per region on mount (see
    // src/lib/consent.ts): open regions silently opt in, gated regions show
    // the banner, and any decline/DNT/GPC signal pins the visitor to
    // cookieless.
    opt_out_capturing_by_default: true,
    // Only create person profiles on explicit identify() — anonymous visitors
    // never get one. Stated explicitly (it is also the SDK default) because
    // the whole hybrid model depends on it: cookieless events must stay
    // person-less. Identified opt-in (account UUID) arrives in a later phase.
    person_profiles: 'identified_only',
    // Next.js App Router navigates via the History API, not full page loads —
    // without this, only the very first pageview of a session is captured and
    // every funnel step past the landing page goes uncounted.
    capture_pageview: 'history_change',
    // Privacy defaults (see the module doc in src/lib/analytics.ts): no
    // autocapture — only the named funnel events fire — and no session
    // recording.
    autocapture: false,
    disable_session_recording: true,
    // Honor Do Not Track: PostHog computes DNT visitors as opted-out, which
    // under cookieless_mode means the cookieless anonymous floor (never
    // cookies). GPC is not handled here — the SDK ignores it — so
    // src/lib/consent.ts checks navigator.globalPrivacyControl separately.
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
