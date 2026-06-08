import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolState } from '../../agent-types.js';
import { buildTaskEvent, buildTodoWriteEvent, TASK_TOOL_NAMES } from '../build-task-event.js';

/**
 * Map a `stream_event` (partial-assistant) SDK message to zero or more StreamEvents.
 *
 * Handles the live content stream: thinking/text/tool-input deltas, message-level
 * deltas (output tokens, max-tokens truncation, refusals), and content-block stops
 * (tool-call completion plus Task/TodoWrite `task_update` synthesis). Drops forwarded
 * subagent stream events (those carry `parent_tool_use_id`). Mutates `toolState` to
 * track the in-flight tool/thinking block.
 *
 * @param message - The `stream_event` SDK message to map.
 * @param sessionId - DorkOS session identifier (stamped onto output-token session_status).
 * @param toolState - Mutable tool tracking state (read and written).
 */
export async function* mapStreamEvent(
  message: SDKMessage,
  sessionId: string,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  const event = (message as unknown as { event: Record<string, unknown> }).event;

  // Guard against forwarded subagent stream events (SDK `forwardSubagentText`,
  // 0.2.119+). When `parent_tool_use_id` is set, this stream_event originates from
  // a subagent, not the main thread, so drop it: letting it fall through would let a
  // subagent's tool_use / thinking blocks corrupt the shared `toolState` and leak its
  // text into the primary assistant stream. Subagent *text* is not delivered as
  // stream-event deltas — the SDK forwards it as complete `assistant` messages
  // (handled in the assistant branch), so there is nothing to emit here.
  const streamParentToolUseId = (message as unknown as { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (streamParentToolUseId) return;

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
    } else if (stopReason === 'refusal') {
      // SDK 0.3.162+: the model declined to respond. `stop_details` is passed
      // through untyped, so read a human-readable hint defensively when present.
      const stopDetails = delta?.stop_details as Record<string, unknown> | undefined;
      const hint =
        typeof stopDetails?.message === 'string'
          ? stopDetails.message
          : typeof stopDetails?.reason === 'string'
            ? stopDetails.reason
            : undefined;
      yield {
        type: 'system_status',
        data: {
          message: hint
            ? `The model declined to respond: ${hint}`
            : 'The model declined to respond to this request.',
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
}
