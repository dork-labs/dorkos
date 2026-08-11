import { vi } from 'vitest';
import type {
  AgentRuntime,
  DependencyCheck,
  SseResponse,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  RuntimeCapabilities,
  McpAppServerConnection,
  RuntimeSettingsCapability,
  ToolDecisionOptions,
} from '@dorkos/shared/agent-runtime';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  PermissionMode,
  EffortLevel,
  SessionListWarning,
} from '@dorkos/shared/types';

type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/** Construction-time overrides for the fake's STATIC capability declarations. */
export interface FakeAgentRuntimeOptions {
  /**
   * Settings declaration the fake reports from `getCapabilities().settings`.
   * Defaults to {@link DEFAULT_FAKE_SETTINGS} — no config section, no effort,
   * no bespoke sections. Override it to model a real runtime's declaration, or
   * cast a deliberately-malformed value through it to prove a consumer
   * validates what it reads rather than trusting the declaration.
   */
  settings?: RuntimeSettingsCapability;
}

/**
 * The settings declaration a fake reports unless construction overrides it: a
 * runtime with nothing configurable, which is the honest default for a double.
 */
export const DEFAULT_FAKE_SETTINGS: RuntimeSettingsCapability = {
  configSection: null,
  supportsEffort: false,
  sections: [],
};

