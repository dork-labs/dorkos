import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { Session, StreamEvent, CommandEntry, PulseSchedule, PulseRun } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoadmapItem, RoadmapMeta } from '@dorkos/shared/roadmap-schemas';
import type { RelayAdapter, AdapterStatus } from '@dorkos/relay';

export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    title: 'Test Session',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    permissionMode: 'default',
    ...overrides,
  };
}

export function createMockStreamEvent(
  type: StreamEvent['type'],
  data: StreamEvent['data']
): StreamEvent {
  return { type, data };
}

export function createMockCommandEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    namespace: 'test',
    command: 'example',
    fullCommand: '/test:example',
    description: 'A test command',
    filePath: '.claude/commands/test/example.md',
    ...overrides,
  };
}

/** Create a mock RoadmapItem with sensible defaults. */
export function createMockRoadmapItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: '00000000-0000-4000-a000-000000000001',
    title: 'Test roadmap item',
    type: 'feature',
    moscow: 'must-have',
    status: 'not-started',
    health: 'on-track',
    timeHorizon: 'now',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create a mock PulseSchedule with sensible defaults. */
export function createMockSchedule(overrides: Partial<PulseSchedule> = {}): PulseSchedule {
  return {
    id: 'sched-1',
    name: 'Daily review',
    prompt: 'Review open PRs',
    cron: '0 9 * * 1-5',
    enabled: true,
    status: 'active',
    cwd: null,
    timezone: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock PulseRun with sensible defaults. */
export function createMockRun(overrides: Partial<PulseRun> = {}): PulseRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    sessionId: 'session-1',
    status: 'completed',
    trigger: 'scheduled',
    startedAt: new Date().toISOString(),
    finishedAt: new Date(Date.now() + 60000).toISOString(),
    durationMs: 60000,
    outputSummary: null,
    error: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A minimal AgentManifest fixture for use in transport mocks. */
const mockAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent for testing',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
};

/** Create a mock Transport with all methods stubbed via `vi.fn()`. */
export function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
      pulse: {
        enabled: true,
      },
    }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    startTunnel: vi.fn().mockResolvedValue({ url: 'https://test.ngrok.io' }),
    stopTunnel: vi.fn().mockResolvedValue(undefined),
    // Pulse
    listSchedules: vi.fn().mockResolvedValue([]),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn().mockResolvedValue({ success: true }),
    triggerSchedule: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue({ success: true }),
    // Relay
    listRelayMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getRelayMessage: vi.fn(),
    sendRelayMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 0 }),
    listRelayEndpoints: vi.fn().mockResolvedValue([]),
    registerRelayEndpoint: vi.fn(),
    unregisterRelayEndpoint: vi.fn().mockResolvedValue({ success: true }),
    readRelayInbox: vi.fn().mockResolvedValue({ messages: [] }),
    getRelayMetrics: vi.fn().mockResolvedValue({ totalMessages: 0, byStatus: {}, bySubject: [] }),
    listRelayDeadLetters: vi.fn().mockResolvedValue([]),
    // Relay Convergence
    sendMessageRelay: vi.fn().mockResolvedValue({ messageId: 'msg-1', traceId: 'trace-1' }),
    getRelayTrace: vi.fn().mockResolvedValue({ traceId: 'trace-1', spans: [] }),
    getRelayDeliveryMetrics: vi.fn().mockResolvedValue({
      totalMessages: 0,
      deliveredCount: 0,
      failedCount: 0,
      deadLetteredCount: 0,
      avgDeliveryLatencyMs: null,
      p95DeliveryLatencyMs: null,
      activeEndpoints: 0,
      budgetRejections: { hopLimit: 0, ttlExpired: 0, cycleDetected: 0, budgetExhausted: 0 },
    }),
    // Relay Adapters
    listRelayAdapters: vi.fn().mockResolvedValue([]),
    toggleRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    getAdapterCatalog: vi.fn().mockResolvedValue([]),
    addRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    removeRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    updateRelayAdapterConfig: vi.fn().mockResolvedValue({ ok: true }),
    testRelayAdapterConnection: vi.fn().mockResolvedValue({ ok: true }),
    // Mesh
    discoverMeshAgents: vi.fn().mockResolvedValue({ candidates: [] }),
    listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    getMeshAgent: vi.fn(),
    registerMeshAgent: vi.fn(),
    updateMeshAgent: vi.fn(),
    unregisterMeshAgent: vi.fn().mockResolvedValue({ success: true }),
    denyMeshAgent: vi.fn().mockResolvedValue({ success: true }),
    listDeniedMeshAgents: vi.fn().mockResolvedValue({ denied: [] }),
    clearMeshDenial: vi.fn().mockResolvedValue({ success: true }),
    // Mesh Observability
    getMeshStatus: vi.fn().mockResolvedValue({
      totalAgents: 0,
      activeCount: 0,
      inactiveCount: 0,
      staleCount: 0,
      unreachableCount: 0,
      byRuntime: {},
      byProject: {},
    }),
    getMeshAgentHealth: vi.fn().mockResolvedValue(undefined),
    sendMeshHeartbeat: vi.fn().mockResolvedValue({ success: true }),
    // Mesh Topology
    getMeshTopology: vi.fn().mockResolvedValue({ callerNamespace: '*', namespaces: [], accessRules: [] }),
    updateMeshAccessRule: vi.fn().mockResolvedValue({ sourceNamespace: '', targetNamespace: '', action: 'allow' }),
    getMeshAgentAccess: vi.fn().mockResolvedValue({ agents: [] }),
    // Agent Identity
    getAgentByPath: vi.fn().mockResolvedValue(null),
    resolveAgents: vi.fn().mockResolvedValue({}),
    createAgent: vi.fn().mockResolvedValue(mockAgent),
    updateAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    ...overrides,
  };
}

/** Create a mock RoadmapMeta with health stats. */
export function createMockRoadmapMeta(overrides: Partial<RoadmapMeta> = {}): RoadmapMeta {
  return {
    projectName: 'Test Project',
    projectSummary: 'A test roadmap project',
    lastUpdated: '2025-01-01T00:00:00.000Z',
    timeHorizons: {
      now: { label: 'Now', description: 'Current sprint' },
      next: { label: 'Next', description: 'Next sprint' },
      later: { label: 'Later', description: 'Future work' },
    },
    ...overrides,
  };
}

/**
 * Generate a valid HMAC-SHA256 signature for webhook testing.
 *
 * Produces headers that `WebhookAdapter.handleInbound()` will accept, using
 * the same Stripe-style format: `{timestamp}.{body}`.
 *
 * @param body - The raw request body string to sign
 * @param secret - The HMAC secret to sign with
 * @param timestamp - Optional Unix timestamp in seconds (defaults to now)
 * @returns Object with `signature`, `timestamp`, and `nonce` header values
 */
export function signPayload(
  body: string,
  secret: string,
  timestamp?: number,
): { signature: string; timestamp: string; nonce: string } {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const message = `${ts}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return { signature, timestamp: ts, nonce };
}

/**
 * Create a mock RelayAdapter with all methods stubbed via vi.fn().
 *
 * @param overrides - Partial overrides for adapter properties and methods
 */
export function createMockAdapter(overrides: Partial<RelayAdapter> = {}): RelayAdapter {
  const defaultStatus: AdapterStatus = {
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  return {
    id: 'mock-adapter',
    subjectPrefix: 'relay.test.mock',
    displayName: 'Mock Adapter',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue(defaultStatus),
    ...overrides,
  };
}
