/**
 * Static mock data for the Settings playground showcases.
 *
 * The Settings showcases (`SettingsShowcases.tsx`) render real production
 * components such as `ServerTab`, `ToolsTab`, and `ClaudeAccountsCard`
 * inside a `MockedQueryProvider` that primes the TanStack Query cache with
 * the literals exported from this module. The dev playground uses
 * `createPlaygroundTransport()` which returns `null` for every request, so
 * showcases must be entirely self-sufficient — no network, no SSE, no
 * real Mesh agents on disk.
 *
 * The literals are typed against the canonical Zod-derived types so the
 * TypeScript compiler enforces shape parity with the live schemas. If a
 * field is added or renamed in `packages/shared/src/schemas.ts` or
 * `packages/shared/src/mesh-schemas.ts`, this file will fail to compile
 * and the playground will be updated in lockstep.
 *
 * @module dev/showcases/settings-mock-data
 */
import {
  NOTIFICATION_PREFS_DEFAULTS,
  ROOM_TURN_LIMIT_DEFAULTS,
} from '@dorkos/shared/config-schema';
import type { EffortLevel, ModelOption, ServerConfig } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type {
  PermissionModeDescriptor,
  PermissionStop,
  RuntimeSettingsCapability,
} from '@dorkos/shared/agent-runtime';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { ExecutionException } from '@/layers/entities/agent';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { buildRuntimeCardSummary, type RuntimeCardViewProps } from '@/layers/features/settings';
import { PLAYGROUND_CAPABILITIES } from '../playground-transport';

/**
 * Realistic mock `ServerConfig` consumed by the `ServerTab`, `ToolsTab`,
 * `AdvancedTab`, and full Settings dialog showcases.
 *
 * Values are chosen to look plausible in screenshots: a recent version,
 * the production default port, a multi-hour uptime, and feature flags
 * enabled for Tasks, Relay, and Mesh so the corresponding tabs render
 * their populated state rather than the disabled placeholder.
 */
export const MOCK_SERVER_CONFIG: ServerConfig = {
  version: '0.30.0',
  latestVersion: '0.30.0',
  isDevMode: false,
  // The playground is opened on the machine DorkOS runs on, so every showcase
  // renders the local variant of anything that degrades remotely.
  isLocalCaller: true,
  dismissedUpgradeVersions: [],
  dismissedPromoIds: [],
  // The shipped defaults, so the Notifications tab renders its out-of-the-box
  // state: the knock and the all-clear on, the every-turn chime off.
  notifications: NOTIFICATION_PREFS_DEFAULTS,
  // The shipped defaults again, so the Rooms tab renders its out-of-the-box
  // state rather than the skeleton it shows before the numbers have been read.
  rooms: {
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
    ...ROOM_TURN_LIMIT_DEFAULTS,
  },
  port: 4242,
  uptime: 12_345,
  workingDirectory: '/Users/dev/dorkos',
  nodeVersion: 'v22.10.0',
  platform: 'darwin-arm64',
  runtimes: ['claude-code', 'codex', 'opencode'],
  claudeCliPath: '/usr/local/bin/claude',
  // A default install: nothing registered, so the account card shows only the
  // inherited default and the sidebar badges stay hidden.
  claudeCode: {
    resolvedAccount: '/Users/dev/.claude',
    inherited: true,
    accounts: [],
  },
  tunnel: {
    enabled: false,
    connected: false,
    isRunning: false,
    url: null,
    port: null,
    startedAt: null,
    authEnabled: false,
    tokenConfigured: false,
    domain: null,
  },
  // Both background systems are running AND on in config, which is the state a
  // person almost always sees. The Tools tab's background-system switches read
  // the config value and compare it with the running one to decide whether to
  // say a restart is pending.
  tasks: { enabled: true, enabledInConfig: true, lockedByEnv: false },
  relay: { enabled: true, enabledInConfig: true, lockedByEnv: false },
  // The registry as it ships: one experiment, off and switchable. It used to
  // hold two — the warm-agents flag GRADUATED (spec `full-power-defaults`), and
  // a playground row for a switch the product no longer has is a mock that
  // teaches the wrong shape. The survivor carries a cost note and the
  // environment variable that can overrule it, matching its real registry entry,
  // so the two derived fixtures below (locked-by-env, and the empty registry
  // every graduation moves the list towards) both render what actually ships.
  experiments: [
    {
      key: 'a2a.enabled',
      title: 'Let outside agents reach yours',
      description:
        'Agents built by other people, on other systems, can send work to the agents here.',
      costNote:
        'Early alpha, and it opens a door: only turn it on when you know what is on the other side of it.',
      envOverride: 'DORKOS_A2A_ENABLED',
      enabled: false,
      lockedByEnv: false,
    },
  ],
  scheduler: {
    maxConcurrentRuns: 3,
    retentionCount: 100,
  },
  logging: {
    level: 'info',
    maxLogSizeKb: 500,
    maxLogFiles: 14,
  },
  boundary: '/Users/dev',
  dorkHome: '/Users/dev/.dork',
  mesh: {
    enabled: true,
    scanRoots: [],
  },
  onboarding: {
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: null,
    completedAt: null,
    runtimeDefaultSetAt: null,
  },
  agentContext: {
    relayTools: true,
    meshTools: true,
    adapterTools: true,
    tasksTools: true,
  },
  agents: {
    defaultDirectory: '/Users/dev/dorkos/agents',
    defaultAgent: 'dorkbot',
  },
  mcp: {
    enabled: false,
    authConfigured: false,
    authSource: 'none',
    endpoint: 'http://localhost:4242/mcp',
    rateLimit: {
      enabled: false,
      maxPerWindow: 60,
      windowSecs: 60,
    },
  },
};

