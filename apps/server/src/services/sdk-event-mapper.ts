import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { buildTaskEvent, TASK_TOOL_NAMES } from './build-task-event.js';

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

  // Handle stream events (content blocks)
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

  // Handle result messages
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
