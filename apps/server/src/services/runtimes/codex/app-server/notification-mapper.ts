/**
 * `codex app-server` notifications → DorkOS StreamEvents, for ONE turn (spec
 * `codex-app-server-transport` §7).
 *
 * The transport routes each notification here only when it belongs to this
 * turn (its `turnId` is the thread's active turn); anything else goes to the
 * thread's late sink. This class is otherwise pure: it keeps the turn's own
 * state (which tools started, how much of each message streamed, the latest
 * token usage, a held fatal error) and returns the events each notification
 * means.
 *
 * Exhaustive by construction: {@link NOTIFICATION_DISPOSITION} and the item
 * handler table are keyed on the full unions from `protocol/methods.ts`, so a
 * notification or item type a later binary adds fails compilation here until
 * somebody decides what it means — the same tripwire `event-mapper.ts` has.
 *
 * Tool names and shapes match exec's (`Shell`, `ApplyPatch`, `WebSearch`,
 * `mcp__server__tool`), so history, tool cards and rooms read the same on both
 * transports.
 *
 * @module services/runtimes/codex/app-server/notification-mapper
 */
import type { StreamEvent, TaskItem } from '@dorkos/shared/types';
import {
  PATCH_TOOL_NAME,
  SHELL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  codexErrorCopy,
  type CodexEventContext,
} from '../event-mapper.js';
import { recordCodexMedia } from '../media-capture.js';
import { isCodexUsageLimitMessage, noteCodexTurnUsage } from '../account-usage.js';
import type {
  ServerNotification,
  ServerNotificationMethod,
  ThreadItemType,
} from './protocol/methods.js';

/** Where a notification goes. */
export type NotificationDisposition =
  /** Mapped for the turn it names. */
  | 'turn'
  /** About the thread or process, not a turn; the transport handles it. */
  | 'thread'
  /** Not used by DorkOS (counted, ignored). */
  | 'ignored';

/**
 * Every notification the pinned binary can send, and where it goes. A
 * `Record` over the full union: adding a method to `methods.ts` without an
 * entry here is a compile error.
 */
export const NOTIFICATION_DISPOSITION: Record<ServerNotificationMethod, NotificationDisposition> = {
  error: 'turn',
  'thread/started': 'thread',
  'thread/status/changed': 'ignored',
  'thread/archived': 'ignored',
  'thread/deleted': 'ignored',
  'thread/unarchived': 'ignored',
  'thread/closed': 'thread',
  'thread/reverted': 'ignored',
  'skills/changed': 'ignored',
  'thread/name/updated': 'ignored',
  'thread/goal/updated': 'ignored',
  'thread/goal/cleared': 'ignored',
  'thread/queue/changed': 'ignored',
  'project/changed': 'ignored',
  'thread/project/updated': 'ignored',
  'thread/environment/connected': 'ignored',
  'thread/environment/disconnected': 'ignored',
  'thread/settings/updated': 'ignored',
  'thread/tokenUsage/updated': 'turn',
  'turn/started': 'turn',
  'hook/started': 'ignored',
  'turn/completed': 'turn',
  'hook/completed': 'ignored',
  'turn/diff/updated': 'ignored',
  'turn/plan/updated': 'turn',
  'item/started': 'turn',
  'item/autoApprovalReview/started': 'ignored',
  'item/autoApprovalReview/completed': 'ignored',
  'autoApprovalReview/strictReviewRequired': 'ignored',
  'item/completed': 'turn',
  'item/agentMessage/delta': 'turn',
  'item/plan/delta': 'ignored',
  'command/exec/outputDelta': 'ignored',
  'process/outputDelta': 'ignored',
  'process/exited': 'ignored',
  'item/commandExecution/outputDelta': 'turn',
  'item/commandExecution/terminalInteraction': 'ignored',
  'item/fileChange/outputDelta': 'ignored',
  'item/fileChange/patchUpdated': 'ignored',
  'serverRequest/resolved': 'thread',
  'item/mcpToolCall/progress': 'turn',
  'mcpServer/oauthLogin/completed': 'ignored',
  'mcpServer/startupStatus/updated': 'ignored',
  'mcpServer/event/stream/notification': 'ignored',
  'account/updated': 'ignored',
  'account/rateLimits/updated': 'thread',
  'app/list/updated': 'ignored',
  'remoteControl/status/changed': 'ignored',
  'externalAgentConfig/import/progress': 'ignored',
  'externalAgentConfig/import/completed': 'ignored',
  'fs/changed': 'ignored',
  'item/reasoning/summaryTextDelta': 'turn',
  'item/reasoning/summaryPartAdded': 'ignored',
  'item/reasoning/textDelta': 'ignored',
  'thread/compacted': 'turn',
  'model/rerouted': 'turn',
  'model/verification': 'ignored',
  'modelProvider/authRecoveryStarted': 'ignored',
  'modelProvider/authRecoveryCompleted': 'ignored',
  'turn/moderationMetadata': 'ignored',
  'model/safetyBuffering/updated': 'ignored',
  warning: 'thread',
  guardianWarning: 'ignored',
  deprecationNotice: 'thread',
  configWarning: 'thread',
  'fuzzyFileSearch/sessionUpdated': 'ignored',
  'fuzzyFileSearch/sessionCompleted': 'ignored',
  'thread/realtime/started': 'ignored',
  'thread/realtime/itemAdded': 'ignored',
  'thread/realtime/item/started': 'ignored',
  'thread/realtime/item/transcript/delta': 'ignored',
  'thread/realtime/item/completed': 'ignored',
  'thread/realtime/transcript/delta': 'ignored',
  'thread/realtime/transcript/done': 'ignored',
  'thread/realtime/outputAudio/delta': 'ignored',
  'thread/realtime/sdp': 'ignored',
  'thread/realtime/error': 'ignored',
  'thread/realtime/closed': 'ignored',
  'windows/worldWritableWarning': 'ignored',
  'windowsSandbox/setupCompleted': 'ignored',
  'account/login/completed': 'ignored',
};

