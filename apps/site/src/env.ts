import { z } from 'zod';

// Next.js makes NEXT_PUBLIC_* vars available server-side and client-side.
// Non-public vars are server-only. Every account/auth var below is optional or
// has a safe default so this schema still parses on the client (where
// server-only secrets are absent) and during `next build` (no secrets present).
const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Vercel system env (auto-injected on Vercel deploys; absent locally). Used to
  // self-derive the auth origin on preview deploys, whose URL is not known ahead
  // of time — see resolveBaseURL() in lib/auth.ts. VERCEL_URL is the per-deploy
  // host, VERCEL_BRANCH_URL the stable per-branch alias (both without protocol).
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  VERCEL_URL: z.string().optional(),
  VERCEL_BRANCH_URL: z.string().optional(),

  // Unset in every environment until the founder provisions a PostHog project
  // (DOR-268). instrumentation-client.ts skips posthog.init() entirely when
  // this is absent, so an unconfigured deploy makes zero PostHog network
  // requests — the literal claim the /privacy and /cookies pages make.
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  // The PostHog ingest host, region-specific (`https://us.i.posthog.com` or
  // `https://eu.i.posthog.com`). Drives both the client SDK and the
  // next.config.ts reverse-proxy rewrite, so switching region is one env var.
  // See src/lib/posthog-host.ts for how the UI/asset hosts are derived from it.
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),
  // Server-only PostHog project (write-only) key used by the owned-ingest route
  // (`/api/telemetry/events`, ADR 260713-143958 Phase 3) to fan curated app
  // usage events out to PostHog's `/batch/` endpoint server-side — so the key
  // lives only in site env and no client surface embeds a vendor SDK. Optional
  // by design: when unset, the ingest route accepts events and drops them (zero
  // errors), matching the "unconfigured deploy makes zero PostHog requests"
  // stance. Project API keys are write-only and public-safe, but keeping this
  // server-side keeps the ingest fan-out a single, swappable control point.
  POSTHOG_PROJECT_KEY: z.string().optional(),

  // Better Auth — the DorkOS account cloud identity core (accounts-and-auth P2).
  // BETTER_AUTH_SECRET signs sessions; set a 32+ char secret in production. When
  // unset, Better Auth falls back to a development secret.
  BETTER_AUTH_SECRET: z.string().optional(),
  // Public origin Better Auth serves from (OAuth callbacks + verification links).
  // Set only in Production (the canonical origin); preview self-derives from
  // VERCEL_BRANCH_URL (see resolveBaseURL). The default matches the site dev port
  // so unset local/Development resolves correctly.
  BETTER_AUTH_URL: z.string().url().default('http://localhost:6244'),

  // Social sign-in. Empty by default so builds/tests don't require OAuth apps;
  // populate in the deployment to actually enable GitHub/Google sign-in.
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  // Resend — transactional email for verification/reset (cloud-only). Sending
  // throws a clear error when RESEND_API_KEY is unset.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('DorkOS <onboarding@resend.dev>'),
  // Resend Segment the confirmed newsletter subscribers are mirrored into
  // (ADR 260707-025214). Segments replaced Audiences in Resend's 2025 migration
  // (contacts are account-global; broadcasts target a segment). When unset, the
  // double-opt-in flow still works and the local `newsletter_subscriber` row
  // stays authoritative; only the Resend mirror (and therefore broadcasts) is
  // skipped, so leave it unset on preview/local. Set per environment (prod and
  // staging should point at *different* segments so test signups never pollute
  // the real list).
  RESEND_SEGMENT_ID: z.string().optional(),

  // Break-glass admin bootstrap (cloud-account-management, DOR-187). A
  // comma-separated list of DorkOS-account user ids granted full admin
  // regardless of their `role`, so the first admin exists before any admin can
  // promote one. Empty by default; set the founder's user id here at launch.
  // The durable promotion is a one-time `role='admin'` UPDATE (documented in
  // contributing/authentication.md), of which this is the zero-state seed.
  ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),

  // Shared secret gating the scheduled-cleanup cron (DOR-194). Vercel Cron sends
  // it as `Authorization: Bearer <CRON_SECRET>` when this env var is set. Optional
  // by design: when unset, the cron route refuses to run (401) so it can never be
  // triggered unauthenticated. Set a strong random value in the deployment.
  CRON_SECRET: z.string().optional(),
});

// Client bundles do not get the whole process.env object — Next.js (webpack
// and Turbopack alike) only inlines *literal* `process.env.NEXT_PUBLIC_*`
// member accesses at build time. Passing `process.env` wholesale to zod
// therefore parses `{}` in the browser and every NEXT_PUBLIC_* var reads as
// undefined there. The explicit spreads below are those literal accesses, so
// public vars survive into client code; server-only vars still come from the
// real process.env (server) and stay undefined on the client by design.
export const env = webEnvSchema.parse({
  ...process.env,
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});
export type WebEnv = typeof env;