/**
 * Server config where an environment variable has taken the A2A experiment over.
 *
 * The switch has to show the VARIABLE's position and refuse to pretend it
 * decides — a locked row showing the inert setting would put "off" over a machine
 * where the surface is mounted.
 */
export const MOCK_SERVER_CONFIG_EXPERIMENT_LOCKED: ServerConfig = {
  ...MOCK_SERVER_CONFIG,
  experiments: (MOCK_SERVER_CONFIG.experiments ?? []).map((experiment) =>
    experiment.lockedByEnv || !experiment.key.startsWith('a2a')
      ? experiment
      : { ...experiment, enabled: true, lockedByEnv: true }
  ),
};

/**
 * Server config with the registry emptied — the state every flag graduating
 * leaves behind, and the one the tab must handle without looking broken.
 */
export const MOCK_SERVER_CONFIG_NO_EXPERIMENTS: ServerConfig = {
  ...MOCK_SERVER_CONFIG,
  experiments: [],
};

/**
 * Server config for an operator running one Claude account per client, with a
 * chosen active account (spec `claude-code-accounts`). Drives the account card's
 * populated state: a roster, an "in use" marker, and a folder DorkOS cannot read
 * as an account (`isAccountRoot: false`, the structural `projects/` check).
 */
export const MOCK_SERVER_CONFIG_MULTI_ACCOUNT: ServerConfig = {
  ...MOCK_SERVER_CONFIG,
  claudeCode: {
    resolvedAccount: '/Users/dev/.claude2',
    inherited: false,
    accounts: [
      { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
      { id: 'acme-corp', path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true },
      { id: 'claude3', path: '/Users/dev/.claude3', label: null, isAccountRoot: true },
      {
        id: 'just-signed-up',
        path: '/Users/dev/.claude-new',
        label: 'Just signed up',
        isAccountRoot: false,
      },
    ],
  },
};

/**
 * Mock `AgentManifest` consumed by the `AgentDialog` showcase and the
 * full Agent dialog section. Models a non-system agent so the dialog
 * renders the editable affordances (rename, delete, persona editor)
 * rather than the read-only system-agent state.
 */
const MOCK_AGENT_MANIFEST: AgentManifest = {
  workspace: { mode: 'home' },
  id: 'mock-agent-01',
  name: 'Mock Agent',
  description: 'A static agent used for playground showcases.',
  runtime: 'claude-code',
  capabilities: ['code-review', 'refactoring'],
  behavior: { responseMode: 'always' },
  registeredAt: '2026-01-01T00:00:00.000Z',
  registeredBy: 'playground',
  persona: 'You are Mock Agent, a calm and concise reviewer used in the dev playground.',
  personaEnabled: true,
  traits: DEFAULT_TRAITS,
  conventions: {
    soul: true,
    nope: true,
    memory: true,
    dorkosKnowledge: true,
  },
  color: '#3b82f6',
  icon: '🤖',
  isSystem: false,
  enabledToolGroups: {},
  mcpServers: [],
};

/**
 * The model catalog a runtime card is handed, in the shape `GET /api/models`
 * answers with.
 *
 * Three entries because the Effort row needs all three cases to be reachable: a
 * model that takes every rung, one that takes a narrower ladder, and one that
 * takes no effort at all — which is what makes the "saved here and does nothing"
 * affordance visible in the playground.
 */
const MOCK_RUNTIME_MODELS: ModelOption[] = [
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'The most capable model.',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'claude-sonnet-4-5-20250929',
    displayName: 'Sonnet 4.5',
    description: 'Fast, and capable enough for most work.',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    description: 'The quick one.',
    supportsEffort: false,
  },
];