/** The copy a turn ends with when the process went away under it (§5). */
export const CODEX_STOPPED_COPY =
  'Codex stopped unexpectedly. Send your message again to continue.';

type Item = Record<string, unknown> & { type: string; id?: string };
type Phase = 'started' | 'completed';

/** Seams for one turn's mapper. */
export interface TurnMapperOptions {
  /** The turn's rate-limit readings in rollout shape (`[]` on credits). */
  readonly rateLimits?: () => readonly unknown[];
}

/** Maps one turn's notifications. */
export class AppServerTurnMapper {
  private readonly startedTools = new Set<string>();
  /** The input each tool start carried, for an approval card about it. */
  private readonly toolInputs = new Map<string, string>();
  /** MCP tool calls still running, by item id. */
  private readonly runningMcp = new Map<string, { server: string; tool: string }>();
  /** Command items still running, with their process id when they have one. */
  private readonly runningCommands = new Map<
    string,
    { processId: string | null; command: string }
  >();
  private readonly streamedText = new Map<string, string>();
  private lastUsage:
    | { last: { totalTokens: number }; total: Record<string, number>; window: number | null }
    | undefined;
  private heldError: { message: string; code?: string } | undefined;
  private finished = false;

  /**
   * Start mapping a turn.
   *
   * @param ctx - The turn's shared event context (media state, session id).
   * @param options - Rate limits.
   */
  constructor(
    private readonly ctx: CodexEventContext,
    private readonly options: TurnMapperOptions = {}
  ) {}

