import { z } from 'zod';

// Next.js makes NEXT_PUBLIC_* vars available server-side and client-side.
// Non-public vars are server-only.
const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default('https://app.posthog.com'),
});

export const env = webEnvSchema.parse(process.env);
export type WebEnv = typeof env;
