import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
] as const;

export const UserConfigSchema = z.object({
  version: z.literal(1),
  server: z
    .object({
      port: z.number().int().min(1024).max(65535).default(4242),
      cwd: z.string().nullable().default(null),
    })
    .default(() => ({ port: 4242, cwd: null })),
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
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Defaults extracted from schema for conf constructor */
export const USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse({
  version: 1,
});
