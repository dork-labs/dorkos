import { vi } from 'vitest';
import type {
  AgentRuntime,
  SseResponse,
  SessionOpts,
  MessageOpts,
  RuntimeCapabilities,
} from '@dorkos/shared/agent-runtime';
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  PermissionMode,
} from '@dorkos/shared/types';

type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/**
 * A full implementation of AgentRuntime for use in Vitest tests.
 *
 * All methods are vi.fn() spies. sendMessage() yields StreamEvents from a
 * scenario queue loaded via withScenarios(). watchSession() is a no-op
 * vi.fn() — tests configure message history via getMessageHistory() directly.
 *
 * @example
 * ```typescript
 * const runtime = new FakeAgentRuntime();
 * runtime.withScenarios([simpleTextScenario]);
 * vi.mocked(runtimeRegistry.getDefault).mockReturnValue(runtime);
 * ```
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly type = 'fake' as const;

  private _scenarios: ScenarioFn[] = [];
  private _scenarioIndex = 0;

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

  ensureSession = vi.fn<(sessionId: string, opts: SessionOpts) => void>();
  hasSession = vi.fn<(sessionId: string) => boolean>(() => false);
  updateSession = vi.fn<
    (sessionId: string, opts: { permissionMode?: PermissionMode; model?: string }) => boolean
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
  listSessions = vi.fn<(projectDir: string) => Promise<Session[]>>().mockResolvedValue([]);
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
  watchSession = vi.fn<
    (
      sessionId: string,
      projectDir: string,
      callback: (event: StreamEvent) => void,
      clientId?: string
    ) => () => void
  >(() => () => {});
  acquireLock = vi.fn<(sessionId: string, clientId: string, res: SseResponse) => boolean>(
    () => true
  );
  releaseLock = vi.fn<(sessionId: string, clientId: string) => void>();
  isLocked = vi.fn<(sessionId: string, clientId?: string) => boolean>(() => false);
  getLockInfo = vi.fn<(sessionId: string) => { clientId: string; acquiredAt: number } | null>(
    () => null
  );
  getCapabilities = vi.fn<() => RuntimeCapabilities>(() => ({
    type: 'fake' as const,
    supportsPermissionModes: true,
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: false,
    supportsMcp: false,
    supportsQuestionPrompt: true,
  }));
  getSupportedModels = vi.fn<() => Promise<ModelOption[]>>().mockResolvedValue([]);
  getSupportedSubagents = vi
    .fn<() => Promise<import('@dorkos/shared/types').SubagentInfo[]>>()
    .mockResolvedValue([]);
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
  approveTool = vi.fn<(sessionId: string, toolCallId: string, approved: boolean) => boolean>();
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
}
