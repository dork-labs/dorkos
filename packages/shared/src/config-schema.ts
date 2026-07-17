import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
  'mcp.apiKey',
  'cloud.instanceToken',
] as const;

/**
 * Credential-reference schemes recognized by the `CredentialProvider` port
 * (ADR-0315). A stored credential is always one of these references, never a
 * raw secret.
 */
export const CREDENTIAL_SCHEMES = ['keychain', 'env', 'file'] as const;

/** One of the recognized {@link CREDENTIAL_SCHEMES}. */
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];

/**
 * A credential value stored in config is a REFERENCE, never plaintext:
 * `keychain:<id>` (OS keychain), `env:<VAR>` (process env), or `file:<name>`
 * (encrypted dork-home secret store). The value after the scheme must be
 * non-empty. This pattern is the schema-level guard that keeps raw secrets out
 * of `config.json` — a plaintext key (e.g. `sk-ant-...`) fails validation
 * (ADR-0315, decision: never persist plaintext).
 */
export const CREDENTIAL_REF_PATTERN = /^(?:keychain|env|file):.+/;

/**
 * Zod schema for a single credential reference value. Rejects anything that is
 * not a well-formed `keychain:`/`env:`/`file:` reference — the structural
 * guarantee that a raw secret can never be persisted as a provider value.
 */
export const CredentialReferenceSchema = z
  .string()
  .regex(CREDENTIAL_REF_PATTERN, 'must be a keychain:/env:/file: reference, never a raw secret');

/**
 * Split a credential reference into its `scheme` and `value`, or return `null`
 * when the string is not a well-formed reference (no colon, an unrecognized
 * scheme, or an empty value). The lone parser for the reference grammar — the
 * `CredentialProvider` port and the schema guard share this single definition.
 *
 * @param ref - The stored reference string (e.g. `env:OPENROUTER_API_KEY`).
 */