/**
 * A full implementation of AgentRuntime for use in Vitest tests.
 *
 * All methods are vi.fn() spies. sendMessage() yields StreamEvents from a
 * scenario queue loaded via withScenarios(). Tests configure message history
 * via getMessageHistory() directly.
 *
 * @example
 * ```typescript
 * const runtime = new FakeAgentRuntime();
 * runtime.withScenarios([simpleTextScenario]);
 * vi.mocked(runtimeRegistry.getDefault).mockReturnValue(runtime);
 * ```
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly type: string;

  private _scenarios: ScenarioFn[] = [];
  private _scenarioIndex = 0;
  /** Read lazily by `getCapabilities`, so construction order does not matter. */
  private _settings: RuntimeSettingsCapability = DEFAULT_FAKE_SETTINGS;

  /**
   * Build a fake runtime, optionally overriding its static declarations.
   *
   * @param type - Runtime type identifier. Defaults to `'fake'`; pass distinct
   *   types (e.g. `'fake-a'`, `'fake-b'`) to register multiple fakes in a
   *   `RuntimeRegistry`, which keys runtimes by type.
   * @param opts - Overrides for the fake's static capability declarations.
   */
  constructor(type = 'fake', opts: FakeAgentRuntimeOptions = {}) {
    this.type = type;
    if (opts.settings !== undefined) this._settings = opts.settings;
  }

  /**
   * Load an ordered list of scenarios. Each sendMessage() call dequeues
   * the next scenario. Supports single-turn (one scenario) and multi-turn
   * (array of scenarios) with the same API.
   *
   * @param scenarios - Ordered list of scenario functions to dequeue
   */
  withScenarios(scenarios: ScenarioFn[]): this {
    this._scenarios = scenarios;
    this._scenarioIndex = 0;
    return this;
  }

  sendMessage = vi.fn(async function* (
    this: FakeAgentRuntime,
    _sessionId: string,
    content: string,
    _opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    const scenario = this._scenarios[this._scenarioIndex];
    if (scenario) {
      this._scenarioIndex++;
      yield* scenario(content);
    }
  });

  /**
   * Fulfill the runtime-fulfilled `compact` intent by yielding a synthetic
   * `compact_boundary` StreamEvent — its FINAL form (not a placeholder). Lets
   * conformance and e2e assert that a supported runtime's dispatch reached the
   * adapter and produced a terminal/boundary event.
   */
  executeCommandIntent = vi.fn(async function* (
    _sessionId: string,
    _intent: RuntimeCommandIntentId,
    _opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'compact_boundary', data: {} } as StreamEvent;
  });

  ensureSession = vi.fn<(sessionId: string, opts: SessionOpts) => void>();
  hasSession = vi.fn<(sessionId: string) => boolean>(() => false);
  updateSession = vi.fn<
    (
      sessionId: string,
      opts: {
        permissionMode?: PermissionMode;
        model?: string;
        effort?: EffortLevel;
        fastMode?: boolean;
      }
    ) => boolean
  >(() => true);
  forkSession = vi
    .fn<
      (
        projectDir: string,
        sessionId: string,
        opts?: { upToMessageId?: string; title?: string }
      ) => Promise<Session | null>
    >()
    .mockResolvedValue(null);
  reloadPlugins = vi.fn<(sessionId: string) => Promise<null>>().mockResolvedValue(null);
  getMcpStatus = vi.fn<(cwd: string) => McpServerEntry[] | null>(() => null);
  getMcpServerConfig = vi.fn<(cwd: string, serverName: string) => McpAppServerConnection | null>(
    () => null
  );
  listSessions = vi.fn<(projectDir: string) => Promise<Session[]>>().mockResolvedValue([]);
  /**
   * Defaults to `listSessions` with an empty warning list, which is the contract
   * the interface states: the same read, warnings dropped. So a test that only
   * stubs `listSessions` keeps working, and one about partial failures overrides
   * this instead of having to hand-roll a runtime.
   */
  listSessionsWithWarnings = vi.fn<
    (projectDir: string) => Promise<{ sessions: Session[]; warnings: SessionListWarning[] }>
  >(async (projectDir) => ({ sessions: await this.listSessions(projectDir), warnings: [] }));
  getSession = vi
    .fn<(projectDir: string, sessionId: string) => Promise<Session | null>>()
    .mockResolvedValue(null);
  getMessageHistory = vi
    .fn<(projectDir: string, sessionId: string) => Promise<HistoryMessage[]>>()
    .mockResolvedValue([]);
  getSessionTasks = vi
    .fn<(projectDir: string, sessionId: string) => Promise<TaskItem[]>>()
    .mockResolvedValue([]);
  getSessionETag = vi
    .fn<(projectDir: string, sessionId: string) => Promise<string | null>>()
    .mockResolvedValue(null);
  readFromOffset = vi
    .fn<
      (
        projectDir: string,
        sessionId: string,
        offset: number
      ) => Promise<{ content: string; newOffset: number }>
    >()
    .mockResolvedValue({ content: '', newOffset: 0 });
  acquireLock = vi.fn<
    (sessionId: string, clientId: string, res: SseResponse, token?: symbol) => boolean
  >(() => true);
  releaseLock = vi.fn<(sessionId: string, clientId: string, token?: symbol) => void>();
  isLocked = vi.fn<(sessionId: string, clientId?: string) => boolean>(() => false);
  getLockInfo = vi.fn<(sessionId: string) => { clientId: string; acquiredAt: number } | null>(
    () => null
  );
  getCapabilities = vi.fn<() => RuntimeCapabilities>(() => ({
    type: this.type,
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: false,
    supportsMcp: false,
    supportsManagedMcpServers: false,
    supportsQuestionPrompt: true,
    supportsPlugins: false,
    // The double declares what every real runtime declares today (spec
    // `persistent-session-runtime` P2): the contract exists, no behavior does.
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    nativeContext: [],
    permissionModes: {
      supported: true,
      // All six `PermissionMode` ids, each with the semantics its real
      // counterpart carries, so a test that renders this double sees what a
      // person would see.
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
          id: 'plan',
          label: 'Plan',
          stop: 'ask',
          asks: 'always',
          reach: 'read',
          promise: 'Reads and plans only. Nothing changes until you approve the plan.',
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
          id: 'dontAsk',
          label: "Don't ask",
          stop: 'act',
          asks: 'never',
          reach: 'workspace',
          promise: 'Works inside the project without asking.',
        },
        {
          id: 'bypassPermissions',
          label: 'Bypass permissions',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise: 'Runs everything without asking, including outside this project.',
        },
        {
          id: 'auto',
          label: 'Auto',
          stop: 'act',
          asks: 'when-risky',
          reach: 'edit',
          promise:
            'Edits files on its own and weighs each command, asking you about the risky ones.',
        },
      ],
    },
    // The test double is the one supported runtime that Phase-1 conformance
    // exercises for the supported path (its executeCommandIntent yields a real
    // synthetic compact_boundary).
    commandIntents: { compact: { supported: true } },
    // Construction-time override (`new FakeAgentRuntime('fake', { settings })`)
    // so a test can model a real runtime's declaration — or hand a
    // deliberately-malformed one to a consumer that must validate it.
    settings: this._settings,
    features: {},
  }));
  getSupportedModels = vi.fn<() => Promise<ModelOption[]>>().mockResolvedValue([]);
  getSupportedSubagents = vi
    .fn<() => Promise<import('@dorkos/shared/types').SubagentInfo[]>>()
    .mockResolvedValue([]);
  renameSession = vi
    .fn<(sessionId: string, title: string, projectDir: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  getInternalSessionId = vi.fn<(sessionId: string) => string | undefined>();
  getCommands = vi
    .fn<(forceRefresh?: boolean, cwd?: string) => Promise<CommandRegistry>>()
    .mockResolvedValue({
      commands: [],
      lastScanned: '',
    });
  getLastMessageIds = vi
    .fn<(sessionId: string) => Promise<{ user: string; assistant: string } | null>>()
    .mockResolvedValue(null);
  checkSessionHealth = vi.fn<() => void>();
  approveTool =
    vi.fn<
      (
        sessionId: string,
        toolCallId: string,
        approved: boolean,
        options?: ToolDecisionOptions
      ) => boolean
    >();
  submitAnswers = vi
    .fn<(sessionId: string, toolCallId: string, answers: Record<string, string>) => boolean>()
    .mockReturnValue(true);
  submitElicitation = vi
    .fn<
      (
        sessionId: string,
        interactionId: string,
        action: 'accept' | 'decline' | 'cancel',
        content?: Record<string, unknown>
      ) => boolean
    >()
    .mockReturnValue(true);
  stopTask = vi
    .fn<(sessionId: string, taskId: string) => Promise<boolean>>()
    .mockResolvedValue(false);
  interruptQuery = vi.fn<(sessionId: string) => Promise<boolean>>().mockResolvedValue(false);
  getSessionSnapshot = vi
    .fn<(ctx: SessionOpts, sessionId: string) => Promise<SessionSnapshot>>()
    .mockResolvedValue({
      messages: [],
      inProgressTurn: null,
      status: {
        contextUsage: null,
        cost: null,
        usage: null,
        cacheStats: null,
        model: null,
        permissionMode: 'default',
        todoCounts: null,
        runningSubagentCount: 0,
        lifecycle: 'idle',
        lastError: null,
      },
      pendingInteractions: [],
      queuedMessages: [],
      cursor: 0,
    });
  // The 4th parameter mirrors `AgentRuntime.subscribeSession`: a test that
  // hands the real projector its abort signal (every durable-stream test does)
  // cannot type its implementation without it.
  subscribeSession = vi.fn<
    (
      ctx: SessionOpts,
      sessionId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ) => AsyncIterable<SessionEvent>
    // eslint-disable-next-line require-yield
  >(async function* () {});
  subscribeSessionList = vi.fn<(ctx: SessionOpts) => AsyncIterable<SessionListEvent>>(
    // eslint-disable-next-line require-yield
    async function* () {}
  );
  checkDependencies = vi
    .fn<() => Promise<DependencyCheck[]>>()
    .mockResolvedValue([
      { name: 'Fake Runtime', description: 'No deps required.', status: 'satisfied' as const },
    ]);
}
