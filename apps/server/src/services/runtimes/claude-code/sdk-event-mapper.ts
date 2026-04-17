import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  StreamEvent,
  ErrorCategory,
  TerminalReason,
  MemoryRecallEvent,
} from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { buildTaskEvent, buildTodoWriteEvent, TASK_TOOL_NAMES } from './build-task-event.js';
import { logger } from '../../../lib/logger.js';

/** Extract text from a tool_result content field (file-local, loosely-typed for SDK messages). */
function extractToolResultText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('\n');
}

/** Hook events that correlate to a specific tool call and render inside ToolCallCard. */
const TOOL_CONTEXTUAL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/** Map SDK result subtypes to user-facing error categories. */
function mapErrorCategory(subtype: string): ErrorCategory {
  switch (subtype) {
    case 'error_max_turns':
      return 'max_turns';
    case 'error_during_execution':
      return 'execution_error';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    case 'error_max_structured_output_retries':
      return 'output_format_error';
    default:
      return 'execution_error';
  }
}

/**
 * Map a single SDK message to zero or more DorkOS StreamEvent objects.
 *
 * Pure async generator — no I/O, no SDK iterator interaction, no session Map access.
 * ToolState is passed by reference (mutable struct owned by the caller's streaming loop).
 */
export async function* mapSdkMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  // Handle system/init messages
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

  // Handle background task lifecycle messages (task_started, task_progress, task_notification)
  if (message.type === 'system' && 'subtype' in message) {
    if (message.subtype === 'task_started') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'background_task_started',
        data: {
          taskId: msg.task_id as string,
          taskType: message.session_id ? ('agent' as const) : ('bash' as const),
          startedAt: Date.now(),
          subagentSessionId: message.session_id,
          command: message.session_id ? undefined : (msg.command as string | undefined),
          toolUseId: msg.tool_use_id as string | undefined,
          description: msg.description as string,
        },
      };
      return;
    }

    if (message.subtype === 'task_progress') {
      const msg = message as Record<string, unknown>;
      const usage = msg.usage as { tool_uses: number; duration_ms: number };
      yield {
        type: 'background_task_progress',
        data: {
          taskId: msg.task_id as string,
          toolUses: usage.tool_uses,
          lastToolName: msg.last_tool_name as string | undefined,
          durationMs: usage.duration_ms,
          summary: msg.summary as string | undefined,
        },
      };
      return;
    }

    if (message.subtype === 'task_notification') {
      const msg = message as Record<string, unknown>;
      const usage = msg.usage as { tool_uses: number; duration_ms: number } | undefined;
      yield {
        type: 'background_task_done',
        data: {
          taskId: msg.task_id as string,
          status: msg.status as 'completed' | 'failed' | 'stopped',
          summary: msg.summary as string | undefined,
          toolUses: usage?.tool_uses,
          durationMs: usage?.duration_ms,
        },
      };
      return;
    }

    // Handle system status messages ("Compacting context...", permission mode changes, 'requesting')
    if (message.subtype === 'status') {
      const msg = message as Record<string, unknown>;
      const status = msg.status as string | undefined;
      const text = (msg.body as string) ?? (msg.message as string) ?? '';
      if (text || status) {
        yield {
          type: 'system_status',
          data: {
            message: text || (status ? `Status: ${status}` : ''),
            ...(status ? { status } : {}),
          },
        };
      }
      return;
    }

    // Handle memory recall events (SDK 0.2.105+)
    if (message.subtype === 'memory_recall') {
      const msg = message as Record<string, unknown>;
      const mode = msg.mode as MemoryRecallEvent['mode'];
      const memories = (msg.memories as MemoryRecallEvent['memories'] | undefined) ?? [];
      const paths = memories.map((m) => m.path).filter((p): p is string => Boolean(p));
      if (paths.length > 0) {
        session.memoryPaths = Array.from(new Set([...(session.memoryPaths ?? []), ...paths]));
      }
      yield {
        type: 'memory_recall',
        data: { mode, memories },
      };
      return;
    }

    // Handle compact boundary (context window compaction occurred)
    if (message.subtype === 'compact_boundary') {
      yield {
        type: 'compact_boundary',
        data: {},
      };
      return;
    }

    // Handle SDK session state changes (idle/running/requires_action)
    if (message.subtype === 'session_state_changed') {
      const msg = message as Record<string, unknown>;
      const state = msg.state as 'idle' | 'running' | 'requires_action';
      yield {
        type: 'session_state_changed' as const,
        data: { state },
      };
      return;
    }

    // Handle MCP elicitation completion (URL-mode auth confirmed by MCP server)
    if (message.subtype === 'elicitation_complete') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'elicitation_complete',
        data: {
          serverName: msg.mcp_server_name as string,
          elicitationId: msg.elicitation_id as string,
        },
      };
      return;
    }

    // Handle API retry events (SDK 0.2.77+)
    if (message.subtype === 'api_retry') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'api_retry',
        data: {
          attempt: msg.attempt as number,
          maxRetries: msg.max_retries as number,
          retryDelayMs: msg.retry_delay_ms as number,
          errorStatus: (msg.error_status as number) ?? null,
        },
      };
      return;
    }

    // Handle hook lifecycle events
    if (message.subtype === 'hook_started') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_started',
          data: {
            hookId: msg.hook_id as string,
            hookName: msg.hook_name as string,
            hookEvent,
            toolCallId: toolState.currentToolId || null,
          },
        };
      } else {
        yield {
          type: 'system_status',
          data: { message: `Running hook "${msg.hook_name as string}"...` },
        };
      }
      return;
    }

    if (message.subtype === 'hook_progress') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_progress',
          data: {
            hookId: msg.hook_id as string,
            stdout: msg.stdout as string,
            stderr: msg.stderr as string,
          },
        };
      }
      // Session-level progress: silent (no useful output to show mid-execution)
      return;
    }

    if (message.subtype === 'hook_response') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_response',
          data: {
            hookId: msg.hook_id as string,
            hookName: msg.hook_name as string,
            exitCode: msg.exit_code as number | undefined,
            outcome: msg.outcome as 'success' | 'error' | 'cancelled',
            stdout: msg.stdout as string,
            stderr: msg.stderr as string,
          },
        };
      } else if ((msg.outcome as string) === 'error') {
        // Session-level failure: escalate to persistent error
        yield {
          type: 'error',
          data: {
            message: `Hook "${msg.hook_name as string}" failed (${hookEvent})`,
            code: 'hook_failure',
            category: 'execution_error',
            details: (msg.stderr as string) || (msg.stdout as string),
          },
        };
      }
      // Session-level success: silent (already shown via system_status on start)
      return;
    }
  }

  // Handle stream events (content blocks)
  if (message.type === 'stream_event') {
    const event = (message as unknown as { event: Record<string, unknown> }).event;
    const eventType = event.type as string;

    if (eventType === 'content_block_start') {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === 'thinking') {
        toolState.inThinking = true;
        toolState.thinkingStartMs = Date.now();
      } else if (contentBlock?.type === 'tool_use') {
        toolState.resetTaskInput();
        toolState.setToolState(true, contentBlock.name as string, contentBlock.id as string);
        toolState.toolNameById.set(contentBlock.id as string, contentBlock.name as string);
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
      if (delta?.type === 'thinking_delta' && toolState.inThinking) {
        yield { type: 'thinking_delta', data: { text: delta.thinking as string } };
      } else if (delta?.type === 'text_delta' && !toolState.inTool) {
        yield { type: 'text_delta', data: { text: delta.text as string } };
      } else if (delta?.type === 'input_json_delta' && toolState.inTool) {
        toolState.toolInputReceived.add(toolState.currentToolId);
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
    } else if (eventType === 'message_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      const usage = event.usage as Record<string, unknown> | undefined;
      const stopReason = delta?.stop_reason as string | undefined;
      const outputTokens = usage?.output_tokens as number | undefined;

      if (outputTokens !== undefined) {
        yield {
          type: 'session_status',
          data: { sessionId, outputTokens },
        };
      }

      if (stopReason === 'max_tokens') {
        yield {
          type: 'system_status',
          data: { message: 'Response truncated — reached max output tokens.' },
        };
      }
    } else if (eventType === 'content_block_stop') {
      if (toolState.inThinking) {
        toolState.inThinking = false;
      } else if (toolState.inTool) {
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
            const taskEvent =
              taskToolName === 'TodoWrite'
                ? buildTodoWriteEvent(input)
                : buildTaskEvent(taskToolName, input);
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

  // Backfill tool input from completed assistant message (for MCP tools with empty input)
  if (message.type === 'assistant') {
    const content = (message as Record<string, unknown>).message;
    const contentBlocks = (content as Record<string, unknown>)?.content;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks as Array<Record<string, unknown>>) {
        if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          !toolState.toolInputReceived.has(block.id) &&
          toolState.toolNameById.has(block.id)
        ) {
          const inputStr = JSON.stringify(block.input ?? {});
          yield {
            type: 'tool_call_delta',
            data: {
              toolCallId: block.id,
              toolName: toolState.toolNameById.get(block.id) ?? '',
              input: inputStr,
              status: 'running',
            },
          };
        }
      }
    }
    return;
  }

  // Extract tool results from user messages (MCP tools deliver results here, not via tool_use_summary)
  if (message.type === 'user') {
    // Skip replay messages during session resume
    if ((message as Record<string, unknown>).isReplay) return;

    const content = (message as Record<string, unknown>).message;
    const contentBlocks = (content as Record<string, unknown>)?.content;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          // Skip tools already resolved via tool_use_summary (built-in tools)
          if (toolState.resolvedResultIds.has(block.tool_use_id)) continue;

          const resultText = extractToolResultText(block.content);
          if (resultText) {
            yield {
              type: 'tool_result',
              data: {
                toolCallId: block.tool_use_id,
                toolName: toolState.toolNameById.get(block.tool_use_id) ?? '',
                result: resultText,
                status: 'complete',
              },
            };
          }
        }
      }
    }
    return;
  }

  // Handle tool use summaries
  if (message.type === 'tool_use_summary') {
    const summary = message as { summary: string; preceding_tool_use_ids: string[] };
    for (const toolUseId of summary.preceding_tool_use_ids) {
      toolState.resolvedResultIds.add(toolUseId);
      yield {
        type: 'tool_result',
        data: {
          toolCallId: toolUseId,
          toolName: toolState.toolNameById.get(toolUseId) ?? '',
          result: summary.summary,
          status: 'complete',
        },
      };
    }
    return;
  }

  // Handle tool progress (intermediate output from long-running tools)
  if (message.type === 'tool_progress') {
    const progress = message as unknown as { tool_use_id: string; content: string };
    yield {
      type: 'tool_progress',
      data: {
        toolCallId: progress.tool_use_id,
        content: progress.content,
      },
    };
    return;
  }

  // Handle prompt suggestion messages (SDK 0.2.86: singular `suggestion` field)
  if (message.type === 'prompt_suggestion') {
    const suggestion = (message as Record<string, unknown>).suggestion as string;
    if (suggestion) {
      yield {
        type: 'prompt_suggestion',
        data: { suggestions: [suggestion] },
      };
    }
    return;
  }

  // Handle rate limit events (includes subscription utilization data)
  if (message.type === 'rate_limit_event') {
    const msg = message as Record<string, unknown>;
    const retryAfter = msg.retry_after as number | undefined;
    yield {
      type: 'rate_limit',
      data: { retryAfter },
    };

    // Extract subscription utilization from rate_limit_info if present
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (info) {
      const resetsAtRaw = info.resetsAt as number | undefined;
      const status = (info.status as 'allowed' | 'allowed_warning' | 'rejected') ?? 'allowed';
      yield {
        type: 'usage_info' as const,
        data: {
          status,
          utilization: info.utilization as number | undefined,
          resetsAt: resetsAtRaw ? new Date(resetsAtRaw * 1000).toISOString() : undefined,
          rateLimitType: info.rateLimitType as string | undefined,
          isUsingOverage: info.isUsingOverage as boolean | undefined,
        },
      };
    }
    return;
  }

  // Handle result messages
  if (message.type === 'result') {
    const result = message as Record<string, unknown>;
    const usage = result.usage as Record<string, unknown> | undefined;
    const modelUsageMap = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;
    const terminalReason = result.terminal_reason as TerminalReason | undefined;

    // Always emit session_status with final cost/token/model data + cache metrics
    yield {
      type: 'session_status',
      data: {
        sessionId,
        model: result.model as string | undefined,
        costUsd: result.total_cost_usd as number | undefined,
        contextTokens: usage?.input_tokens as number | undefined,
        contextMaxTokens: firstModelUsage?.contextWindow as number | undefined,
        cacheReadTokens: firstModelUsage?.cacheReadInputTokens as number | undefined,
        cacheCreationTokens: firstModelUsage?.cacheCreationInputTokens as number | undefined,
        ...(terminalReason ? { terminalReason } : {}),
      },
    };

    // Emit error event if the result is an error subtype
    const subtype = result.subtype as string | undefined;
    if (subtype && subtype !== 'success') {
      const errors = result.errors as string[] | undefined;
      const category = mapErrorCategory(subtype);
      yield {
        type: 'error',
        data: {
          message: errors?.[0] ?? 'An unexpected error occurred.',
          code: subtype,
          category,
          details: errors?.join('\n'),
        },
      };
    }

    // Always emit done to trigger client cleanup
    yield {
      type: 'done',
      data: { sessionId },
    };
    return;
  }

  // Catch-all: log unhandled message types for debugging
  logger.debug(
    'Unhandled SDK message type: %s (subtype: %s)',
    message.type,
    'subtype' in message ? (message as Record<string, unknown>).subtype : 'none'
  );
}
