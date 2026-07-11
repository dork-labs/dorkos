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
  // Note: BETTER_AUTH_SECRET (the optional session-signing-secret override) is
  // deliberately NOT declared here. Its sole consumer,
  // services/core/auth/secret.ts, reads process.env directly — that module is a
  // shared seam also bundled into the CLI, and this schema's parse-once
  // snapshot is a server-boot concern. See readEnvSecret() there; same
  // carve-out routes/tunnel.ts uses for NGROK_AUTHTOKEN.
  // Marketplace MCP — when '1', auto-approves every install/uninstall/create
  // confirmation request without prompting the user. Used by CI and tests.
  MARKETPLACE_AUTO_APPROVE: z.string().optional(),
  // Feature flags (boolean after transform)
  DORKOS_A2A_ENABLED: boolFlag,
  // A2A gateway — public base URL advertised on agent cards. Defaults to
  // http://{DORKOS_HOST}:{DORKOS_PORT}, which is non-routable when the host
  // is 0.0.0.0; set this when DorkOS sits behind a proxy/tunnel
  // (e.g. https://agents.example.com). Trailing slashes are stripped.
  DORKOS_PUBLIC_URL: z.string().optional(),
  // A2A rate limits — requests per minute per IP for the JSON-RPC endpoints
  // (default 60) and the card discovery endpoints (default 300).
  DORKOS_A2A_RPC_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  DORKOS_A2A_CARD_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  // Sign-in brute-force limiter — max sign-in/sign-up attempts per IP per window
  // (default 10 / 15 min). A knob for a dev/QA loop or a locked-out owner to
  // relax the limit without a restart; mirrors the A2A override knobs (DOR-281).
  DORKOS_AUTH_SIGNIN_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  DORKOS_TASKS_ENABLED: boolFlag,
  DORKOS_RELAY_ENABLED: boolFlag,
  // Local-first debug tracing (DOR-294). When 'true' (set by `dorkos
  // --debug-trace`), the server records OpenTelemetry spans for session turns,
  // runtime calls, relay dispatch, and task runs to a sanitized JSONL file
  // under <dorkHome>/traces/. Off by default: no spans, no file, no SDK load.
  // Never phones home — there is no remote/OTLP exporter — so it is a purely
  // local opt-in and does NOT go through the anonymous-telemetry consent.
  DORKOS_OTEL_DEBUG: boolFlag,
  // Exposure escape hatch (accounts-and-auth task 1.3) — when 'true', allow
  // binding a non-loopback host without a login. Off by default; set only by
  // container images that own their own network boundary (see Dockerfile.*).
  DORKOS_ALLOW_INSECURE_BIND: boolFlag,
  // Activity feed — retention period for pruning (defaults to 30 days in service)
  DORKOS_ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  // Test mode — TestModeRuntime is registered instead of ClaudeCodeRuntime
  DORKOS_TEST_RUNTIME: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Test mode only — registers a SECOND TestModeRuntime instance under the
  // 'test-mode-b' type so multi-runtime UI (runtime picker, ?runtime= launch
  // binding, session-list marks) is e2e-testable with zero real agent
  // binaries. Ignored unless DORKOS_TEST_RUNTIME is also true.
  DORKOS_TEST_RUNTIME_SECONDARY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Tunnel (ngrok integration — all optional)
  TUNNEL_ENABLED: boolFlag,
  TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TUNNEL_AUTH: z.string().optional(),
  TUNNEL_DOMAIN: z.string().optional(),
  NGROK_AUTHTOKEN: z.string().optional(),
  // DorkOS cloud base URL for device-link (accounts-and-auth P2). Defaults to
  // production; override for local dev against the site (e.g.
  // http://localhost:$SITE_PORT). Trailing slashes are normalized by the
  // cloud-link client.
  DORKOS_CLOUD_URL: z.string().default('https://dorkos.ai'),
});

const result = serverEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  console.error(z.prettifyError(result.error));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type ServerEnv = typeof env;
