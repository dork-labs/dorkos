import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { Session, StreamEvent, CommandEntry, PulseSchedule, PulseRun } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RelayAdapter, AdapterStatus } from '@dorkos/relay';
import type { ObservedChat, AdapterBinding } from '@dorkos/shared/relay-schemas';

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
    agentId: null,
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
  enabledToolGroups: {},
};

/** Create a mock Transport with all methods stubbed via `vi.fn()`. */
export function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
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
    // Models
    getModels: vi.fn().mockResolvedValue([
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast model' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable model' },
    ]),
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: {
        'claude-code': {
          type: 'claude-code',
          supportsPermissionModes: true,
          supportsToolApproval: true,
          supportsCostTracking: false,
          supportsResume: true,
          supportsMcp: true,
          supportsQuestionPrompt: true,
        },
      },
      defaultRuntime: 'claude-code',
    }),
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
    getPulsePresets: vi.fn().mockResolvedValue([]),
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
    listAggregatedDeadLetters: vi.fn().mockResolvedValue({ groups: [] }),
    dismissDeadLetterGroup: vi.fn().mockResolvedValue({ dismissed: 0 }),
    listRelayConversations: vi.fn().mockResolvedValue({ conversations: [] }),
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
    getAdapterEvents: vi.fn().mockResolvedValue({ events: [] }),
    getObservedChats: vi.fn().mockResolvedValue([]),
    // Mesh
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
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
    // Relay Bindings
    getBindings: vi.fn().mockResolvedValue([]),
    createBinding: vi.fn().mockResolvedValue({
      id: 'mock-binding-id',
      adapterId: 'mock-adapter',
      agentId: 'mock-agent',
      sessionStrategy: 'per-chat',
      label: '',
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    deleteBinding: vi.fn().mockResolvedValue(undefined),
    updateBinding: vi.fn().mockImplementation(async (id: string, updates: Partial<AdapterBinding>) => ({
      id,
      adapterId: 'mock-adapter',
      agentId: 'mock-agent',
      sessionStrategy: 'per-chat' as const,
      label: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...updates,
    })),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    // Discovery
    scan: vi.fn().mockResolvedValue(undefined),
    // Uploads
    uploadFiles: vi.fn().mockResolvedValue([]),
    // Admin Operations
    getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    resetAllData: vi.fn().mockResolvedValue({ message: 'Reset initiated. Server will restart.' }),
    restartServer: vi.fn().mockResolvedValue({ message: 'Restart initiated.' }),
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
 * Create a mock ObservedChat with sensible defaults.
 *
 * @param overrides - Partial overrides for the chat fields
 */
export function createMockObservedChat(overrides: Partial<ObservedChat> = {}): ObservedChat {
  return {
    chatId: '12345',
    displayName: 'Test Chat',
    channelType: 'dm',
    lastMessageAt: new Date().toISOString(),
    messageCount: 5,
    ...overrides,
  };
}

/**
 * Create a mock AdapterBinding with sensible defaults.
 *
 * @param overrides - Partial overrides for the binding fields
 */
export function createMockBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: crypto.randomUUID(),
    adapterId: 'telegram-1',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    canInitiate: false,
    canReply: true,
    canReceive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
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
