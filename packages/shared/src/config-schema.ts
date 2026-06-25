import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
  'tunnel.passcodeHash',
  'tunnel.passcodeSalt',
  'mcp.apiKey',
] as const;

/** The guided onboarding steps a first-time user walks through. */
export const ONBOARDING_STEPS = ['meet-dorkbot', 'discovery', 'tasks', 'adapters'] as const;

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
      open: z.boolean().default(true),
    })
    .default(() => ({ port: 4242, cwd: null, boundary: null, open: true })),
  tunnel: z
    .object({
      enabled: z.boolean().default(false),
      domain: z.string().nullable().default(null),
      authtoken: z.string().nullable().default(null),
      auth: z.string().nullable().default(null),
      passcodeEnabled: z.boolean().default(false),
      passcodeHash: z.string().nullable().default(null),
      passcodeSalt: z.string().nullable().default(null),
    })
    .default(() => ({
      enabled: false,
      domain: null,
      authtoken: null,
      auth: null,
      passcodeEnabled: false,
      passcodeHash: null,
      passcodeSalt: null,
    })),
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
      tasksTools: z.boolean().default(true),
    })
    .default(() => ({ relayTools: true, meshTools: true, adapterTools: true, tasksTools: true })),
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
  agents: z
    .object({
      defaultDirectory: z.string().default('~/.dork/agents'),
      defaultAgent: z.string().default('dorkbot'),
    })
    .default(() => ({ defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' })),
  extensions: z
    .object({
      // Both lists record DEVIATIONS from each extension's default state, à la
      // JetBrains' `disabled_plugins.txt` generalized to two defaults.
      /** Extension IDs the user turned ON that default OFF (user/marketplace + default-off core). */
      enabled: z.array(z.string()).default(() => []),
      /** Extension IDs the user turned OFF that default ON (default-on core). */
      disabled: z.array(z.string()).default(() => []),
    })
    .default(() => ({ enabled: [], disabled: [] })),
  mcp: z
    .object({
      enabled: z.boolean().default(true),
      apiKey: z.string().nullable().default(null),
      rateLimit: z
        .object({
          enabled: z.boolean().default(true),
          maxPerWindow: z.number().int().min(1).max(1000).default(60),
          windowSecs: z.number().int().min(1).max(3600).default(60),
        })
        .default(() => ({ enabled: true, maxPerWindow: 60, windowSecs: 60 })),
    })
    .default(() => ({
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    })),
  telemetry: z
    .object({
      /**
       * Whether to send opt-in marketplace install events to dorkos.ai.
       *
       * Defaults to `false`. The user must explicitly enable this in their
       * config file or via the in-product toggle. Privacy contract:
       * https://dorkos.ai/marketplace/privacy
       */
      enabled: z.boolean().default(false),
      /**
       * True once the user has explicitly chosen (opt-in or opt-out) so the
       * in-product consent banner stops appearing on the Dork Hub page.
       */
      userHasDecided: z.boolean().default(false),
    })
    .default(() => ({ enabled: false, userHasDecided: false })),
  workspace: z
    .object({
      /** Whether the WorkspaceManager is active (binding sessions, allocating ports). */
      enabled: z.boolean().default(true),
      /** Workspace root override; `null` resolves to `<dorkHome>/workspaces`. */
      rootPath: z.string().nullable().default(null),
      /** First port of the allocation pool. */
      portBase: z.number().int().min(1024).max(65535).default(4250),
      /** Contiguous ports reserved per workspace (≥3 for DORKOS/VITE/SITE). */
      portBlockSize: z.number().int().min(3).max(100).default(10),
      /** Default provider when a caller does not specify one. */
      defaultProvider: z.enum(['worktree', 'clone']).default('worktree'),
      /** Optional cap on retained workspaces; `null` disables the age/cap sweep. */
      retentionCap: z.number().int().min(0).nullable().default(null),
    })
    .default(() => ({
      enabled: true,
      rootPath: null,
      portBase: 4250,
      portBlockSize: 10,
      defaultProvider: 'worktree' as const,
      retentionCap: null,
    })),
  sessionSecret: z.string().nullable().default(null),
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