/** A model id no catalog offers any more — the `(no longer offered)` case. */
export const MOCK_RETIRED_MODEL_ID = 'claude-opus-3';

/**
 * The modes a runtime declared, read from the playground's capability mirror.
 *
 * Never a hand-written list: a dial's whole job is to render what a runtime said
 * about itself, so a fixture written here would demonstrate the fixture.
 *
 * @param type - Runtime type id, e.g. `'claude-code'`.
 * @returns Its declared modes, or none for a runtime the mirror has never heard of.
 */
function playgroundRuntimeModes(type: string): PermissionModeDescriptor[] {
  return PLAYGROUND_CAPABILITIES[type]?.permissionModes?.values ?? [];
}

/**
 * The settings surface a runtime declared — whether it takes an effort, and
 * which bespoke sections its card carries.
 *
 * @param type - Runtime type id, e.g. `'opencode'`.
 * @returns Its declared settings capability, or undefined when it declares none.
 */
function playgroundRuntimeSettings(type: string): RuntimeSettingsCapability | undefined {
  return PLAYGROUND_CAPABILITIES[type]?.settings;
}

/** The state a showcase puts one runtime card in. */
export interface RuntimeCardShowcaseOptions {
  /** Runtime type id, e.g. `'claude-code'`. */
  type?: string;
  /** Whether the runtime can start a conversation right now. */
  ready?: boolean;
  /** Whether new conversations start on this runtime. */
  isDefault?: boolean;
  /** Whether the body is open. */
  expanded?: boolean;
  /** The catalog the Model row offers; omit for the standard three. */
  models?: ModelOption[] | undefined;
  /** The configured model id, or `null` for the runtime's own choice. */
  model?: string | null;
  /** The configured effort, or `null` for the runtime's own choice. */
  effort?: EffortLevel | null;
  /** This runtime's own stop, or `null` when it follows the shared row. */
  trustStop?: PermissionStop | null;
  /** What the shared row is set to — what a `null` above resolves through. */
  globalStop?: PermissionStop;
  /** Resolved display values for the runtime's declared sections. */
  sectionValues?: Record<string, string | null>;
  /**
   * Whether the runtime has anywhere to keep the three standing rows. Omit and
   * it is read off the runtime's own declaration, exactly as the container reads
   * it; pass `false` to show the card a runtime with no `configSection` gets.
   */
  storesDefaults?: boolean;
  /** Open the body. Showcases that drive expansion themselves pass their own. */
  onToggleExpanded?: () => void;
  /** Offer Make default. Pass `null` for a surface that does not offer it. */
  onMakeDefault?: (() => void) | null;
  /**
   * The flow a connected runtime can reopen — "Fix sign-in" or "Change". Worth
   * passing on a phone showcase: it is the second affordance the header hands to
   * the opened body at that width.
   */
  reconnect?: RuntimeCardViewProps['reconnect'];
  /**
   * What the card's "Setup details" section holds — the dependency rows or the
   * install hint a runtime this server has not registered offers. Omit and the
   * card offers no such section, which is what a registered runtime shows.
   */
  setupDetails?: RuntimeCardViewProps['setupDetails'];
}

