/**
 * OpenCode Runtime — implements the AgentRuntime interface for OpenCode.
 *
 * Skeleton facade: `checkDependencies()` is real; session lifecycle,
 * messaging, storage, and capabilities land with the remaining P3 tasks
 * (sidecar server-manager, SSE event mapper, session mapper, full facade).
 * Registration in the composition root is gated on `runtimes.opencode.enabled`
 * and happens when the facade is complete.
 *
 * @module services/runtimes/opencode/opencode-runtime
 */
import type {
  StreamEvent,
  PermissionMode,
  EffortLevel,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
} from '@dorkos/shared/types';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  DependencyCheck,
  SessionOpts,
  MessageOpts,
  SseResponse,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import { checkOpenCodeDependencies } from './check-dependencies.js';

/**
 * Throw for OpenCodeRuntime methods the remaining P3 tasks implement
 * (sidecar server-manager, SSE event mapper, session mapper, full facade).
 */
function notImplemented(method: string): never {
  throw new Error(
    `OpenCodeRuntime.${method} is not implemented yet (additional-agent-runtimes P3)`
  );
}

/**
 * OpenCode runtime implementing the universal AgentRuntime interface.
 *
 * One DorkOS session maps to one OpenCode session on a managed
 * `opencode serve` sidecar (ADR-0306). Only the dependency check is live
 * today; every other method throws until the sidecar, mappers, and facade
 * tasks fill them in.
 */
export class OpenCodeRuntime implements AgentRuntime {
  readonly type = 'opencode' as const;

  // --- Session lifecycle ---

  ensureSession(_sessionId: string, _opts: SessionOpts): void {
    notImplemented('ensureSession');
  }

  hasSession(_sessionId: string): boolean {
    return notImplemented('hasSession');
  }

  forkSession(
    _projectDir: string,
    _sessionId: string,
    _opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    return notImplemented('forkSession');
  }

  updateSession(
    _sessionId: string,
    _opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): boolean {
    return notImplemented('updateSession');
  }

  renameSession(_sessionId: string, _title: string, _projectDir: string): Promise<void> {
    return notImplemented('renameSession');
  }

  // --- Messaging ---

  sendMessage(
    _sessionId: string,
    _content: string,
    _opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    return notImplemented('sendMessage');
  }

  // --- Interactive flows ---

  approveTool(
    _sessionId: string,
    _toolCallId: string,
    _approved: boolean,
    _alwaysAllow?: boolean
  ): boolean {
    return notImplemented('approveTool');
  }

  submitAnswers(
    _sessionId: string,
    _toolCallId: string,
    _answers: Record<string, string>
  ): boolean {
    return notImplemented('submitAnswers');
  }

  submitElicitation(
    _sessionId: string,
    _interactionId: string,
    _action: 'accept' | 'decline' | 'cancel',
    _content?: Record<string, unknown>
  ): boolean {
    return notImplemented('submitElicitation');
  }

  stopTask(_sessionId: string, _taskId: string): Promise<boolean> {
    return notImplemented('stopTask');
  }

  interruptQuery(_sessionId: string): Promise<boolean> {
    return notImplemented('interruptQuery');
  }

  // --- Session queries (storage) ---

  listSessions(_projectDir: string): Promise<Session[]> {
    return notImplemented('listSessions');
  }

  getSession(_projectDir: string, _sessionId: string): Promise<Session | null> {
    return notImplemented('getSession');
  }

  getMessageHistory(_projectDir: string, _sessionId: string): Promise<HistoryMessage[]> {
    return notImplemented('getMessageHistory');
  }

  getSessionSnapshot(_ctx: SessionOpts, _sessionId: string): Promise<SessionSnapshot> {
    return notImplemented('getSessionSnapshot');
  }

  subscribeSession(
    _ctx: SessionOpts,
    _sessionId: string,
    _sinceCursor?: number,
    _signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return notImplemented('subscribeSession');
  }

  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return notImplemented('subscribeSessionList');
  }

  getSessionTasks(_projectDir: string, _sessionId: string): Promise<TaskItem[]> {
    return notImplemented('getSessionTasks');
  }

  getSessionETag(_projectDir: string, _sessionId: string): Promise<string | null> {
    return notImplemented('getSessionETag');
  }

  getLastMessageIds(_sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return notImplemented('getLastMessageIds');
  }

  readFromOffset(
    _projectDir: string,
    _sessionId: string,
    _offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return notImplemented('readFromOffset');
  }

  // --- Session locking ---

  acquireLock(_sessionId: string, _clientId: string, _res: SseResponse, _token?: symbol): boolean {
    return notImplemented('acquireLock');
  }

  releaseLock(_sessionId: string, _clientId: string, _token?: symbol): void {
    notImplemented('releaseLock');
  }

  isLocked(_sessionId: string, _clientId?: string): boolean {
    return notImplemented('isLocked');
  }

  getLockInfo(_sessionId: string): { clientId: string; acquiredAt: number } | null {
    return notImplemented('getLockInfo');
  }

  // --- Capabilities ---

  getSupportedModels(): Promise<ModelOption[]> {
    return notImplemented('getSupportedModels');
  }

  getSupportedSubagents(): Promise<SubagentInfo[]> {
    return notImplemented('getSupportedSubagents');
  }

  getCapabilities(): RuntimeCapabilities {
    // Finalized by the sidecar/permission verification task (3.2).
    return notImplemented('getCapabilities');
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return checkOpenCodeDependencies();
  }

  // --- Commands ---

  getCommands(_forceRefresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return notImplemented('getCommands');
  }

  // --- Lifecycle ---

  checkSessionHealth(): void {
    notImplemented('checkSessionHealth');
  }

  getInternalSessionId(_sessionId: string): string | undefined {
    return notImplemented('getInternalSessionId');
  }
}
