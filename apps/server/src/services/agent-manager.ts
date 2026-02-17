import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import {
  query,
  type Options,
  type SDKMessage,
  type PermissionResult,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import type { Response } from 'express';
import type { StreamEvent, PermissionMode } from '@dorkos/shared/types';
import { SESSIONS } from '../config/constants.js';
import { SessionLockManager } from './session-lock.js';
import {
  handleAskUserQuestion,
  handleToolApproval,
  type PendingInteraction,
} from './interactive-handlers.js';
import { buildTaskEvent, TASK_TOOL_NAMES } from './build-task-event.js';
import { validateBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

// Re-export for backward compatibility
export { buildTaskEvent } from './build-task-event.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the Claude Code CLI path for the SDK to spawn.
 *
 * Tries SDK bundled path first, then PATH lookup, then falls back to
 * undefined for SDK default resolution (may fail in Electron).
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Try the SDK's bundled cli.js (works when running from source / node_modules)
  try {
    const sdkCli = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (existsSync(sdkCli)) return sdkCli;
  } catch {
    /* not resolvable in bundled context */
  }

  // 2. Find the globally installed `claude` binary via PATH
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    if (bin && existsSync(bin)) return bin;
  } catch {
    /* not found on PATH */
  }

  // 3. Let SDK use its default resolution (may fail in Electron)
  return undefined;
}

interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  cwd?: string;
  /** True once the first SDK query has been sent (JSONL file exists) */
  hasStarted: boolean;
  /** Active SDK query object — used for mid-stream control (setPermissionMode, setModel) */
  activeQuery?: Query;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/**
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Calls the SDK's `query()` function and maps streaming events
 * to DorkOS `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout.
 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private lockManager = new SessionLockManager();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.env.DORKOS_DEFAULT_CWD ?? path.resolve(__dirname, '../../../../');
    this.claudeCliPath = resolveClaudeCliPath();
  }

  /**
   * Start or resume an agent session.
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   */
  ensureSession(
    sessionId: string,
    opts: {
      permissionMode: PermissionMode;
      cwd?: string;
      hasStarted?: boolean;
    }
  ): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sdkSessionId: sessionId,
        lastActivity: Date.now(),
        permissionMode: opts.permissionMode,
        cwd: opts.cwd,
        hasStarted: opts.hasStarted ?? false,
        pendingInteractions: new Map(),
        eventQueue: [],
      });
    }
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string }
  ): AsyncGenerator<StreamEvent> {
    // Auto-create session if it doesn't exist (for resuming SDK sessions).
    if (!this.sessions.has(sessionId)) {
      this.ensureSession(sessionId, {
        permissionMode: opts?.permissionMode ?? 'default',
        cwd: opts?.cwd,
        hasStarted: true,
      });
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    session.eventQueue = [];

    const effectiveCwd = session.cwd ?? this.cwd;
    try {
      await validateBoundary(effectiveCwd);
    } catch {
      yield { type: 'error', data: { message: `Directory boundary violation: ${effectiveCwd}` } };
      return;
    }

    const sdkOptions: Options = {
      cwd: effectiveCwd,
      includePartialMessages: true,
      settingSources: ['project', 'user'],
      ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
    };

    if (session.hasStarted) {
      sdkOptions.resume = session.sdkSessionId;
    }

    logger.debug('[sendMessage]', {
      session: sessionId,
      permissionMode: session.permissionMode,
      hasStarted: session.hasStarted,
      resume: session.hasStarted ? session.sdkSessionId : 'N/A',
    });

    switch (session.permissionMode) {
      case 'bypassPermissions':
        sdkOptions.permissionMode = 'bypassPermissions';
        sdkOptions.allowDangerouslySkipPermissions = true;
        break;
      case 'plan':
        sdkOptions.permissionMode = 'plan';
        break;
      case 'acceptEdits':
        sdkOptions.permissionMode = 'acceptEdits';
        break;
      default:
        sdkOptions.permissionMode = 'default';
    }

    if (session.model) {
      (sdkOptions as Record<string, unknown>).model = session.model;
    }

    sdkOptions.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      context: {
        signal: AbortSignal;
        toolUseID: string;
        decisionReason?: string;
        suggestions?: unknown[];
      }
    ): Promise<PermissionResult> => {
      if (toolName === 'AskUserQuestion') {
        logger.debug('[canUseTool] routing to question handler', {
          toolName,
          toolUseID: context.toolUseID,
        });
        return handleAskUserQuestion(session, context.toolUseID, input);
      }

      if (session.permissionMode === 'default') {
        logger.debug('[canUseTool] requesting approval', {
          toolName,
          permissionMode: 'default',
          toolUseID: context.toolUseID,
        });
        return handleToolApproval(session, context.toolUseID, toolName, input);
      }

      logger.debug('[canUseTool] auto-allow', {
        toolName,
        permissionMode: session.permissionMode,
        toolUseID: context.toolUseID,
      });
      return { behavior: 'allow', updatedInput: input };
    };

    const agentQuery = query({ prompt: content, options: sdkOptions });
    session.activeQuery = agentQuery;

    let inTool = false;
    let currentToolName = '';
    let currentToolId = '';
    let emittedDone = false;
    let taskToolInput = '';

    const toolState = {
      get inTool() {
        return inTool;
      },
      get currentToolName() {
        return currentToolName;
      },
      get currentToolId() {
        return currentToolId;
      },
      get taskToolInput() {
        return taskToolInput;
      },
      appendTaskInput: (chunk: string) => {
        taskToolInput += chunk;
      },
      resetTaskInput: () => {
        taskToolInput = '';
      },
      setToolState: (tool: boolean, name: string, id: string) => {
        inTool = tool;
        currentToolName = name;
        currentToolId = id;
      },
    };

    try {
      const sdkIterator = agentQuery[Symbol.asyncIterator]();
      let pendingSdkPromise: Promise<{ sdk: true; result: IteratorResult<SDKMessage> }> | null =
        null;

      while (true) {
        while (session.eventQueue.length > 0) {
          const queuedEvent = session.eventQueue.shift()!;
          if (queuedEvent.type === 'done') emittedDone = true;
          yield queuedEvent;
        }

        const queuePromise = new Promise<'queue'>((resolve) => {
          session.eventQueueNotify = () => resolve('queue');
        });

        if (!pendingSdkPromise) {
          pendingSdkPromise = sdkIterator.next().then((result) => ({ sdk: true as const, result }));
        }

        const winner = await Promise.race([queuePromise, pendingSdkPromise]);

        if (winner === 'queue') {
          continue;
        }

        pendingSdkPromise = null;
        const { result } = winner;
        if (result.done) break;

        for await (const event of this.mapSdkMessage(result.value, session, sessionId, toolState)) {
          if (event.type === 'done') emittedDone = true;
          yield event;
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        data: {
          message: err instanceof Error ? err.message : 'SDK error',
        },
      };
    } finally {
      session.activeQuery = undefined;
    }

    if (!emittedDone) {
      yield {
        type: 'done',
        data: { sessionId },
      };
    }
  }

  private async *mapSdkMessage(
    message: SDKMessage,
    session: AgentSession,
    sessionId: string,
    toolState: {
      inTool: boolean;
      currentToolName: string;
      currentToolId: string;
      taskToolInput: string;
      appendTaskInput: (chunk: string) => void;
      resetTaskInput: () => void;
      setToolState: (tool: boolean, name: string, id: string) => void;
    }
  ): AsyncGenerator<StreamEvent> {
    if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
      session.sdkSessionId = message.session_id;
      session.hasStarted = true;
      const initModel = (message as Record<string, unknown>).model as string | undefined;
      if (initModel) {
        yield {
          type: 'session_status',
          data: { sessionId, model: initModel },
        };
      }
      return;
    }

    if (message.type === 'stream_event') {
      const event = (message as { event: Record<string, unknown> }).event;
      const eventType = event.type as string;

      if (eventType === 'content_block_start') {
        const contentBlock = event.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === 'tool_use') {
          toolState.resetTaskInput();
          toolState.setToolState(true, contentBlock.name as string, contentBlock.id as string);
          yield {
            type: 'tool_call_start',
            data: {
              toolCallId: contentBlock.id as string,
              toolName: contentBlock.name as string,
              status: 'running',
            },
          };
        }
      } else if (eventType === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && !toolState.inTool) {
          yield { type: 'text_delta', data: { text: delta.text as string } };
        } else if (delta?.type === 'input_json_delta' && toolState.inTool) {
          if (TASK_TOOL_NAMES.has(toolState.currentToolName)) {
            toolState.appendTaskInput(delta.partial_json as string);
          }
          yield {
            type: 'tool_call_delta',
            data: {
              toolCallId: toolState.currentToolId,
              toolName: toolState.currentToolName,
              input: delta.partial_json as string,
              status: 'running',
            },
          };
        }
      } else if (eventType === 'content_block_stop') {
        if (toolState.inTool) {
          const wasTaskTool = TASK_TOOL_NAMES.has(toolState.currentToolName);
          const taskToolName = toolState.currentToolName;
          yield {
            type: 'tool_call_end',
            data: {
              toolCallId: toolState.currentToolId,
              toolName: toolState.currentToolName,
              status: 'complete',
            },
          };
          toolState.setToolState(false, '', '');
          if (wasTaskTool && toolState.taskToolInput) {
            try {
              const input = JSON.parse(toolState.taskToolInput);
              const taskEvent = buildTaskEvent(taskToolName, input);
              if (taskEvent) {
                yield { type: 'task_update', data: taskEvent };
              }
            } catch {
              /* malformed JSON, skip */
            }
            toolState.resetTaskInput();
          }
        }
      }
      return;
    }

    if (message.type === 'tool_use_summary') {
      const summary = message as { summary: string; preceding_tool_use_ids: string[] };
      for (const toolUseId of summary.preceding_tool_use_ids) {
        yield {
          type: 'tool_result',
          data: {
            toolCallId: toolUseId,
            toolName: '',
            result: summary.summary,
            status: 'complete',
          },
        };
      }
      return;
    }

    if (message.type === 'result') {
      const result = message as Record<string, unknown>;
      const usage = result.usage as Record<string, unknown> | undefined;
      const modelUsageMap = result.modelUsage as
        | Record<string, Record<string, unknown>>
        | undefined;
      const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;
      yield {
        type: 'session_status',
        data: {
          sessionId,
          model: result.model as string | undefined,
          costUsd: result.total_cost_usd as number | undefined,
          contextTokens: usage?.input_tokens as number | undefined,
          contextMaxTokens: firstModelUsage?.contextWindow as number | undefined,
        },
      };
      yield {
        type: 'done',
        data: { sessionId },
      };
    }
  }

  updateSession(
    sessionId: string,
    opts: { permissionMode?: PermissionMode; model?: string }
  ): boolean {
    let session = this.findSession(sessionId);
    if (!session) {
      this.ensureSession(sessionId, {
        permissionMode: opts.permissionMode ?? 'default',
        hasStarted: true,
      });
      session = this.sessions.get(sessionId)!;
    }
    if (opts.permissionMode) {
      logger.debug('[updateSession] permissionMode change', {
        sessionId,
        from: session.permissionMode,
        to: opts.permissionMode,
      });
      session.permissionMode = opts.permissionMode;
      if (session.activeQuery) {
        logger.debug('[updateSession] calling setPermissionMode on active query', {
          sessionId,
          permissionMode: opts.permissionMode,
        });
        session.activeQuery.setPermissionMode(opts.permissionMode).catch((err) => {
          logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
        });
      }
    }
    if (opts.model) {
      session.model = opts.model;
    }
    return true;
  }

  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') {
      logger.debug('[approveTool] interaction not found', {
        sessionId,
        toolCallId,
        approved,
        hasSession: !!session,
        hasPending: !!pending,
        pendingType: pending?.type,
      });
      return false;
    }
    logger.debug('[approveTool] resolving', { sessionId, toolCallId, approved });
    pending.resolve(approved);
    return true;
  }

  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  checkSessionHealth(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        for (const interaction of session.pendingInteractions.values()) {
          clearTimeout(interaction.timeout);
        }
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    this.lockManager.cleanup(expiredIds);
  }

  /**
   * Find a session by its map key OR by its sdkSessionId.
   */
  private findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    for (const session of this.sessions.values()) {
      if (session.sdkSessionId === sessionId) return session;
    }
    return undefined;
  }

  hasSession(sessionId: string): boolean {
    return !!this.findSession(sessionId);
  }

  /** Get the actual SDK session ID (may differ from input if SDK assigned a new one). */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.findSession(sessionId)?.sdkSessionId;
  }

  // Session lock delegation
  acquireLock(sessionId: string, clientId: string, res: Response): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res);
  }

  releaseLock(sessionId: string, clientId: string): void {
    this.lockManager.releaseLock(sessionId, clientId);
  }

  isLocked(sessionId: string, clientId?: string): boolean {
    return this.lockManager.isLocked(sessionId, clientId);
  }

  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.lockManager.getLockInfo(sessionId);
  }
}

export const agentManager = new AgentManager();