/** A handler a showcase does not care about. */
function noop() {}

/**
 * Build one runtime card's props, with the summary line computed by the real
 * `buildRuntimeCardSummary` rather than written out here.
 *
 * That last part is the point. The collapsed line is the card's whole answer at
 * rest, and its rules are pure — so the showcase feeds the same input the
 * container feeds and shows the line the app would draw, including the absences
 * (no effort segment on a runtime that takes none, no summary at all on one that
 * is not connected).
 *
 * @param options - See {@link RuntimeCardShowcaseOptions}.
 * @returns Props ready to spread onto `RuntimeCardView`.
 */
export function createRuntimeCardProps(
  options: RuntimeCardShowcaseOptions = {}
): RuntimeCardViewProps {
  const {
    type = 'claude-code',
    ready = true,
    isDefault = false,
    expanded = false,
    models = MOCK_RUNTIME_MODELS,
    model = 'claude-opus-4-6',
    effort = 'high',
    trustStop = null,
    globalStop = 'ask',
    sectionValues,
    onToggleExpanded = noop,
    onMakeDefault = noop,
    reconnect,
    setupDetails,
  } = options;

  const settings = playgroundRuntimeSettings(type);
  // The container's own rule, not a second one: a declaration that has not
  // arrived reads as "yes", and only an explicit `configSection: null` says no.
  const storesDefaults =
    options.storesDefaults ?? (settings ? settings.configSection !== null : true);
  const selectedModel = model === null ? undefined : models?.find((m) => m.value === model);

  const { subtitle } = getRuntimeDescriptor(type);

  return {
    type,
    // From the registry, like the container reads it: the showcase shows the
    // identity line the app shows, and a runtime without one shows none.
    ...(subtitle ? { subtitle } : {}),
    ready,
    isDefault,
    expanded,
    onToggleExpanded,
    onMakeDefault: onMakeDefault ?? undefined,
    ...(reconnect ? { reconnect } : {}),
    ...(setupDetails ? { setupDetails } : {}),
    summary: buildRuntimeCardSummary({
      ready,
      settings,
      model,
      models,
      effort,
      // The same second answer the Effort row gets, so the showcase's collapsed
      // line cannot promise an effort its own opened card calls stranded.
      modelTakesEffort: selectedModel ? (selectedModel.supportsEffort ?? false) : undefined,
      trustStop: trustStop ?? globalStop,
      trustInherited: trustStop === null,
      ...(sectionValues ? { sectionValues } : {}),
    }),
    model: { models, value: model, onChange: noop },
    effort: {
      supportsEffort: settings?.supportsEffort ?? false,
      selectedModel,
      configuredModelId: model,
      value: effort,
      onChange: noop,
    },
    trust: {
      descriptors: playgroundRuntimeModes(type),
      stop: trustStop,
      globalStop,
      onChange: noop,
    },
    storesDefaults,
    sections: settings?.sections ?? [],
  };
}

/**
 * A fleet that does not run on the defaults — one row per breakage kind, plus
 * healthy deviations, in the order the strip's own hook would emit them.
 *
 * The ordering is the caller's, and that is worth showing: the strip renders
 * what it is handed, so broken rows come first because
 * `useExecutionExceptions` sorted them there, not because the strip re-sorts.
 * Which means this array has to BE that order — broken first, then by name —
 * or the showcase demonstrates a sort the hook does not perform.
 */