  /** Whether the turn's terminal has been emitted. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * The events one notification means for this turn. After the terminal, `[]`.
   *
   * @param notification - A notification the transport routed to this turn.
   */
  map(notification: ServerNotification): StreamEvent[] {
    if (this.finished) return [];
    const params = (notification.params ?? {}) as Record<string, unknown>;
    switch (notification.method) {
      case 'item/agentMessage/delta': {
        const itemId = String(params.itemId);
        const delta = String(params.delta);
        this.streamedText.set(itemId, (this.streamedText.get(itemId) ?? '') + delta);
        return delta ? [{ type: 'text_delta', data: { text: delta } }] : [];
      }
      case 'item/reasoning/summaryTextDelta': {
        const delta = String(params.delta);
        return delta ? [{ type: 'thinking_delta', data: { text: delta } }] : [];
      }
      case 'item/commandExecution/outputDelta': {
        const delta = String(params.delta);
        return delta
          ? [{ type: 'tool_progress', data: { toolCallId: String(params.itemId), content: delta } }]
          : [];
      }
      case 'item/mcpToolCall/progress':
        return [
          {
            type: 'tool_progress',
            data: { toolCallId: String(params.itemId), content: String(params.message) },
          },
        ];
      case 'item/started':
        return this.mapItem(params.item as Item, 'started');
      case 'item/completed':
        return this.mapItem(params.item as Item, 'completed');
      case 'turn/plan/updated':
        return this.mapPlan(params.plan as Array<{ step: string; status: string }>);
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as {
          last: { totalTokens: number };
          total: Record<string, number>;
          modelContextWindow: number | null;
        };
        this.lastUsage = { last: usage.last, total: usage.total, window: usage.modelContextWindow };
        return [];
      }
      case 'model/rerouted':
        // `model_substituted` names only a credits substitution; this is Codex's
        // own choice, so it is said as a status rather than mislabelled.
        return [
          {
            type: 'system_status',
            data: {
              message: `Codex answered with ${String(params.toModel)} instead of ${String(params.fromModel)}.`,
            },
          },
        ];
      case 'thread/compacted':
        return [{ type: 'compact_boundary', data: { trigger: 'auto' } }];
      case 'error':
        return this.mapError(params);
      case 'turn/completed':
        return this.complete(
          params.turn as {
            status: string;
            error?: { message?: string; codexErrorInfo?: unknown } | null;
          }
        );
      default:
        return [];
    }
  }

  /**
   * The turn ends because the process went away under it: one error, one done.
   *
   * @param detail - Exit code/signal or protocol fault, kept in `details`.
   */
  closeOnCrash(detail: string): StreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [
      { type: 'session_status', data: { sessionId: this.ctx.sessionId, terminalReason: 'error' } },
      {
        type: 'error',
        data: { message: CODEX_STOPPED_COPY, code: 'codex_stopped', details: detail },
      },
      { type: 'done', data: { sessionId: this.ctx.sessionId } },
    ];
  }

  /**
   * The turn ends on DorkOS's side (a stop Codex never confirmed, or a refused
   * start): a quiet done, or an error first when there is something to say.
   *
   * @param error - What to tell the person, if anything.
   */
  closeQuietly(error?: { message: string; code: string }): StreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [
      ...(error ? ([{ type: 'error', data: error }] as StreamEvent[]) : []),
      { type: 'done', data: { sessionId: this.ctx.sessionId } },
    ];
  }

  /**
   * Command items still running when the turn completed: background commands
   * (P3 tracks them; P1 records them so the wake can find them).
   */
  backgroundCommands(): Array<{ itemId: string; processId: string; command: string }> {
    return [...this.runningCommands.entries()]
      .filter(([, command]) => command.processId !== null)
      .map(([itemId, command]) => ({
        itemId,
        processId: command.processId!,
        command: command.command,
      }));
  }

  private complete(turn: {
    status: string;
    error?: { message?: string; codexErrorInfo?: unknown } | null;
  }): StreamEvent[] {
    this.finished = true;
    const sessionId = this.ctx.sessionId;
    const background: StreamEvent[] = this.backgroundCommands().map((command) => ({
      type: 'background_task_started',
      data: {
        taskId: command.itemId,
        taskType: 'bash',
        startedAt: Date.now(),
        command: command.command,
      },
    }));
    if (turn.status === 'interrupted') {
      return [...background, { type: 'done', data: { sessionId } }];
    }
    if (turn.status === 'failed') {
      const message =
        turn.error?.message ?? this.heldError?.message ?? 'Codex could not finish this reply.';
      const info = turn.error?.codexErrorInfo;
      const limit = this.noteUsage(
        info === 'usageLimitExceeded' || isCodexUsageLimitMessage(message)
      );
      const copy = codexErrorCopy(message, {
        code: info === 'unauthorized' ? 'authentication_failed' : 'turn_failed',
      });
      return [
        ...background,
        { type: 'session_status', data: { sessionId, terminalReason: 'error' } },
        { type: 'error', data: { ...copy, code: 'turn_failed' } },
        ...(limit ? [limit] : []),
        { type: 'done', data: { sessionId } },
      ];
    }
    const limit = this.noteUsage(false);
    const usage = this.lastUsage;
    const held: StreamEvent[] = this.heldError
      ? [
          {
            type: 'error',
            data: {
              ...codexErrorCopy(this.heldError.message, { code: 'turn_failed' }),
              code: 'turn_failed',
            },
          },
        ]
      : [];
    return [
      ...background,
      ...held,
      {
        type: 'session_status',
        data: {
          sessionId,
          ...(usage && usage.window !== null && usage.window > 0
            ? { contextTokens: usage.last.totalTokens, contextMaxTokens: usage.window }
            : {}),
          ...(usage
            ? {
                outputTokens:
                  (usage.total.outputTokens ?? 0) + (usage.total.reasoningOutputTokens ?? 0),
                cacheReadTokens: usage.total.cachedInputTokens ?? 0,
              }
            : {}),
          terminalReason: 'completed',
        },
      },
      ...(limit ? [limit] : []),
      { type: 'done', data: { sessionId } },
    ];
  }

  private noteUsage(failedOnLimit: boolean): StreamEvent | null {
    return noteCodexTurnUsage(
      this.ctx,
      this.options.rateLimits?.() ?? [],
      failedOnLimit,
      new Date(this.ctx.now())
    );
  }

  private mapError(params: Record<string, unknown>): StreamEvent[] {
    const error = params.error as { message: string };
    if (params.willRetry === true) {
      return [{ type: 'system_status', data: { message: `Codex is retrying: ${error.message}` } }];
    }
    // Held, and said once before `done` (turn/completed usually repeats it).
    this.heldError = { message: error.message };
    return [];
  }

  private mapPlan(plan: Array<{ step: string; status: string }>): StreamEvent[] {
    const tasks: TaskItem[] = plan.map((step, index) => ({
      id: String(index + 1),
      subject: step.step,
      status:
        step.status === 'completed'
          ? 'completed'
          : step.status === 'inProgress'
            ? 'in_progress'
            : 'pending',
    }));
    if (tasks.length === 0) {
      return [
        {
          type: 'task_update',
          data: {
            action: 'snapshot',
            task: { id: '0', subject: '', status: 'pending' },
            tasks: [],
          },
        },
      ];
    }
    return [{ type: 'task_update', data: { action: 'snapshot', task: tasks[0]!, tasks } }];
  }

  private mapItem(item: Item, phase: Phase): StreamEvent[] {
    return ITEM_HANDLERS[item.type as ThreadItemType]?.call(this, item, phase) ?? [];
  }

  /** `agentMessage`: deltas streamed already; on completion, emit any tail they missed. */
  agentMessage(item: Item, phase: Phase): StreamEvent[] {
    if (phase !== 'completed') return [];
    const id = String(item.id);
    const full = typeof item.text === 'string' ? item.text : '';
    const streamed = this.streamedText.get(id) ?? '';
    this.streamedText.delete(id);
    const tail = full.startsWith(streamed)
      ? full.slice(streamed.length)
      : streamed === ''
        ? full
        : '';
    return tail ? [{ type: 'text_delta', data: { text: tail } }] : [];
  }

  /** `commandExecution` → the `Shell` tool. */
  commandExecution(item: Item, phase: Phase): StreamEvent[] {
    const id = String(item.id);
    const command = String(item.command ?? '');
    const events = this.toolStart(id, SHELL_TOOL_NAME, JSON.stringify({ command, cwd: item.cwd }));
    if (phase === 'started') {
      this.runningCommands.set(id, {
        processId: typeof item.processId === 'string' ? item.processId : null,
        command,
      });
      return events;
    }
    this.runningCommands.delete(id);
    const status = item.status === 'completed' && (item.exitCode ?? 0) === 0 ? 'complete' : 'error';
    const output =
      item.status === 'declined'
        ? 'Codex was not allowed to run this command.'
        : typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : '';
    events.push({
      type: 'tool_call_end',
      data: { toolCallId: id, toolName: SHELL_TOOL_NAME, status },
    });
    if (output) {
      events.push({
        type: 'tool_result',
        data: { toolCallId: id, toolName: SHELL_TOOL_NAME, result: output, status },
      });
    }
    return events;
  }

  /** `fileChange` → the `ApplyPatch` tool. */
  fileChange(item: Item, phase: Phase): StreamEvent[] {
    const id = String(item.id);
    const changes =
      (item.changes as Array<{ path: string; kind?: { type?: string } }> | undefined) ?? [];
    const events = this.toolStart(id, PATCH_TOOL_NAME, JSON.stringify({ changes }));
    if (phase === 'started') return events;
    const status = item.status === 'completed' ? 'complete' : 'error';
    events.push(
      { type: 'tool_call_end', data: { toolCallId: id, toolName: PATCH_TOOL_NAME, status } },
      {
        type: 'tool_result',
        data: {
          toolCallId: id,
          toolName: PATCH_TOOL_NAME,
          result: changes
            .map((change) => `${change.kind?.type ?? 'update'} ${change.path}`)
            .join('\n'),
          status,
        },
      }
    );
    return events;
  }

  /** `mcpToolCall` → `mcp__server__tool`, media recorded for the runtime to store. */
  mcpToolCall(item: Item, phase: Phase): StreamEvent[] {
    const id = String(item.id);
    const toolName = `mcp__${String(item.server)}__${String(item.tool)}`;
    const events = this.toolStart(id, toolName, JSON.stringify(item.arguments ?? {}));
    if (phase === 'started') {
      this.runningMcp.set(id, { server: String(item.server), tool: String(item.tool) });
      return events;
    }
    this.runningMcp.delete(id);
    const status = item.status === 'completed' ? 'complete' : 'error';
    events.push({ type: 'tool_call_end', data: { toolCallId: id, toolName, status } });
    const result = item.result as { content?: unknown } | null | undefined;
    const text =
      item.status === 'failed'
        ? (item.error as { message?: string } | null | undefined)?.message
        : Array.isArray(result?.content)
          ? (result.content as Array<{ type?: string; text?: string }>)
              .filter((block) => block.type === 'text')
              .map((block) => block.text ?? '')
              .join('\n')
          : undefined;
    if (text)
      events.push({
        type: 'tool_result',
        data: { toolCallId: id, toolName, result: text, status },
      });
    recordCodexMedia(this.ctx, id, result?.content);
    return events;
  }

  /** `webSearch` → the `WebSearch` tool. */
  webSearch(item: Item, phase: Phase): StreamEvent[] {
    const id = String(item.id);
    const events = this.toolStart(id, WEB_SEARCH_TOOL_NAME, JSON.stringify({ query: item.query }));
    if (phase === 'completed') {
      events.push({
        type: 'tool_call_end',
        data: { toolCallId: id, toolName: WEB_SEARCH_TOOL_NAME, status: 'complete' },
      });
    }
    return events;
  }

  /** `subAgentActivity` → background agent tasks (`taskId` = the agent's thread). */
  subAgentActivity(item: Item, phase: Phase): StreamEvent[] {
    if (phase !== 'completed') return [];
    const taskId = String(item.agentThreadId);
    switch (item.kind) {
      case 'started':
        return [
          {
            type: 'background_task_started',
            data: {
              taskId,
              taskType: 'agent',
              startedAt: Date.now(),
              description: String(item.agentPath ?? ''),
            },
          },
        ];
      case 'completed':
        return [{ type: 'background_task_done', data: { taskId, status: 'completed' } }];
      case 'interrupted':
        return [{ type: 'background_task_done', data: { taskId, status: 'stopped' } }];
      default:
        return [];
    }
  }

  /**
   * The input a tool start in this turn carried, for a card about that tool.
   *
   * @param toolCallId - The item id.
   */
  inputOf(toolCallId: string): string | undefined {
    return this.toolInputs.get(toolCallId);
  }

  /**
   * The most recent MCP tool call of one server still running in this turn.
   *
   * @param server - The MCP server's name.
   */
  runningMcpCall(server: string): { id: string; tool: string } | undefined {
    const running = [...this.runningMcp.entries()].filter(([, call]) => call.server === server);
    const last = running.at(-1);
    return last ? { id: last[0], tool: last[1].tool } : undefined;
  }

  private toolStart(toolCallId: string, toolName: string, input: string): StreamEvent[] {
    if (this.startedTools.has(toolCallId)) return [];
    this.startedTools.add(toolCallId);
    this.toolInputs.set(toolCallId, input);
    return [{ type: 'tool_call_start', data: { toolCallId, toolName, input, status: 'running' } }];
  }
}

