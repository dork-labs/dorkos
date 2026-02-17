import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
] as const;

const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export const UserConfigSchema = z.object({
  version: z.literal(1),
  server: z
    .object({
      port: z.number().int().min(1024).max(65535).default(4242),
      cwd: z.string().nullable().default(null),
      boundary: z.string().nullable().default(null),
    })
    .default(() => ({ port: 4242, cwd: null, boundary: null })),
  tunnel: z
    .object({
      enabled: z.boolean().default(false),
      domain: z.string().nullable().default(null),
      authtoken: z.string().nullable().default(null),
      auth: z.string().nullable().default(null),
    })
    .default(() => ({ enabled: false, domain: null, authtoken: null, auth: null })),
  ui: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).default('system'),
    })
    .default(() => ({ theme: 'system' as const })),
  logging: LoggingConfigSchema.default(() => ({ level: 'info' as const })),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Maps log level names to numeric values for consola compatibility */
export const LOG_LEVEL_MAP: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** Defaults extracted from schema for conf constructor */
export const USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse({
  version: 1,
});
