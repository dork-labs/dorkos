import { z } from 'zod';

// DorkOS client currently has no custom VITE_* variables.
// Vite's built-in env vars (MODE, DEV, PROD, SSR) are validated here.
//
// To add a validated client env var:
//   1. Prefix the var name with VITE_ in .env.example
//   2. Add it to clientEnvSchema below
//   3. Add it to turbo.json build task env[]. VITE_PORT is the one VITE_* name turbo.json
//      leaves out of the build hash (`!VITE_PORT`), so the browser suite's legs can share one
//      build; it is the dev server's port and must never become a value the bundle reads.
//      It still reaches every process because it is in globalPassThroughEnv; removing it
//      there would hide it from the server, which reads it in lib/trusted-origins.ts.
//   4. Access via: import { env } from '@/env'
const clientEnvSchema = z.object({
  MODE: z.enum(['development', 'production', 'test']).default('development'),
  DEV: z.boolean().default(false),
});

export const env = clientEnvSchema.parse(import.meta.env);
export type ClientEnv = typeof env;
