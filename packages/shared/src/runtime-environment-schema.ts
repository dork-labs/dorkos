/** Names-only runtime environment policy; values never enter persistent configuration. */
import { z } from 'zod';

/** Server and platform credentials cannot be opted into runtime inheritance. */
export const RUNTIME_RESERVED_ENV_NAMES = [
  'MCP_API_KEY',
  'BETTER_AUTH_SECRET',
  'NANGO_ENCRYPTION_KEY',
  'NANGO_SECRET_KEY',
  'COMPOSIO_API_KEY',
  'NGROK_AUTHTOKEN',
  'TUNNEL_AUTH',
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_PASSWORD',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'NEON_API_KEY',
  'VERCEL_TOKEN',
  'CRON_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'LINEAR_API_KEY',
  'LINEAR_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'POSTHOG_PERSONAL_API_KEY',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG_CONTENT',
] as const;

/** Whether a name belongs to the server or a freshly minted internal capability. */
export function isReservedRuntimeEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('DORKOS_') || RUNTIME_RESERVED_ENV_NAMES.some((key) => key === upper);
}

/** Exact owner-selected names; case collisions are forbidden on every platform. */
export const RuntimeInheritedEnvNamesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .refine(
        (name) => !isReservedRuntimeEnvName(name),
        'This server-only variable cannot be inherited.'
      )
  )
  .max(128)
  .superRefine((names, ctx) => {
    if (new Set(names.map((name) => name.toUpperCase())).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Environment variable names must be unique, including letter case.',
      });
    }
  })
  .default(() => []);

/** Complete default configuration for owner-controlled custom inheritance. */
export const RuntimeEnvironmentSchema = z
  .object({
    inherit: z
      .object({
        claudeCode: RuntimeInheritedEnvNamesSchema,
        codex: RuntimeInheritedEnvNamesSchema,
        opencode: RuntimeInheritedEnvNamesSchema,
      })
      .default(() => ({ claudeCode: [], codex: [], opencode: [] })),
  })
  .default(() => ({ inherit: { claudeCode: [], codex: [], opencode: [] } }));