export function parseCredentialReference(
  ref: string
): { scheme: CredentialScheme; value: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const scheme = ref.slice(0, idx);
  const value = ref.slice(idx + 1);
  if (value.length === 0) return null;
  if (!(CREDENTIAL_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme: scheme as CredentialScheme, value };
}

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

export const SidebarGroupSchema = z.object({
  /** Stable id, `crypto.randomUUID()` minted client-side at creation. */
  id: z.string().min(1),
  /** Display name. Duplicates allowed (ids disambiguate). */
  name: z.string().trim().min(1).max(40),
  /** Ordered member agent projectPaths - the durable manual order. */
  agentPaths: z.array(z.string()).default(() => []),
  /** How rows inside this group are ordered. Switching away from 'manual' never mutates agentPaths. */
  sortMode: z.enum(['manual', 'recent', 'name']).default('manual'),
  collapsed: z.boolean().default(false),
});

/** A single user-defined sidebar group (Slack-style section). */
export type SidebarGroup = z.infer<typeof SidebarGroupSchema>;

export const SidebarPrefsSchema = z.object({
  /** Ordered pinned agent projectPaths. Multi-presence references - membership in groups is unaffected. */
  pinned: z.array(z.string()).default(() => []),
  groups: z.array(SidebarGroupSchema).default(() => []),
  /** Ungrouped section ("Agents"): no manual mode - groups are the place for manual curation. */
  ungroupedSortMode: z.enum(['name', 'recent']).default('name'),
  ungroupedCollapsed: z.boolean().default(false),
  recentsCollapsed: z.boolean().default(false),
  groupsHintDismissed: z.boolean().default(false),
});

/** Server-persisted sidebar organization preferences (`ui.sidebar`). */
export type SidebarPrefs = z.infer<typeof SidebarPrefsSchema>;

/**
 * Fully-defaulted {@link SidebarPrefs}. Parsed once from an empty object so the
 * config route and the client selector share one canonical default (the sidebar
 * always renders even before the first user write).
 */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = SidebarPrefsSchema.parse({});

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
    })
    .default(() => ({
      enabled: false,
      domain: null,
      authtoken: null,
      auth: null,
    })),
  ui: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).default('system'),
      dismissedUpgradeVersions: z
        .array(z.string())
        .default(() => [])
        .describe('Version strings the user has dismissed upgrade notifications for'),
      /** Server-persisted sidebar organization (groups, pinned, per-section sort/collapse). */
      sidebar: SidebarPrefsSchema.default(() => ({
        pinned: [],
        groups: [],
        ungroupedSortMode: 'name' as const,
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
      })),
    })
    .default(() => ({
      theme: 'system' as const,
      dismissedUpgradeVersions: [],
      sidebar: {
        pinned: [],
        groups: [],
        ungroupedSortMode: 'name' as const,
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
      },
    })),
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
  /**
   * Shared consent namespace for everything DorkOS can send to dorkos.ai, split
   * into two tiers (ADR 260713-143958):
   *
   * - **Tier 1 — anonymous, opt-out:** `install` and `heartbeat` default to
   *   `true`. These are genuinely anonymous aggregate signals (no IP, no
   *   fingerprint, no content, no paths — only a random per-machine id), so they
   *   collect by default, matching the Next.js/VS Code/Homebrew norm. They are
   *   still gated by the notice-before-first-send rule (`hasTier1SendGate`): a
   *   never-answered install sends nothing until its first-run notice has been
   *   shown and `lastPromptedVersion` recorded.
   * - **Tier 2 — identified/third-party, opt-in:** `errorReporting` defaults to
   *   `false` and never turns on without an explicit choice.
   *
   * `userHasDecided` is the one shared gate: it records that the user has
   * answered a consent prompt (kept sharing or turned off) so no channel
   * re-prompts. The namespace is deliberately per-channel so future work hangs
   * off the same object without a schema redesign. See the /telemetry page.
   */
  telemetry: z
    .object({
      /**
       * Shared consent gate. `true` once the user has answered a telemetry
       * consent prompt either way (kept sharing or turned off), which stops the
       * first-run consent banner from reappearing for any channel.
       */
      userHasDecided: z.boolean().default(false),
      /**
       * Tier 1 channel (anonymous, opt-out): send anonymous marketplace install
       * events to dorkos.ai so we can rank packages and spot install failures.
       * Defaults `true`; a never-answered install still sends nothing until the
       * first-run notice has been shown (see `hasTier1SendGate`). Formerly
       * `telemetry.enabled`. Privacy contract: https://dorkos.ai/marketplace/privacy
       */
      install: z.boolean().default(true),
      /**
       * Tier 1 channel (anonymous, opt-out): send a daily anonymous heartbeat to
       * dorkos.ai (instance id, version, OS/arch, configured runtimes, tunnel +
       * cloud-link flags, and rough counts — never prompts, code, paths, or
       * session content). Defaults `true`; a never-answered install still sends
       * nothing until the first-run notice has been shown (see
       * `hasTier1SendGate`). Payload documented verbatim at
       * https://dorkos.ai/telemetry.
       */
      heartbeat: z.boolean().default(true),
      /**
       * Tier 2 channel (opt-in): send scrubbed crash reports to DorkOS's own
       * ingest at dorkos.ai (which forwards to PostHog Error Tracking), never to
       * a third party. Defaults `false` and turns on only by an explicit opt-in
       * (never the first-run banner); the notice-before-send gate does not apply.
       * The raw message is never sent and paths/tokens are scrubbed. See ADR
       * 260711-153307 (scrubbing) + 260713-143958 Phase 6 (destination).
       */
      errorReporting: z.boolean().default(false),
      /**
       * The DorkOS version whose consent notice this install last saw, or `null`
       * if the user has never been prompted. Anchors the "re-prompt on a data
       * policy change" idiom (mirroring `dismissedUpgradeVersions`): a
       * never-answered install is only enrolled in the Tier 1 opt-out channels
       * after the first-run notice for that version has been shown. Read by
       * `hasTier1SendGate` to enforce notice-before-first-send. See ADR
       * 260713-143958.
       */
      lastPromptedVersion: z.string().nullable().default(null),
      /**
       * Channel: send curated, anonymous feature-usage events to dorkos.ai
       * (e.g. `app_started`, `session_created`) so we can see adoption funnels
       * and which runtimes get used. Curated named events only — never
       * autocaptured, never prompts, code, paths, or session content; the exact
       * catalog lives in `@dorkos/shared/telemetry-events`.
       *
       * Tier 1 posture (ADR 260713-143958 Phase 3): defaults to `true`, but like
       * `heartbeat`/`install` it never sends until the first-run notice gate is
       * satisfied (`userHasDecided` or `lastPromptedVersion` set), so a
       * never-prompted install stays silent. Payload documented verbatim at
       * https://dorkos.ai/telemetry.
       */
      usage: z.boolean().default(true),
      /**
       * Tier 2 channel (opt-in): when linking this install to a DorkOS account,
       * also include the anonymous per-install telemetry `instanceId` in the
       * device-link descriptor, so the cloud can merge this install's anonymous
       * usage history onto the signed-in account person (DOR-320, ADR
       * 260713-143958 Phase 4). Defaults `false` and turns on only by an explicit
       * choice in the account-link flow (never the first-run banner); the env
       * kill switches (`DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`) suppress it
       * too. The app treats this flag as the sole opt-in signal: the id is
       * threaded into the link descriptor ONLY when this is `true`, and its
       * presence there is what the site reads to alias the anonymous history (see
       * the app-side `cloud-link-client.ts` and the site's
       * `aliasInstanceToAccount`). The alias fires at link time, so opting in
       * after already linking only takes effect on a future re-link.
       */
      linkAnalyticsToAccount: z.boolean().default(false),
      /**
       * Tier 2 channel (opt-in): bridge anonymous AI-run METADATA to DorkOS's
       * own ingest at dorkos.ai (which forwards to PostHog's LLM analytics) — one
       * `$ai_generation` event per completed agent turn carrying only the model,
       * the runtime, token counts, timing, and cost. Never prompts, code, file
       * paths, or conversation content. Defaults `false` and turns on only by an
       * explicit opt-in (never the first-run banner); the notice-before-send gate
       * does not apply. Independent of `usage`. See ADR 260713-143958 Phase 7 and
       * https://dorkos.ai/telemetry.
       */
      aiMetadata: z.boolean().default(false),
    })
    .default(() => ({
      userHasDecided: false,
      install: true,
      heartbeat: true,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: true,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    })),
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
  harness: z
    .object({
      /**
       * Whether installing or uninstalling a marketplace plugin automatically
       * runs Harness Sync projection (re-projecting `.agents/` + installed
       * plugins to every harness). Defaults to `true`; set `false` to manage
       * projection manually via `dorkos harness sync`.
       */
      autoSync: z.boolean().default(true),
    })
    .default(() => ({ autoSync: true })),
  workbench: z
    .object({
      /**
       * Overrides for the mime→viewer registry: maps a file extension (with or
       * without a leading dot, any case) to the canvas viewer that opens it,
       * taking precedence over the built-in defaults. Lets an operator, e.g.,
       * open `.csv` files in the plain text editor instead of the table viewer
       * without a code change (workbench D7). Empty by default.
       */
      defaultViewers: z
        .record(z.string(), z.enum(['file', 'markdown', 'image', 'pdf', 'model3d', 'csv']))
        .default(() => ({})),
      /**
       * Grace period, in minutes, that a detached embedded-terminal PTY is kept
       * alive after its last socket disconnects, so a page refresh can re-attach
       * to the live shell instead of orphaning it (DOR-225). Output produced
       * while detached is buffered and replayed on the next attach; once the
       * window lapses with no re-attach, the PTY is reclaimed. Default 10.
       */
      terminalGraceTtlMinutes: z.number().int().min(1).max(120).default(10),
      /**
       * Whether DorkOS auto-opens a diff document in the workbench when the
       * attached session's agent edits a file (DOR-212). On by default so the
       * operator sees what changed without asking; set `false` to keep the canvas
       * on whatever the operator last opened (the agent can still surface a diff
       * deliberately via the `open_diff` UI command).
       */
      autoOpenDiff: z.boolean().default(true),
    })
    .default(() => ({ defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: true })),
  runtimes: z
    .object({
      /** Runtime id the registry selects as its default at boot. */
      default: z.string().default('claude-code'),
      opencode: z
        .object({
          enabled: z.boolean().default(true),
          /** Absolute path to the `opencode` binary; `null` resolves from PATH. */
          binaryPath: z.string().nullable().default(null),
          /** Sidecar server port; `0` picks an ephemeral port. */
          port: z.number().int().min(0).max(65535).default(0),
          /**
           * Selected provider id keying into the top-level {@link UserConfig.providers}
           * registry (e.g. `openrouter`, `openai`, `ollama`). `null` = no provider
           * chosen; the sidecar falls back to OpenCode's own host auth (ADR-0315).
           */
          provider: z.string().nullable().default(null),
          /**
           * Optional OpenAI-compatible base URL for a Direct provider (injected as
           * `OPENAI_BASE_URL` into the sidecar env). `null` = the provider default.
           */
          baseURL: z.string().nullable().default(null),
        })
        .default(() => ({
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: null,
          baseURL: null,
        })),
      codex: z
        .object({
          enabled: z.boolean().default(true),
          /** Absolute path to the `codex` binary; `null` resolves from PATH. */
          binaryPath: z.string().nullable().default(null),
          /**
           * Credential reference for Codex's API key (`keychain:`/`env:`/`file:`),
           * never a raw secret. `null` = delegate to `codex login` (ADR-0315). Codex
           * never receives its key via a subprocess env var — it never sets
           * `CodexOptions.env` — so this reference feeds the delegated-login path.
           */
          credentialRef: CredentialReferenceSchema.nullable().default(null),
        })
        .default(() => ({ enabled: true, binaryPath: null, credentialRef: null })),
    })
    .default(() => ({
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: null },
    })),
  auth: z
    .object({
      /**
       * Whether local login (Better Auth) is required to use this instance.
       * Defaults to `false`: no auth gate runs and DorkOS shows no user concept
       * anywhere (progressive disclosure). The enable-login flow creates the
       * owner account and then flips this to `true`. See the accounts-and-auth
       * spec.
       */
      enabled: z.boolean().default(false),
    })
    .default(() => ({ enabled: false })),
  cloud: z
    .object({
      /**
       * The scoped instance API key issued by the DorkOS cloud when this
       * instance is device-linked to an account (accounts-and-auth P2). Held as
       * the credential for `POST /api/instances/heartbeat`; a `401` from the
       * cloud means it was revoked (unlinked). Sensitive — see
       * {@link SENSITIVE_CONFIG_KEYS}. `null` when this instance is not linked.
       */
      instanceToken: z.string().nullable().default(null),
      /** This instance's display name registered with the cloud (typically the hostname). */
      instanceName: z.string().nullable().default(null),
      /** Human-readable label of the linked DorkOS account, when the cloud reports one. */
      linkedAccountLabel: z.string().nullable().default(null),
    })
    .default(() => ({ instanceToken: null, instanceName: null, linkedAccountLabel: null })),
  /**
   * Per-provider credential references, keyed by a stable provider id
   * (`anthropic`, `openrouter`, `openai`, …). Values are references
   * (`keychain:`/`env:`/`file:`), NEVER raw secrets — the connect endpoints
   * write a reference here and the `CredentialProvider` port resolves it at the
   * runtime env-injection seam (ADR-0315).
   */
  providers: z.record(z.string(), CredentialReferenceSchema).default(() => ({})),
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
