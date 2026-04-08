import { z } from 'zod';

/** Reusable Zod type for 'true'/'false' env flags → boolean. */
const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const serverEnvSchema = z.object({
  // System
  HOME: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORKOS_PORT: z.coerce.number().int().min(1).max(65535).default(4242),
  DORKOS_HOST: z.string().default('localhost'),
  DORKOS_DEFAULT_CWD: z.string().optional(),
  DORKOS_BOUNDARY: z.string().optional(),
  DORKOS_LOG_LEVEL: z.coerce.number().int().min(0).max(5).optional(),
  DORK_HOME: z.string().optional(),
  DORKOS_VERSION_OVERRIDE: z.string().optional(),
  CLIENT_DIST_PATH: z.string().optional(),
  // MCP external server — optional API key for authenticated access
  MCP_API_KEY: z.string().optional(),
  // Marketplace MCP — when '1', auto-approves every install/uninstall/create
  // confirmation request without prompting the user. Used by CI and tests.
  MARKETPLACE_AUTO_APPROVE: z.string().optional(),
  // Feature flags (boolean after transform)
  DORKOS_A2A_ENABLED: boolFlag,
  DORKOS_TASKS_ENABLED: boolFlag,
  DORKOS_RELAY_ENABLED: boolFlag,
  // Activity feed — retention period for pruning (defaults to 30 days in service)
  DORKOS_ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  // Test mode — TestModeRuntime is registered instead of ClaudeCodeRuntime
  DORKOS_TEST_RUNTIME: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Tunnel (ngrok integration — all optional)
  TUNNEL_ENABLED: boolFlag,
  TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TUNNEL_AUTH: z.string().optional(),
  TUNNEL_DOMAIN: z.string().optional(),
  NGROK_AUTHTOKEN: z.string().optional(),
});

const result = serverEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  result.error.issues.forEach((i) => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type ServerEnv = typeof env;
