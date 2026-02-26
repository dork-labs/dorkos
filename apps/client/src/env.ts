import { z } from 'zod';

// DorkOS client currently has no custom VITE_* variables.
// Vite's built-in env vars (MODE, DEV, PROD, SSR) are validated here.
//
// To add a validated client env var:
//   1. Prefix the var name with VITE_ in .env.example
//   2. Add it to clientEnvSchema below
//   3. Add it to turbo.json build task env[]
//   4. Access via: import { env } from '@/env'
const clientEnvSchema = z.object({
  MODE: z.enum(['development', 'production', 'test']).default('development'),
  DEV: z.boolean().default(false),
});

export const env = clientEnvSchema.parse(import.meta.env);
export type ClientEnv = typeof env;
