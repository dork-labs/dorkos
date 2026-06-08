import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolState } from '../agent-types.js';
import { describeAssistantError, SURFACED_ASSISTANT_ERRORS } from '../sdk-error-mapping.js';

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

/**
 * Map `assistant`, `user`, `tool_use_summary`, and `tool_progress` SDK messages to
 * zero or more StreamEvents.
 *
 * These carry tool-call backfill, tool results, forwarded subagent text, and tool
 * progress output. Reads and writes `toolState` for tool-id/result correlation.
 *
 * @param message - The SDK message to map (assistant/user/tool_use_summary/tool_progress).
 * @param toolState - Mutable tool tracking state (read and written).
 */
export async function* mapMessageEvent(
  message: SDKMessage,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  // Backfill tool input from completed assistant message (for MCP tools with empty input)
  if (message.type === 'assistant') {
    // Forwarded subagent assistant messages (SDK `forwardSubagentText`). The SDK
    // forwards a subagent's text as complete `assistant` messages tagged with
    // `parent_tool_use_id` — NOT as stream-event deltas — so this is where subagent
    // text actually arrives. Emit each text block as `subagent_text_delta`, correlated
    // to the spawning Task tool call, then return without touching main-thread tool or
    // error state. Non-text blocks (tool_use / thinking) are dropped — v1 is text only.
    const subagentParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (subagentParentToolUseId) {
      const subagentContent = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(subagentContent)) {
        for (const block of subagentContent as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            yield {
              type: 'subagent_text_delta',
              data: { parentToolUseId: subagentParentToolUseId, text: block.text },
            };
          }
        }
      }
      return;
    }

    // SDK 0.3.144+: assistant messages can carry a terminal `error` (e.g. the
    // selected model is unavailable). Surface the ones not already reported via
    // the retry / rate-limit / max-tokens channels as a clear error event.
    const assistantError = (message as Record<string, unknown>).error as string | undefined;
    if (assistantError && SURFACED_ASSISTANT_ERRORS.has(assistantError)) {
      yield {
        type: 'error',
        data: {
          message: describeAssistantError(assistantError),
          code: assistantError,
          category: 'execution_error',
        },
      };
    }

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
    // Skip forwarded subagent user messages (parent_tool_use_id set) — their tool
    // results belong to the subagent's own transcript, not the main thread.
    if ((message as Record<string, unknown>).parent_tool_use_id) return;

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
}
