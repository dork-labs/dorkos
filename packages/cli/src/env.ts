import { z } from 'zod';

// Only vars the CLI itself reads (e.g., to display the current DORK_HOME).
// The CLI imperatively sets DORKOS_PORT, TUNNEL_*, DORKOS_*_ENABLED, etc.
// via process.env assignments in cli.ts to configure the server subprocess.
// Those assignments remain in cli.ts with ESLint inline disables.
const cliEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORK_HOME: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});

export const env = cliEnvSchema.parse(process.env);
export type CliEnv = typeof env;
