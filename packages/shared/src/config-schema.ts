import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = ['tunnel.authtoken', 'tunnel.auth'] as const;

/** The three guided onboarding steps a first-time user walks through. */
export const ONBOARDING_STEPS = ['discovery', 'pulse', 'adapters'] as const;

export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingStateSchema = z.object({
  completedSteps: z.array(OnboardingStepSchema).default(() => []),
  skippedSteps: z.array(OnboardingStepSchema).default(() => []),
  startedAt: z.string().nullable().default(null),
  dismissedAt: z.string().nullable().default(null),
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxLogSizeKb: z.number().int().min(100).max(10240).default(500),
  maxLogFiles: z.number().int().min(1).max(30).default(14),
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
      dismissedUpgradeVersions: z
        .array(z.string())
        .default(() => [])
        .describe('Version strings the user has dismissed upgrade notifications for'),
    })
    .default(() => ({ theme: 'system' as const, dismissedUpgradeVersions: [] })),
  logging: LoggingConfigSchema.default(() => ({
    level: 'info' as const,
    maxLogSizeKb: 500,
    maxLogFiles: 14,
  })),
  relay: z
    .object({
      enabled: z.boolean().default(true),
      dataDir: z.string().nullable().default(null),
    })
    .default(() => ({ enabled: true, dataDir: null })),
  scheduler: z
    .object({
      enabled: z.boolean().default(true),
      maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
      timezone: z.string().nullable().default(null),
      retentionCount: z.number().int().min(1).default(100),
    })
    .default(() => ({
      enabled: true,
      maxConcurrentRuns: 1,
      timezone: null,
      retentionCount: 100,
    })),
  mesh: z
    .object({
      scanRoots: z.array(z.string()).default(() => []),
    })
    .default(() => ({ scanRoots: [] })),
  onboarding: OnboardingStateSchema.default(() => ({
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: null,
  })),
  agentContext: z
    .object({
      relayTools: z.boolean().default(true),
      meshTools: z.boolean().default(true),
      adapterTools: z.boolean().default(true),
      pulseTools: z.boolean().default(true),
    })
    .default(() => ({ relayTools: true, meshTools: true, adapterTools: true, pulseTools: true })),
  uploads: z
    .object({
      maxFileSize: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024), // 10MB
      maxFiles: z.number().int().min(1).max(50).default(10),
      allowedTypes: z.array(z.string()).default(() => ['*/*']),
    })
    .default(() => ({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
      allowedTypes: ['*/*'],
    })),
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
