import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { Session, StreamEvent, CommandEntry, Task, TaskRun } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { BUILTIN_MEMORY_PROVIDER_ID } from '@dorkos/shared/memory-provider';
import type { RelayAdapter, AdapterStatus } from '@dorkos/relay';
import type {
  ObservedChat,
  AdapterBinding,
  UpdateBindingRequest,
} from '@dorkos/shared/relay-schemas';

/**
 * Create a mock Session with sensible defaults. Every optional `Session`
 * field — including `origin`/`originLabel`/`originRoomId`
 * (session-origin-legibility) and `contextTokens`/`lastAutoCompactAt` — passes
 * through via `overrides` with no changes needed here; add fields to
 * `overrides`, not new params.
 *
 * The three origin fields are stamped by the server's own overlays, never by a
 * runtime, so a new runtime owes them nothing and the conformance suite asks
 * for nothing: `SessionSchema` has them optional and the suite validates
 * against it.
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    title: 'Test Session',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/**
 * Create a mock claude-code Session that carries a best-effort list reading —
 * `contextTokens` plus an `lastAutoCompactAt` marker (fleet-context-health,
 * DOR-113). This is the claude-code-shaped row a tail read produces; a
 * codex/opencode-shaped closed-session row OMITS both (use {@link createMockSession}
 * without them). The reading fields stay optional — never make them mandatory.
 *
 * @param overrides - Partial overrides for any session field, including the
 *   reading fields (pass `contextTokens: undefined` to model an unreadable tail).
 */
export function createMockSessionWithReading(overrides: Partial<Session> = {}): Session {
  return createMockSession({
    runtime: 'claude-code',
    contextTokens: 120_000,
    lastAutoCompactAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  });
}

/** Create a mock StreamEvent with the given type and data. */
export function createMockStreamEvent(
  type: StreamEvent['type'],
  data: StreamEvent['data']
): StreamEvent {
  return { type, data };
}

/** Create a mock CommandEntry with sensible defaults. */
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

/** Create a mock Task with sensible defaults. */
export function createMockSchedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'sched-1',
    name: 'daily-review',
    displayName: 'Daily Review',
    description: 'Review open PRs daily',
    prompt: 'Review open PRs',
    cron: '0 9 * * 1-5',
    enabled: true,
    sticky: false,
    status: 'active',
    agentId: null,
    timezone: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: null,
    model: null,
    effort: null,
    filePath: '/tmp/tasks/daily-review/SKILL.md',
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    nextRuns: [],
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock TaskRun with sensible defaults. */
export function createMockRun(overrides: Partial<TaskRun> = {}): TaskRun {
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
    resolvedRuntime: null,
    resolvedModel: null,
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
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  enabledToolGroups: {},
  mcpServers: [],
  workspace: { mode: 'home' },
};

/**
 * An async generator that yields nothing — the default stub for the
 * `subscribeSession` / `subscribeSessionList` streaming Transport methods.
 */
// eslint-disable-next-line require-yield
async function* emptyAsyncIterable(): AsyncIterable<never> {}

/**
 * The refusal a room with no files of its own answers with, shaped the way the
 * HTTP adapter shapes it: an `Error` carrying `code` and `status`, which is
 * what every client reads to tell one refusal from another.
 */
function mockRoomHasNoRepoError(): Error & { code: string; status: number } {
  return Object.assign(new Error('This room does not have files of its own.'), {
    code: 'ROOM_HAS_NO_REPO',
    status: 409,
  });
}

