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
import type { ServerConfig } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';

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
  dismissedUpgradeVersions: [],
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
    url: null,
    port: null,
    startedAt: null,
    authEnabled: false,
    tokenConfigured: false,
    domain: null,
  },
  tasks: { enabled: true },
  relay: { enabled: true },
  scheduler: {
    maxConcurrentRuns: 3,
    timezone: null,
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
      { path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
      { path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true },
      { path: '/Users/dev/.claude3', label: null, isAccountRoot: true },
      { path: '/Users/dev/.claude-new', label: 'Just signed up', isAccountRoot: false },
    ],
  },
};

/**
 * Mock `AgentManifest` consumed by the `AgentDialog` showcase and the
 * full Agent dialog section. Models a non-system agent so the dialog
 * renders the editable affordances (rename, delete, persona editor)
 * rather than the read-only system-agent state.
 */
export const MOCK_AGENT_MANIFEST: AgentManifest = {
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
    dorkosKnowledge: true,
  },
  color: '#3b82f6',
  icon: '🤖',
  isSystem: false,
  enabledToolGroups: {},
  mcpServers: [],
};

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