export const MOCK_EXECUTION_EXCEPTIONS: ExecutionException[] = [
  {
    path: '/Users/dev/projects/data-pipeline',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-02',
      name: 'data-pipeline',
      icon: '🧪',
      color: '#8b5cf6',
    },
    report: {
      breakages: [
        { kind: 'model-unavailable', message: 'Opus 3 is no longer offered by Claude Code.' },
        {
          kind: 'effort-unsupported-model',
          message: 'High effort does nothing on the model it is set with.',
        },
      ],
      deviations: [],
      isException: true,
      isBroken: true,
    },
  },
  {
    path: '/Users/dev/projects/docs-site',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-03',
      name: 'docs-site',
      icon: '📘',
      color: '#0ea5e9',
    },
    report: {
      breakages: [
        {
          kind: 'effort-unsupported-runtime',
          message: 'OpenCode has no effort setting, so this one does nothing.',
        },
      ],
      deviations: [{ field: 'runtime', label: 'OpenCode' }],
      isException: true,
      isBroken: true,
    },
  },
  {
    path: '/Users/dev/projects/legacy-api',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-01',
      name: 'legacy-api',
      icon: '🗄️',
      color: '#f97316',
    },
    report: {
      breakages: [{ kind: 'runtime-not-connected', message: 'Codex is not connected.' }],
      deviations: [{ field: 'runtime', label: 'Codex' }],
      isException: true,
      isBroken: true,
    },
  },
  {
    path: '/Users/dev/projects/retired-client',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-04',
      name: 'retired-client',
      icon: '🧾',
      color: '#ef4444',
    },
    report: {
      breakages: [
        {
          kind: 'account-unregistered',
          message:
            'The account “acme-legacy” isn’t registered on this machine, so this agent bills to the default.',
        },
      ],
      deviations: [{ field: 'account', label: 'acme-legacy' }],
      isException: true,
      isBroken: true,
    },
  },
  {
    path: '/Users/dev/projects/client-work',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-06',
      name: 'client-work',
      icon: '💼',
      color: '#eab308',
    },
    report: {
      breakages: [],
      deviations: [{ field: 'account', label: 'Acme Corp' }],
      isException: true,
      isBroken: false,
    },
  },
  {
    path: '/Users/dev/projects/marketing',
    agent: {
      ...MOCK_AGENT_MANIFEST,
      id: 'exception-05',
      name: 'marketing',
      icon: '📣',
      color: '#22c55e',
    },
    report: {
      breakages: [],
      deviations: [
        { field: 'model', label: 'Sonnet 4.5' },
        { field: 'effort', label: 'Low' },
      ],
      isException: true,
      isBroken: false,
    },
  },
];

/** The healthy half of {@link MOCK_EXECUTION_EXCEPTIONS} — deviations, nothing broken. */
export const MOCK_EXECUTION_DEVIATIONS: ExecutionException[] = MOCK_EXECUTION_EXCEPTIONS.filter(
  (exception) => !exception.report.isBroken
);

/**
 * Mock mesh agents listing. Mirrors the shape returned by
 * `Transport.listMeshAgents()` (`{ agents: AgentManifest[] }`) so
 * `settings-showcase-helpers.tsx`'s `MockedQueryProvider` can prime the
 * TanStack Query cache via `setQueryData(['mesh', 'agents'], MOCK_MESH_AGENTS)`,
 * giving any showcase that reads the mesh-agents query real data without
 * network or adapter glue.
 *
 * Includes one system agent (`dorkbot`) and one user agent so consumers can
 * exercise both the read-only system variant and the editable user variant.
 */
export const MOCK_MESH_AGENTS: { agents: AgentManifest[] } = {
  agents: [
    {
      workspace: { mode: 'home' as const },
      id: 'dorkbot',
      name: 'dorkbot',
      description: 'The DorkOS system agent — your guide and background worker.',
      runtime: 'claude-code',
      capabilities: ['orchestration', 'summaries'],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'system',
      personaEnabled: true,
      isSystem: true,
      enabledToolGroups: {},
      mcpServers: [],
    },
    MOCK_AGENT_MANIFEST,
  ],
};
