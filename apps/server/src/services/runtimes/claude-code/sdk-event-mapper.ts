import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, ErrorCategory } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { buildTaskEvent, TASK_TOOL_NAMES } from './build-task-event.js';

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

  // Handle subagent lifecycle messages (task_started, task_progress, task_notification)
  if (message.type === 'system' && 'subtype' in message) {
    if (message.subtype === 'task_started') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'subagent_started',
        data: {
          taskId: msg.task_id as string,
          subagentSessionId: message.session_id,
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
        type: 'subagent_progress',
        data: {
          taskId: msg.task_id as string,
          toolUses: usage.tool_uses,
          lastToolName: msg.last_tool_name as string | undefined,
          durationMs: usage.duration_ms,
        },
      };
      return;
    }

    if (message.subtype === 'task_notification') {
      const msg = message as Record<string, unknown>;
      const usage = msg.usage as { tool_uses: number; duration_ms: number } | undefined;
      yield {
        type: 'subagent_done',
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

    // Handle system status messages ("Compacting context...", permission mode changes)
    if (message.subtype === 'status') {
      const msg = message as Record<string, unknown>;
      const text = (msg.body as string) ?? (msg.message as string) ?? '';
      if (text) {
        yield {
          type: 'system_status',
          data: { message: text },
        };
      }
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
  }

  // Handle stream events (content blocks)
  if (message.type === 'stream_event') {
    const event = (message as { event: Record<string, unknown> }).event;
    const eventType = event.type as string;

    if (eventType === 'content_block_start') {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === 'thinking') {
        toolState.inThinking = true;
        toolState.thinkingStartMs = Date.now();
      } else if (contentBlock?.type === 'tool_use') {
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
      if (delta?.type === 'thinking_delta' && toolState.inThinking) {
        yield { type: 'thinking_delta', data: { text: delta.thinking as string } };
      } else if (delta?.type === 'text_delta' && !toolState.inTool) {
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

  // Handle tool use summaries
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

  // Handle tool progress (intermediate output from long-running tools)
  if (message.type === 'tool_progress') {
    const progress = message as { tool_use_id: string; content: string };
    yield {
      type: 'tool_progress',
      data: {
        toolCallId: progress.tool_use_id,
        content: progress.content,
      },
    };
    return;
  }

  // Handle rate limit events
  if (message.type === 'rate_limit_event') {
    const retryAfter = (message as Record<string, unknown>).retry_after as number | undefined;
    yield {
      type: 'rate_limit',
      data: { retryAfter },
    };
    return;
  }

  // Handle result messages
  if (message.type === 'result') {
    const result = message as Record<string, unknown>;
    const usage = result.usage as Record<string, unknown> | undefined;
    const modelUsageMap = result.modelUsage as
      | Record<string, Record<string, unknown>>
      | undefined;
    const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;

    // Always emit session_status with final cost/token/model data
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
  }
}
