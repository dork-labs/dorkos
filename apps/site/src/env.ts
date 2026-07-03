import { z } from 'zod';

// Next.js makes NEXT_PUBLIC_* vars available server-side and client-side.
// Non-public vars are server-only. Every account/auth var below is optional or
// has a safe default so this schema still parses on the client (where
// server-only secrets are absent) and during `next build` (no secrets present).
const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default('https://app.posthog.com'),

  // Better Auth — the DorkOS account cloud identity core (accounts-and-auth P2).
  // BETTER_AUTH_SECRET signs sessions; set a 32+ char secret in production. When
  // unset, Better Auth falls back to a development secret.
  BETTER_AUTH_SECRET: z.string().optional(),
  // Public origin Better Auth serves from (OAuth callbacks + verification links).
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),

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
});

export const env = webEnvSchema.parse(process.env);
export type WebEnv = typeof env;
