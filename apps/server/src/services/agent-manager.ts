import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { query, type Options, type SDKMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, PermissionMode, TaskUpdateEvent, TaskStatus } from '@lifeos/shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Resolve the Claude Code CLI path for the SDK to spawn. */
function resolveClaudeCliPath(): string | undefined {
  // 1. Try the SDK's bundled cli.js (works when running from source / node_modules)
  try {
    const sdkCli = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (existsSync(sdkCli)) return sdkCli;
  } catch { /* not resolvable in bundled context */ }

  // 2. Find the globally installed `claude` binary via PATH
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    if (bin && existsSync(bin)) return bin;
  } catch { /* not found on PATH */ }

  // 3. Let SDK use its default resolution (may fail in Electron)
  return undefined;
}

interface PendingInteraction {
  type: 'question' | 'approval';
  toolCallId: string;
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  cwd?: string;
  /** True once the first SDK query has been sent (JSONL file exists) */
  hasStarted: boolean;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

function handleAskUserQuestion(
  session: AgentSession,
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions: input.questions as import('@lifeos/shared/types').QuestionItem[],
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      resolve: (answers) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers },
        });
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}

function handleToolApproval(
  session: AgentSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' });
    }, INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      resolve: (approved) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve(
          approved
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'User denied tool execution' },
        );
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export function buildTaskEvent(toolName: string, input: Record<string, unknown>): TaskUpdateEvent | null {
  switch (toolName) {
    case 'TaskCreate':
      return {
        action: 'create',
        task: {
          id: '',
          subject: (input.subject as string) ?? '',
          description: input.description as string | undefined,
          activeForm: input.activeForm as string | undefined,
          status: 'pending',
        },
      };
    case 'TaskUpdate': {
      // Only include fields the SDK actually sent — the client's stripDefaults
      // strips empty strings during merge, so absent fields use '' sentinel.
      const task: TaskUpdateEvent['task'] = {
        id: (input.taskId as string) ?? '',
        subject: (input.subject as string) ?? '',
        status: (input.status as TaskStatus) ?? ('' as TaskStatus),
      };
      if (input.activeForm) task.activeForm = input.activeForm as string;
      if (input.description) task.description = input.description as string;
      if (input.addBlockedBy) task.blockedBy = input.addBlockedBy as string[];
      if (input.addBlocks) task.blocks = input.addBlocks as string[];
      if (input.owner) task.owner = input.owner as string;
      return { action: 'update', task };
    }
    default:
      return null;
  }
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;

  constructor(cwd?: string) {
    this.cwd = cwd ?? path.resolve(__dirname, '../../../../');
    this.claudeCliPath = resolveClaudeCliPath();
  }

  /**
   * Start or resume an agent session.
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   */
  ensureSession(sessionId: string, opts: {
    permissionMode: PermissionMode;
    cwd?: string;
  }): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sdkSessionId: sessionId,
        lastActivity: Date.now(),
        permissionMode: opts.permissionMode,
        cwd: opts.cwd,
        hasStarted: false,
        pendingInteractions: new Map(),
        eventQueue: [],
      });
    }
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode }
  ): AsyncGenerator<StreamEvent> {
    // Auto-create session if it doesn't exist (for resuming SDK sessions)
    if (!this.sessions.has(sessionId)) {
      this.ensureSession(sessionId, {
        permissionMode: opts?.permissionMode ?? 'default',
      });
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    session.eventQueue = [];

    const sdkOptions: Options = {
      cwd: session.cwd ?? this.cwd,
      includePartialMessages: true,
      settingSources: ['project', 'user'],
      ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
    };

    // Only resume if the session has been started (JSONL exists)
    if (session.hasStarted) {
      sdkOptions.resume = session.sdkSessionId;
    }

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

    // Register canUseTool callback for interactive tools
    sdkOptions.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      context: {
        signal: AbortSignal;
        toolUseID: string;
        decisionReason?: string;
        suggestions?: unknown[];
      },
    ): Promise<PermissionResult> => {
      // AskUserQuestion: pause, collect answers, inject into input
      if (toolName === 'AskUserQuestion') {
        return handleAskUserQuestion(session, context.toolUseID, input);
      }

      // Tool approval: pause when permissionMode is 'default'
      if (session.permissionMode === 'default') {
        return handleToolApproval(session, context.toolUseID, toolName, input);
      }

      // All other cases: allow immediately
      return { behavior: 'allow' };
    };

    const agentQuery = query({ prompt: content, options: sdkOptions });

    let inTool = false;
    let currentToolName = '';
    let currentToolId = '';
    let emittedDone = false;
    let taskToolInput = '';

    const toolState = {
      get inTool() { return inTool; },
      get currentToolName() { return currentToolName; },
      get currentToolId() { return currentToolId; },
      get taskToolInput() { return taskToolInput; },
      appendTaskInput: (chunk: string) => { taskToolInput += chunk; },
      resetTaskInput: () => { taskToolInput = ''; },
      setToolState: (tool: boolean, name: string, id: string) => {
        inTool = tool;
        currentToolName = name;
        currentToolId = id;
      },
    };

    try {
      const sdkIterator = agentQuery[Symbol.asyncIterator]();
      // Cache the SDK promise so we never call .next() twice concurrently
      let pendingSdkPromise: Promise<{ sdk: true; result: IteratorResult<SDKMessage> }> | null = null;

      while (true) {
        // Drain any events pushed by canUseTool callbacks
        while (session.eventQueue.length > 0) {
          const queuedEvent = session.eventQueue.shift()!;
          if (queuedEvent.type === 'done') emittedDone = true;
          yield queuedEvent;
        }

        // Race between SDK yielding next message and queue getting a new event
        const queuePromise = new Promise<'queue'>(resolve => {
          session.eventQueueNotify = () => resolve('queue');
        });

        // Only call .next() if we don't already have a pending SDK promise
        if (!pendingSdkPromise) {
          pendingSdkPromise = sdkIterator.next().then(result => ({ sdk: true as const, result }));
        }

        const winner = await Promise.race([queuePromise, pendingSdkPromise]);

        if (winner === 'queue') {
          // Queue got new items from canUseTool, drain them on next iteration.
          // pendingSdkPromise stays cached — we'll race it again next time.
          continue;
        }

        // SDK yielded a message — consume the cached promise
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
    // Capture session ID from init (for new sessions where SDK assigns the ID)
    if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
      session.sdkSessionId = message.session_id;
      session.hasStarted = true;
      // Forward model info from init
      const initModel = (message as Record<string, unknown>).model as string | undefined;
      if (initModel) {
        yield {
          type: 'session_status',
          data: {
            sessionId,
            model: initModel,
          },
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
            } catch { /* malformed JSON, skip */ }
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
      // modelUsage is Record<string, ModelUsage> — grab the first entry for contextWindow
      const modelUsageMap = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
      const firstModelUsage = modelUsageMap
        ? Object.values(modelUsageMap)[0]
        : undefined;
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

  updateSession(sessionId: string, opts: { permissionMode?: PermissionMode; model?: string }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (opts.permissionMode) {
      session.permissionMode = opts.permissionMode;
    }
    if (opts.model) {
      session.model = opts.model;
    }
    return true;
  }

  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
    const session = this.sessions.get(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') return false;
    pending.resolve(approved);
    return true;
  }

  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const session = this.sessions.get(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  checkSessionHealth(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        // Clean up any pending interactions
        for (const interaction of session.pendingInteractions.values()) {
          clearTimeout(interaction.timeout);
        }
        this.sessions.delete(id);
      }
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the actual SDK session ID (may differ from input if SDK assigned a new one).
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.sdkSessionId;
  }
}

export const agentManager = new AgentManager();
