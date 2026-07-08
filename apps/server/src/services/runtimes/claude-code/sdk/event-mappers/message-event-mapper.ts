import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from '../../agent-types.js';
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
 * The two tool-result serialization markers the Claude Agent SDK emits when it
 * flattens structured MCP resource content to text (verified empirically —
 * spec `mcp-apps-host` §0):
 *
 * - EmbeddedResource → `[Resource from <server> at <ui://…>] <body>`
 * - ResourceLink     → `[Resource link: <name>] <ui://…>`
 *
 * Extraction is anchored on these markers ONLY — a bare `ui://` substring
 * elsewhere in tool output (JSON payloads, docs text, prompt-injected content
 * the agent fetched) must NOT trigger the app renderer. Downstream gates
 * (scheme/membership/mime/consent) would still hold, but an unanchored match
 * would hand attacker-influenced text a consent card and a server-side
 * resources/read probe.
 */
const UI_RESOURCE_MARKERS = [
  /\[Resource from [^\]]+ at (ui:\/\/[^\s\]"'<>]+)\]/i,
  /\[Resource link:[^\]]*\]\s*(ui:\/\/[^\s\]"'<>]+)/i,
];

/**
 * Detect an MCP App (SEP-1865) `ui://` resource referenced by a tool result.
 *
 * This is the text-parse **fallback** trigger (spec `mcp-apps-host` §0/§2.2):
 * the Claude Agent SDK strips `_meta` and flattens structured resource /
 * resource_link blocks to plain text, so the only surviving signal is the
 * `ui://` URI inside one of the SDK's serialization markers
 * ({@link UI_RESOURCE_MARKERS}). There is deliberately no bare-token fallback.
 * The URI drives the server-side resource fetch; the flattened HTML is not
 * trusted as a render source (it is prefix-wrapped and carries no
 * mime/CSP/permission metadata).
 *
 * @param text - Concatenated tool-result text.
 * @returns The first marker-anchored `ui://` URI, or undefined.
 */
function extractUiResourceUri(text: string): string | undefined {
  for (const marker of UI_RESOURCE_MARKERS) {
    const match = text.match(marker);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Map `assistant`, `user`, `tool_use_summary`, and `tool_progress` SDK messages to
 * zero or more StreamEvents.
 *
 * These carry tool-call backfill, tool results, forwarded subagent text, and tool
 * progress output. Reads and writes `toolState` for tool-id/result correlation.
 *
 * @param message - The SDK message to map (assistant/user/tool_use_summary/tool_progress).
 * @param session - In-memory session state (its `lastRequestUsage` is updated from
 *   main-thread assistant messages so the runtime can report current context usage).
 * @param toolState - Mutable tool tracking state (read and written).
 */
export async function* mapMessageEvent(
  message: SDKMessage,
  session: AgentSession,
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

    // Capture this main-thread request's input-side usage. Each completed
    // assistant message carries the per-request usage; the last one before the
    // result reflects the current context-window occupancy. (The result message's
    // modelUsage sums every request in the turn and would over-count.)
    const assistantBody = (message as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    const usage = assistantBody?.usage as Record<string, unknown> | undefined;
    if (usage) {
      session.lastRequestUsage = {
        inputTokens: (usage.input_tokens as number | undefined) ?? 0,
        cacheReadTokens: (usage.cache_read_input_tokens as number | undefined) ?? 0,
        cacheCreationTokens: (usage.cache_creation_input_tokens as number | undefined) ?? 0,
      };
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
            const uiResourceUri = extractUiResourceUri(resultText);
            yield {
              type: 'tool_result',
              data: {
                toolCallId: block.tool_use_id,
                toolName: toolState.toolNameById.get(block.tool_use_id) ?? '',
                result: resultText,
                status: 'complete',
                // MCP App (SEP-1865): populate `ui` when the result references a
                // ui:// resource so the client can render the app (spec §2.2).
                ...(uiResourceUri ? { ui: { resourceUri: uiResourceUri } } : {}),
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
