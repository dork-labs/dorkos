/**
 * Static mock data for the Settings playground showcases.
 *
 * The Settings showcases (`SettingsShowcases.tsx`) render real production
 * components such as `ServerTab`, `ToolsTab`, `AgentDialog`, and `AgentsTab`
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
  claudeCliPath: '/usr/local/bin/claude',
  tunnel: {
    enabled: false,
    connected: false,
    url: null,
    port: null,
    startedAt: null,
    authEnabled: false,
    tokenConfigured: false,
    domain: null,
    passcodeEnabled: false,
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
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00.000Z',
  registeredBy: 'playground',
  persona: 'You are Mock Agent, a calm and concise reviewer used in the dev playground.',
  personaEnabled: true,
  traits: {
    tone: 3,
    autonomy: 3,
    caution: 3,
    communication: 3,
    creativity: 3,
  },
  conventions: {
    soul: true,
    nope: true,
    dorkosKnowledge: true,
  },
  color: '#3b82f6',
  icon: '🤖',
  isSystem: false,
  enabledToolGroups: {},
};

/**
 * Mock mesh agents listing consumed by the `AgentsTab` showcase. Mirrors
 * the shape returned by `Transport.listMeshAgents()` (`{ agents: AgentManifest[] }`)
 * so the showcase can prime the TanStack Query cache via
 * `setQueryData(['mesh', 'agents'], MOCK_MESH_AGENTS)` without any
 * adapter glue.
 *
 * Includes one system agent (`dorkbot`) and one user agent so the tab
 * exercises both row variants — the system row is read-only while the
 * user row exposes edit/delete affordances.
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
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'system',
      personaEnabled: true,
      isSystem: true,
      enabledToolGroups: {},
    },
    MOCK_AGENT_MANIFEST,
  ],
};
