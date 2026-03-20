import type {
  AgentRuntime,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  SseResponse,
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
import type { RelayCore } from '@dorkos/relay';
import { scenarioStore } from './scenario-store.js';

/**
 * A zero-latency AgentRuntime that yields StreamEvents from the scenario store.
 * Registered instead of ClaudeCodeRuntime when DORKOS_TEST_RUNTIME=true.
 *
 * Never imported in production — index.ts only imports this module when the
 * env var is set. There is no tree-shaking concern because the condition is
 * evaluated at server startup, not at build time.
 */
export class TestModeRuntime implements AgentRuntime {
  readonly type = 'test-mode' as const;

  private _sessions = new Map<string, SessionOpts>();
  private _relay: RelayCore | null = null;

  ensureSession(sessionId: string, opts: SessionOpts): void {
    this._sessions.set(sessionId, opts);
  }

  hasSession(sessionId: string): boolean {
    return this._sessions.has(sessionId);
  }

  updateSession(
    sessionId: string,
    opts: { permissionMode?: PermissionMode; model?: string }
  ): boolean {
    const existing = this._sessions.get(sessionId);
    if (!existing) return false;
    this._sessions.set(sessionId, { ...existing, ...opts });
    return true;
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    _opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    const scenario = scenarioStore.getScenario(sessionId);
    yield* scenario(content);
  }

  setRelay(relay: RelayCore): void {
    this._relay = relay;
  }

  watchSession(
    _sessionId: string,
    _projectDir: string,
    callback: (event: StreamEvent) => void,
    clientId?: string
  ): () => void {
    if (!this._relay || !clientId) return () => {};
    // Subscribe to relay.human.console.{clientId} and forward events to the callback.
    // Mirrors the behavior of SessionBroadcaster.registerCallback() used by ClaudeCodeRuntime.
    const subject = `relay.human.console.${clientId}`;
    return this._relay.subscribe(subject, (envelope) => {
      callback({
        type: 'relay_message',
        data: {
          messageId: (envelope as Record<string, unknown>).id,
          payload: (envelope as Record<string, unknown>).payload,
          subject: (envelope as Record<string, unknown>).subject,
        },
      } as StreamEvent);
    });
  }

  async listSessions(_projectDir: string): Promise<Session[]> {
    return [];
  }

  async getSession(_projectDir: string, _id: string): Promise<Session | null> {
    return null;
  }

  async getMessageHistory(_projectDir: string, _id: string): Promise<HistoryMessage[]> {
    return [];
  }

  async getSessionTasks(_projectDir: string, _id: string): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(_projectDir: string, _id: string): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(_sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  async readFromOffset(
    _projectDir: string,
    _id: string,
    _offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  acquireLock(_id: string, _clientId: string, _res: SseResponse): boolean {
    return true;
  }

  releaseLock(_id: string, _clientId: string): void {}

  isLocked(_id: string, _clientId?: string): boolean {
    return false;
  }

  getLockInfo(_id: string): { clientId: string; acquiredAt: number } | null {
    return null;
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      type: 'test-mode',
      supportsPermissionModes: true,
      supportsToolApproval: false,
      supportsCostTracking: false,
      supportsResume: false,
      supportsMcp: false,
      supportsQuestionPrompt: false,
    };
  }

  async getSupportedModels(): Promise<ModelOption[]> {
    return [];
  }

  getInternalSessionId(_id: string): string | undefined {
    return undefined;
  }

  /** Required by AgentRuntimeLike (relay package) for SDK session ID lookup. */
  getSdkSessionId(_id: string): string | undefined {
    return undefined;
  }

  async getCommands(_forceRefresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return { commands: [], lastScanned: '' };
  }

  checkSessionHealth(): void {}

  approveTool(_id: string, _toolCallId: string, _approved: boolean): boolean {
    return false;
  }

  submitAnswers(_id: string, _toolCallId: string, _answers: Record<string, string>): boolean {
    return false;
  }
}