type ItemHandler = (this: AppServerTurnMapper, item: Item, phase: Phase) => StreamEvent[];
const none: ItemHandler = () => [];

/**
 * Every item type, and what it means. A `Record` over the full union, so a new
 * item type is a compile error until it is given a meaning.
 *
 * - `userMessage`, `hookPrompt`, `functionCallOutput`, `plan`, `reasoning` (its
 *   text streams as summary deltas), `dynamicToolCall` (DorkOS registers none),
 *   `imageView`, `sleep`, `imageGeneration`, the review-mode markers: nothing
 *   to show beyond what other events already carry.
 * - `collabAgentToolCall`: the spawn call itself; the agent's lifecycle rides
 *   `subAgentActivity`, so showing both would count every sub-agent twice.
 * - `contextCompaction`: `thread/compacted` already marks the boundary.
 */
const ITEM_HANDLERS: Record<ThreadItemType, ItemHandler> = {
  userMessage: none,
  hookPrompt: none,
  agentMessage: AppServerTurnMapper.prototype.agentMessage,
  functionCallOutput: none,
  plan: none,
  reasoning: none,
  commandExecution: AppServerTurnMapper.prototype.commandExecution,
  fileChange: AppServerTurnMapper.prototype.fileChange,
  mcpToolCall: AppServerTurnMapper.prototype.mcpToolCall,
  dynamicToolCall: none,
  collabAgentToolCall: none,
  subAgentActivity: AppServerTurnMapper.prototype.subAgentActivity,
  webSearch: AppServerTurnMapper.prototype.webSearch,
  imageView: none,
  sleep: none,
  imageGeneration: none,
  enteredReviewMode: none,
  exitedReviewMode: none,
  contextCompaction: none,
};