/** Create a mock Transport with all methods stubbed via `vi.fn()`. */
export function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    // Aggregated-list envelope (ADR-0310): { sessions, warnings? }, not a bare array.
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listRecentSessions: vi
      .fn()
      .mockResolvedValue({ sessions: [], agentActivity: {}, warnings: [] }),
    getSessionDailyCounts: vi
      .fn()
      .mockResolvedValue({ days: 7, dailyCounts: [0, 0, 0, 0, 0, 0, 0], warnings: [] }),
    getSession: vi.fn(),
    getSessionRuntimeType: vi.fn().mockResolvedValue('claude-code'),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getSessionSnapshot: vi.fn().mockResolvedValue({
      messages: [],
      inProgressTurn: null,
      status: {
        contextUsage: null,
        cost: null,
        cacheStats: null,
        model: null,
        permissionMode: 'default',
        todoCounts: null,
        runningSubagentCount: 0,
        lifecycle: 'idle',
        lastError: null,
      },
      pendingInteractions: [],
      cursor: 0,
    }),
    subscribeSession: vi.fn(emptyAsyncIterable),
    subscribeSessionList: vi.fn(emptyAsyncIterable),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    postMessage: vi.fn().mockImplementation((sessionId: string) => Promise.resolve({ sessionId })),
    updateQueuedMessage: vi.fn().mockImplementation((_sessionId: string, messageId: string) =>
      Promise.resolve({
        message: {
          id: messageId,
          content: '',
          disposition: 'queue',
          enqueuedAt: 0,
          enqueuedBy: 'test-client',
        },
        queue: [],
      })
    ),
    removeQueuedMessage: vi.fn().mockResolvedValue({ queue: [] }),
    runCommandIntent: vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId })),
    sendUiAction: vi.fn().mockImplementation((sessionId: string) => Promise.resolve({ sessionId })),
    fetchMcpAppResource: vi
      .fn()
      .mockResolvedValue({ mimeType: 'text/html', text: '', permissions: [] }),
    // Nothing waiting on anybody, by default: a test that is about a prompt
    // seeds its own, and every other test mounts a cockpit with a quiet tray.
    listPendingInteractions: vi.fn().mockResolvedValue({ interactions: [] }),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    batchApprove: vi.fn().mockResolvedValue({ results: [] }),
    batchDeny: vi.fn().mockResolvedValue({ results: [] }),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    submitElicitation: vi.fn().mockResolvedValue({ ok: true }),
    stopTask: vi.fn().mockResolvedValue({ success: true, taskId: '' }),
    interruptSession: vi.fn().mockResolvedValue({ ok: true, cancelledQueued: [] }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    forkSession: vi.fn().mockResolvedValue({
      id: 'forked-id',
      title: 'Fork',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      permissionMode: 'default',
    }),
    // The universal Transport no longer exposes `reloadPlugins`; callers
    // obtain a capability-gated sub-transport via `asClaudePluginTransport`.
    // The default mock returns a working sub-transport so tests that assume a
    // Claude-backed runtime continue to work; tests that need the non-Claude
    // path should override this to return null.
    asClaudePluginTransport: vi.fn().mockReturnValue({
      reloadPlugins: vi.fn().mockResolvedValue({
        commandCount: 0,
        pluginCount: 0,
        errorCount: 0,
      }),
    }),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    writeFile: vi.fn().mockResolvedValue({ ok: true, hash: 'mock-hash' }),
    mediaUrl: vi.fn(
      (cwd: string, filePath: string) => `/api/files/raw?cwd=${cwd}&path=${filePath}`
    ),
    // Embedded browser signed URLs — the default mock behaves like the HTTP
    // transport, returning a resolvable URL. Tests that exercise the
    // DirectTransport path override these to resolve null.
    createServeUrl: vi.fn(
      async (cwd: string, filePath?: string) =>
        `/api/workbench/serve/mock-token/${filePath ?? 'index.html'}?cwd=${cwd}`
    ),
    createProxyUrl: vi.fn(async (port: number) => ({
      url: `http://localhost:4999/?__dorkos_preview=mock-token-${port}`,
    })),
    // Default: the port answers. Tests covering the dead-port message override
    // this with `{ listening: false }`, and DirectTransport tests with `null`.
    probeLoopbackPort: vi.fn(async () => ({ listening: true })),
    ingestDevtoolsCapture: vi.fn(async () => {}),
    // Embedded terminal — the default mock behaves like the HTTP transport
    // (supported); tests that need the DirectTransport path override
    // `supportsTerminal: false`.
    supportsTerminal: true,
    openTerminal: vi.fn(async () => ({
      id: 'mock-terminal',
      output: emptyAsyncIterable(),
    })),
    attachTerminal: vi.fn(async (id: string) => ({
      id,
      output: emptyAsyncIterable(),
    })),
    closeTerminal: vi.fn(async () => {}),
    writeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    readFileTree: vi.fn().mockResolvedValue({ entries: [] }),
    readFileContent: vi
      .fn()
      .mockResolvedValue({ content: '', hash: 'mock-hash', encoding: 'utf-8' }),
    readDiffBaseline: vi.fn().mockResolvedValue({
      baseline: '',
      baselineHash: 'mock-baseline-hash',
      current: '',
      currentHash: 'mock-current-hash',
      capturedFrom: 'empty',
    }),
    advanceDiffBaseline: vi.fn().mockResolvedValue(undefined),
    diffBaselineMediaUrl: vi.fn(
      (cwd: string, filePath: string, sessionId: string) =>
        `http://mock/api/diff/baseline/raw?cwd=${cwd}&path=${filePath}&sessionId=${sessionId}`
    ),
    revertDiffBaseline: vi.fn().mockResolvedValue(undefined),
    createEntry: vi.fn().mockResolvedValue({ ok: true, path: 'mock-path' }),
    deleteEntry: vi.fn().mockResolvedValue({ ok: true }),
    renameEntry: vi.fn().mockResolvedValue({ ok: true }),
    copyEntry: vi.fn().mockResolvedValue({ ok: true }),
    // Reveal behaves like the HTTP transport by default (supported); tests that
    // need the DirectTransport path override `supportsReveal: false`.
    supportsReveal: true,
    revealEntry: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
      tasks: {
        enabled: true,
      },
    }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    // Workspaces (DOR-84, DOR-1056) — the scan answers "nothing found" so a
    // component under test renders its empty state unless the test overrides it.
    scanWorktrees: vi.fn().mockResolvedValue({ root: '/tmp/ws', worktrees: [] }),
    resolveWorkspace: vi.fn().mockResolvedValue(null),
    // Rooms (spec `rooms`) — every read answers empty so a component under test
    // renders its empty state unless the test overrides it.
    listRooms: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn(),
    getRoom: vi.fn(),
    updateRoom: vi.fn(),
    listRoomEntries: vi.fn().mockResolvedValue([]),
    // A room with no files of its own, which is what nearly every room is: the
    // surfaces that offer files read this code and show nothing at all. A test
    // about a room's files overrides both; a test about anything else must not
    // have to know rooms can have files.
    readRoomFiles: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    readRoomFileContent: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    readRoomRepoStatus: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    saveRoomFile: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    repairRoomMain: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    postToRoom: vi.fn().mockResolvedValue({ accepted: true, entryId: 'entry-mock', seq: 1 }),
    // Nothing attached, by default: a test that is about attachments overrides
    // this, and every other test posts a message with no files the way a person
    // usually does.
    uploadRoomAttachments: vi.fn().mockResolvedValue([]),
    replyInThread: vi.fn().mockResolvedValue({ accepted: true, entryId: 'reply-mock', seq: 2 }),
    // An idle room by default: a halt that stopped nothing is the shape a test
    // gets unless it is specifically about a room with turns in flight.
    haltRoom: vi.fn().mockResolvedValue({ stopped: 0 }),
    // The same default for the per-agent stop, and a SEPARATE mock on purpose:
    // wiring both peek stops to one mutation is the likeliest mistake here, and
    // one shared spy could not see it.
    haltRoomAgent: vi.fn().mockResolvedValue({ stopped: 0 }),
    promoteHold: vi.fn().mockResolvedValue({ promoted: true }),
    // No bindings by default: a room whose agents have never answered is the
    // shape a test gets unless it is specifically about where the work runs.
    listRoomSessions: vi.fn().mockResolvedValue({ bindings: [] }),
    // Answers as if the emoji went ON, and hands back the shipped quick row —
    // the shape a capsule reads without a second request.
    toggleReaction: vi.fn().mockResolvedValue({
      accepted: true,
      entryId: 'entry-mock',
      emoji: '👍',
      reacted: true,
      frequents: ['👍', '❤️', '🎉'],
    }),
    addRoomMember: vi.fn(),
    updateRoomMember: vi.fn(),
    removeRoomMember: vi.fn().mockResolvedValue(undefined),
    subscribeRoom: vi.fn(emptyAsyncIterable),
    // Read state (team-room-home D4) — one cursor for every kind of thread a
    // person reads, rooms included. The default read is `null`: a test that says
    // nothing about read state gets a thread nobody has read, which draws no
    // unread rule.
    getReadCursor: vi.fn().mockResolvedValue(null),
    setReadCursor: vi.fn().mockResolvedValue({}),
    // Models
    getModels: vi.fn().mockResolvedValue([
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast model' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable model' },
    ]),
    getSubagents: vi.fn().mockResolvedValue([]),
    // An empty catalog by default: a test that cares about a capability's
    // declaration overrides this, and one that does not must not be handed
    // invented tool names it would then assert against.
    getCapabilityCatalog: vi.fn().mockResolvedValue({
      catalogVersion: 'mock',
      generatedAt: '2026-01-01T00:00:00.000Z',
      capabilities: [],
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: {
        'claude-code': {
          type: 'claude-code',
          supportsToolApproval: true,
          supportsCostTracking: false,
          supportsResume: true,
          supportsMcp: true,
          supportsManagedMcpServers: true,
          supportsQuestionPrompt: true,
          supportsPlugins: true,
          permissionModes: {
            supported: true,
            values: [
              {
                id: 'default',
                label: 'Default',
                stop: 'ask',
                asks: 'always',
                reach: 'edit',
                promise: 'Asks before it edits a file or runs a command.',
              },
              {
                id: 'acceptEdits',
                label: 'Accept edits',
                stop: 'act',
                asks: 'when-risky',
                reach: 'edit',
                promise: 'Edits files on its own. Asks before it runs a command.',
              },
              {
                id: 'plan',
                label: 'Plan',
                stop: 'ask',
                // A way of working, not a level of trust — mirroring the real
                // profile in `claude-code/runtime-constants.ts`. Without it every
                // dial rendered against this mock offers planning as a second
                // answer to "how much may this agent do?", which the shipped
                // profile does not.
                axis: 'working',
                asks: 'always',
                reach: 'read',
                promise: 'Reads and plans only. Nothing changes until you approve the plan.',
              },
              {
                id: 'bypassPermissions',
                label: 'Bypass permissions',
                stop: 'autonomy',
                asks: 'never',
                reach: 'everything',
                promise: 'Runs everything without asking, including outside this project.',
              },
            ],
          },
          // The real claude-code declaration, mirroring
          // `claude-code/runtime-constants.ts` — a settings surface rendered
          // against this mock should see what a person sees.
          settings: {
            configSection: 'claudeCode',
            supportsEffort: true,
            sections: [{ kind: 'claude-accounts' }],
          },
          features: {},
        },
        // The other two product runtimes, registered here rather than re-invented
        // per test file. A settings surface writes into the section a runtime
        // DECLARES, so a capability map with one runtime in it cannot express
        // "the model row wrote into Codex's section" — which is the whole point
        // of scoping model and effort per runtime. Each declaration mirrors the
        // shipped one (`codex/runtime-constants.ts`,
        // `opencode/runtime-constants.ts`), abbreviated only in prose fields.
        codex: {
          type: 'codex',
          supportsToolApproval: false,
          supportsCostTracking: false,
          supportsResume: true,
          supportsMcp: false,
          supportsQuestionPrompt: false,
          supportsPlugins: false,
          permissionModes: {
            supported: true,
            default: 'default',
            values: [
              {
                id: 'default',
                label: 'Read only',
                stop: 'ask',
                asks: 'never',
                reach: 'read',
                promise: 'Reads files and answers questions. Nothing on your machine changes.',
              },
              {
                id: 'acceptEdits',
                label: 'Workspace write',
                stop: 'act',
                asks: 'never',
                reach: 'workspace',
                promise:
                  "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
              },
              {
                id: 'bypassPermissions',
                label: 'Full access',
                stop: 'autonomy',
                asks: 'never',
                reach: 'everything',
                promise:
                  'Runs everything without asking, anywhere on your machine, network included.',
              },
            ],
          },
          // Effort is real; no bespoke section — Codex's card is the common rows.
          settings: { configSection: 'codex', supportsEffort: true, sections: [] },
          features: {},
        },
        opencode: {
          type: 'opencode',
          supportsToolApproval: true,
          supportsCostTracking: true,
          supportsResume: true,
          supportsMcp: false,
          supportsQuestionPrompt: false,
          supportsPlugins: false,
          permissionModes: {
            supported: true,
            default: 'default',
            values: [
              {
                id: 'default',
                label: 'Default',
                stop: 'ask',
                asks: 'always',
                reach: 'edit',
                promise: 'Asks before it edits a file, runs a command, or fetches a page.',
              },
              {
                id: 'acceptEdits',
                label: 'Accept edits',
                stop: 'act',
                asks: 'when-risky',
                reach: 'edit',
                promise: 'Edits files on its own. Asks before it runs a command.',
              },
              {
                id: 'bypassPermissions',
                label: 'Bypass permissions',
                stop: 'autonomy',
                asks: 'never',
                reach: 'everything',
                promise: 'Runs everything without asking, including outside this project.',
              },
            ],
          },
          // No effort leaf at OpenCode's API, and its bespoke section is the
          // power-source picker — both load-bearing absences for the cards.
          settings: {
            configSection: 'opencode',
            supportsEffort: false,
            sections: [{ kind: 'opencode-power-source' }],
          },
          features: {},
        },
      },
      defaultRuntime: 'claude-code',
    }),
    checkRequirements: vi.fn().mockResolvedValue({
      runtimes: {
        'claude-code': {
          state: 'ready',
          dependencies: [
            {
              name: 'Claude Code CLI',
              description: 'The Claude Code CLI powers agent sessions in DorkOS.',
              status: 'satisfied',
              version: '1.0.0',
            },
            {
              name: 'Claude Code authentication',
              description: 'Signed in to Claude.',
              status: 'satisfied',
            },
          ],
        },
      },
    }),
    getUnattendedAutonomy: vi.fn().mockResolvedValue({ drivers: [] }),
    getMemoryProviderStatus: vi.fn().mockResolvedValue({
      configuredId: BUILTIN_MEMORY_PROVIDER_ID,
      activeId: BUILTIN_MEMORY_PROVIDER_ID,
      benched: false,
      benchReason: null,
    }),
    provisionRuntime: vi.fn().mockResolvedValue({ ok: true, binaryPath: '/mock/opencode' }),
    // Runtime connect (terminal-free auth)
    storeRuntimeCredential: vi.fn().mockResolvedValue({ ref: 'file:mock' }),
    storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:mock' }),
    delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }),
    storeOpenRouterKey: vi.fn().mockResolvedValue({ ok: true }),
    startOpenRouterOAuth: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: 'https://openrouter.ai/auth', state: 'mock-state' }),
    getOpenRouterOAuthStatus: vi.fn().mockResolvedValue({ status: 'pending' }),
    detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }),
    getOllamaModelCatalog: vi.fn().mockResolvedValue({
      hardware: { totalRamBytes: 0, vramBytes: null, unifiedMemory: false },
      models: [],
    }),
    pullOllamaModel: vi.fn().mockResolvedValue({ ok: true, model: 'qwen2.5-coder:7b' }),
    provisionOllama: vi.fn().mockResolvedValue({
      ok: true,
      installMethod: 'brew',
      status: { running: true, models: [] },
    }),
    startTunnel: vi.fn().mockResolvedValue({ url: 'https://test.ngrok.io' }),
    stopTunnel: vi.fn().mockResolvedValue(undefined),
    // Tasks
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn().mockResolvedValue({ success: true }),
    triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    listTaskRuns: vi.fn().mockResolvedValue([]),
    getTaskRun: vi.fn(),
    cancelTaskRun: vi.fn().mockResolvedValue({ success: true, state: 'stopping' }),
    getTaskTemplates: vi.fn().mockResolvedValue([]),
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
      noSubscriberCount: 0,
      deadLetteredCount: 0,
      avgDeliveryLatencyMs: null,
      p50DeliveryLatencyMs: null,
      p95DeliveryLatencyMs: null,
      p99DeliveryLatencyMs: null,
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
    deleteAgentData: vi.fn().mockResolvedValue({ success: true, deletedPath: '/test/.dork' }),
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
    getMeshTopology: vi.fn().mockResolvedValue({
      callerNamespace: '*',
      namespaces: [],
      accessRules: [],
      openMesh: false,
    }),
    updateMeshAccessRule: vi.fn().mockResolvedValue({
      sourceNamespace: '',
      targetNamespace: '',
      action: 'allow',
      origin: 'explicit',
    }),
    getMeshAgentAccess: vi.fn().mockResolvedValue({ agents: [] }),
    // Agent Identity
    getAgentByPath: vi.fn().mockResolvedValue(null),
    resolveAgents: vi.fn().mockResolvedValue({}),
    updateAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    createAgent: vi.fn().mockResolvedValue({ ...mockAgent, _path: '/mock/agents/mock-agent' }),
    // Default Agent
    setDefaultAgent: vi.fn().mockResolvedValue(undefined),
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
    updateBinding: vi.fn().mockImplementation(async (id: string, updates: UpdateBindingRequest) => {
      // Mimic the server PATCH route: null clears an optional field,
      // undefined is a no-op, everything else overwrites.
      const applied: Record<string, unknown> = {
        ...createMockBinding({ id, adapterId: 'mock-adapter', agentId: 'mock-agent' }),
      };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue;
        if (value === null) delete applied[key];
        else applied[key] = value;
      }
      return applied as AdapterBinding;
    }),
    testBinding: vi.fn().mockResolvedValue({
      ok: true,
      resolved: true,
      latencyMs: 1,
      wouldDeliverTo: 'mock-agent',
      details: 'Routing succeeded. No agent was invoked.',
    }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    rotateMcpLocalToken: vi.fn().mockResolvedValue({ localToken: 'dork_mcp_local_test' }),
    revealMcpLocalToken: vi.fn().mockResolvedValue({ localToken: 'dork_mcp_local_test' }),
    reportError: vi.fn().mockResolvedValue(undefined),
    // Directory Operations
    createDirectory: vi.fn().mockResolvedValue({ path: '/test/new-folder' }),
    // Discovery
    scan: vi.fn().mockResolvedValue(undefined),
    // Uploads
    uploadFiles: vi.fn().mockResolvedValue([]),
    // Admin Operations
    getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    resetAllData: vi.fn().mockResolvedValue({ message: 'Reset initiated. Server will restart.' }),
    restartServer: vi.fn().mockResolvedValue({ message: 'Restart initiated.' }),
    // Activity Feed
    listActivityEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    // Templates
    getTemplates: vi.fn().mockResolvedValue([]),
    // Marketplace
    listMarketplacePackages: vi.fn().mockResolvedValue([]),
    getMarketplacePackage: vi.fn(),
    previewMarketplacePackage: vi.fn(),
    installMarketplacePackage: vi.fn(),
    uninstallMarketplacePackage: vi.fn(),
    updateMarketplacePackage: vi.fn(),
    listInstalledPackages: vi.fn().mockResolvedValue([]),
    listPackageInstallations: vi.fn().mockResolvedValue([]),
    listMarketplaceSources: vi.fn().mockResolvedValue([]),
    addMarketplaceSource: vi.fn(),
    removeMarketplaceSource: vi.fn().mockResolvedValue(undefined),
    // The Inbox (spec `notification-system`)
    listNotifications: vi
      .fn()
      .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 }),
    markNotificationRead: vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 }),
    markAllNotificationsRead: vi.fn().mockResolvedValue({ ok: true, marked: 0, unreadCount: 0 }),
    // Web push (spec `notification-system` task 4.3). The default install has
    // no keypair and no devices, which is the state every test that does not
    // care about push should see.
    getPushVapidPublicKey: vi.fn().mockResolvedValue({ key: null }),
    registerPushSubscription: vi.fn().mockResolvedValue({
      ok: true,
      subscription: {
        id: 'push-1',
        service: 'push.example.com',
        createdAt: '2026-08-20T09:00:00.000Z',
        lastSeenAt: '2026-08-20T09:00:00.000Z',
      },
    }),
    listPushSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    deletePushSubscription: vi.fn().mockResolvedValue({ ok: true, removed: 1 }),
    // Approvals (spec `agent-trust` §3.3)
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
    grantApproval: vi
      .fn()
      .mockImplementation((approvalId: string) =>
        Promise.resolve({ ok: true, approvalId, outcome: 'granted' })
      ),
    denyApproval: vi
      .fn()
      .mockImplementation((approvalId: string) =>
        Promise.resolve({ ok: true, approvalId, outcome: 'denied' })
      ),
    // Standing permissions (spec `agent-approval-settings` §3.7)
    listStandingPermissions: vi.fn().mockResolvedValue({ grants: [] }),
    revokeStandingPermission: vi
      .fn()
      .mockImplementation((grantId: string) => Promise.resolve({ ok: true, grantId })),
    // Team roster (spec `identity-consistency` §W2.2). Honest-empty by default:
    // `warnings` is OMITTED on a clean read, never `[]`, so a test that does
    // not opt into degradation never renders the banner by accident.
    getTeamRoster: vi.fn().mockResolvedValue({ members: [] }),
    // The rooms a member is in (spec `profile-unification` §3.2). Empty rather
    // than rejecting, because "in no rooms" is the state a fresh install is
    // actually in — a default that threw would make every profile test opt out
    // of an error nothing real produces.
    listMemberRooms: vi.fn().mockResolvedValue({ rooms: [] }),
    // Message search (spec `message-search` §8). The full envelope, `warnings`
    // included: that array is ALWAYS present on this route by decision, and a
    // default that omitted it would let a component read `undefined` in every
    // test and crash only in production.
    search: vi.fn().mockResolvedValue({ results: [], warnings: [] }),
    // The operator's own profile (spec `identity-consistency` §W3.3, §W3.5).
    // Each resolves with what the real route answers, so a component under test
    // takes its success path unless a test deliberately makes one reject.
    updateProfile: vi
      .fn()
      .mockImplementation((displayName: string) => Promise.resolve({ displayName })),
    uploadProfileAvatar: vi
      .fn()
      .mockResolvedValue({ imageUrl: '/api/profile/avatar/person-1?v=abc' }),
    deleteProfileAvatar: vi.fn().mockResolvedValue(undefined),
    // Answers with the `AuthorRef` the real route returns, echoing the handle
    // it was asked for. A bare `vi.fn()` resolves `undefined`, which is not a
    // shape any caller can read — a component that renders the saved handle
    // back would crash on it and the test would blame the component.
    setAuthorHandle: vi.fn().mockImplementation((authorId: string, handle: string) =>
      Promise.resolve({
        id: authorId,
        kind: 'human',
        displayName: 'You',
        handle: handle.trim() === '' ? null : handle,
        origin: 'local',
      })
    ),
    // Shapes (DOR-355)
    listShapes: vi.fn().mockResolvedValue([]),
    applyShape: vi.fn(),
    forkShape: vi.fn(),
    // Cloud account link (accounts-and-auth P2)
    startCloudLink: vi.fn().mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    getCloudLinkStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
    unlinkCloud: vi.fn().mockResolvedValue({ ok: true }),
    getCloudStatus: vi
      .fn()
      .mockResolvedValue({ linked: false, accountLabel: null, lastHeartbeatAt: null }),
    sendFeedback: vi.fn().mockResolvedValue({ ok: true }),
    listMyFeedback: vi.fn().mockResolvedValue([]),
    // Connectors (connector-completion spec §Detailed Design 5). Reads default
    // to honest-empty; writes default to unstubbed vi.fn() so a test that
    // exercises them must state what the server would answer.
    getConnectorProviders: vi.fn().mockResolvedValue([]),
    putConnectorCredential: vi.fn(),
    deleteConnectorCredential: vi.fn(),
    getConnectorToolkits: vi.fn().mockResolvedValue({ toolkits: [], warnings: [] }),
    getConnectorRecommendation: vi.fn().mockResolvedValue({ recommendations: [], warnings: [] }),
    startConnectorFlow: vi.fn(),
    pollConnectorFlow: vi.fn(),
    getConnectorAccounts: vi.fn().mockResolvedValue({ accounts: [], warnings: [] }),
    disconnectConnectorAccount: vi.fn().mockResolvedValue(undefined),
    getSessionConnectors: vi.fn().mockResolvedValue({ accounts: [], warnings: [] }),
    attachSessionConnector: vi.fn(),
    detachSessionConnector: vi.fn().mockResolvedValue(undefined),
    getAgentConnectors: vi.fn().mockResolvedValue([]),
    attachAgentConnector: vi.fn(),
    detachAgentConnector: vi.fn().mockResolvedValue(undefined),
    // Managed per-agent MCP servers (spec `mcp-server-management`, DOR-891).
    // The list reads honest-empty; the writes must be stated by a test that
    // exercises them (an add can resolve to `{ status: 'approval_required' }`).
    listAgentMcpServers: vi.fn().mockResolvedValue([]),
    addAgentMcpServer: vi.fn(),
    importAgentMcpServer: vi.fn(),
    updateAgentMcpServer: vi.fn(),
    removeAgentMcpServer: vi.fn().mockResolvedValue([]),
    enableAgentMcpServer: vi.fn().mockResolvedValue([]),
    disableAgentMcpServer: vi.fn().mockResolvedValue([]),
    testAgentMcpServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 0 }),
    // Managed-MCP OAuth sign-in (DOR-943). Both defaults resolve, and the poll's
    // default is TERMINAL: a `pending` default would leave any test that reaches
    // the flow without stating its own poll spinning on a 2s interval forever,
    // and a bare `vi.fn()` start resolves `undefined`, which the flow reads
    // fields off. A test that exercises the flow states both halves anyway.
    startMcpSignin: vi.fn().mockResolvedValue({
      flowId: 'mock-flow',
      authorizeUrl: 'https://auth.example/authorize',
      alreadyConnected: false,
      disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
      message: 'sign-in link',
    }),
    pollMcpSignin: vi.fn().mockResolvedValue({ status: 'connected' }),
    // Storing operator-supplied app credentials (DOR-982) resolves by default:
    // the interesting half is what the flow does AFTER the save, and a test that
    // cares about the save failing states that itself.
    setMcpClientCredentials: vi.fn().mockResolvedValue(undefined),
    // The claim feed (connection-scoping spec §Part 3) — same rule: the list
    // reads honest-empty, the three decisions must be stated by the test.
    listUnclaimedChats: vi.fn().mockResolvedValue([]),
    claimUnclaimedChat: vi.fn(),
    ignoreUnclaimedChat: vi.fn().mockResolvedValue(undefined),
    blockUnclaimedChat: vi.fn().mockResolvedValue(undefined),
    leaveUnclaimedChat: vi.fn().mockResolvedValue(undefined),
    moveBinding: vi.fn(),
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
  timestamp?: number
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
    permissionMode: 'acceptEdits',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    bridge: 'off',
    roomId: null,
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
