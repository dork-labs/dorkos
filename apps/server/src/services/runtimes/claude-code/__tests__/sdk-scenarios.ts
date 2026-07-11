import { vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SESSION_ID = 'test-session-id';
const BASE_UUID =
  '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`;

function makeInit(sessionId = SESSION_ID): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'normal',
    skills: [],
    plugins: [],
    cwd: '/mock',
    apiKeySource: 'env',
    uuid: BASE_UUID,
    claude_code_version: '0.0.0',
  } as SDKMessage;
}

function makeResult(sessionId = SESSION_ID): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: BASE_UUID,
  } as SDKMessage;
}

/**
 * Wraps an async generator with the stub methods that the real query() return
 * value exposes. Required because ClaudeCodeRuntime calls supportedModels() and
 * setPermissionMode() on the query result before iterating it.
 *
 * @param gen - The async generator to wrap
 */
export function wrapSdkQuery(gen: AsyncGenerator<SDKMessage>) {
  return Object.assign(gen, {
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedCommands: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    // Query.close() kills the CLI child — the warm probe must call it on teardown.
    close: vi.fn(),
    reloadPlugins: vi.fn().mockResolvedValue({
      commands: [],
      agents: null,
      plugins: [],
      mcpServers: [],
      error_count: 0,
    }),
    getContextUsage: vi.fn().mockResolvedValue({
      totalTokens: 1000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0.5,
      model: 'claude-test',
      categories: [
        { name: 'Messages', tokens: 1000, color: '#4CAF50' },
        { name: 'Free space', tokens: 199000, color: '#eee' },
      ],
      gridRows: [],
      memoryFiles: [],
      mcpTools: [],
    }),
    // Structured /usage control response — an API-key-shaped default (no plan
    // rate limits) so tests exercising subscription usage override explicitly.
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue({
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    }),
  });
}

/**
 * Produces a minimal streaming text response.
 *
 * @param text - The assistant response text to stream
 */
export async function* sdkSimpleText(text: string): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield makeResult();
}

/**
 * Produces a single tool call (start → json delta → stop) followed by text.
 *
 * @param toolName - Tool to simulate (e.g. 'Bash', 'Read')
 * @param input - Tool input object (yielded as partial JSON chunks)
 * @param responseText - Assistant text after the tool call
 */
export async function* sdkToolCall(
  toolName: string,
  input: object,
  responseText: string
): AsyncGenerator<SDKMessage> {
  const toolCallId = 'tool-call-1';
  yield makeInit();
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: responseText },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield makeResult();
}

/**
 * Produces a context-window compaction sequence: an in-flight `status:
 * 'compacting'`, the `compact_boundary` marker, then the resolving status
 * carrying `compact_result: 'success'`. Drives the `operation_progress`
 * started→done contract (DOR-110) end-to-end through the runtime.
 */
export async function* sdkCompaction(): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 120000, post_tokens: 24000, duration_ms: 900 },
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'system',
    subtype: 'status',
    status: 'idle',
    compact_result: 'success',
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield makeResult();
}

/**
 * Produces a TodoWrite tool call followed by a tool_use_summary.
 *
 * @param tasks - Task items to create (id, content, status)
 */
export async function* sdkTodoWrite(
  tasks: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>
): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'todo-write-1', name: 'TodoWrite', input: {} },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ todos: tasks }) },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
  yield {
    type: 'tool_use_summary',
    summary: `Created ${tasks.length} task(s)`,
    preceding_tool_use_ids: ['todo-write-1'],
    uuid: BASE_UUID,
    session_id: SESSION_ID,
  } as SDKMessage;
  yield makeResult();
}

/**
 * Produces a full MCP tool call sequence: content_block_start → optional
 * input_json_delta → content_block_stop → assistant message → user message
 * with tool_result. Unlike built-in tools, MCP tools do NOT emit
 * tool_use_summary.
 *
 * @param toolName - MCP tool name (e.g., 'mcp__dorkos__mesh_list')
 * @param toolId - Unique tool use ID
 * @param input - Tool input object (empty `{}` to test the empty-input case)
 * @param resultContent - Tool result text content
 */
export async function* sdkMcpToolCall(
  toolName: string,
  toolId: string,
  input: object,
  resultContent: string
): AsyncGenerator<SDKMessage> {
  yield makeInit();

  // content_block_start — tool_use
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;

  // input_json_delta — only if input is non-empty
  const hasInput = Object.keys(input).length > 0;
  if (hasInput) {
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: BASE_UUID,
    } as SDKMessage;
  }

  // content_block_stop
  yield {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;

  // assistant message — contains the full tool_use block with resolved input
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input,
        },
      ],
    },
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;

  // user message — contains tool_result blocks (MCP results arrive here)
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: [
            {
              type: 'text',
              text: resultContent,
            },
          ],
        },
      ],
    },
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;

  yield makeResult();
}

/**
 * Produces a user message with `isReplay: true` for testing the replay guard.
 *
 * @param toolId - Tool use ID to reference in the tool_result block
 * @param resultContent - Tool result text
 */
export function sdkReplayUserMessage(toolId: string, resultContent: string): SDKMessage {
  return {
    type: 'user',
    isReplay: true,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: [
            {
              type: 'text',
              text: resultContent,
            },
          ],
        },
      ],
    },
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
}

/**
 * Produces an error result (subtype: 'error_during_execution') from the SDK.
 *
 * @param message - Error message text
 */
export async function* sdkError(message: string): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 50,
    duration_api_ms: 40,
    is_error: true,
    num_turns: 1,
    result: message,
    stop_reason: 'error',
    total_cost_usd: 0,
    usage: {
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
}

// === Subagent Lifecycle Scenario Builders ===

const SUBAGENT_UUID =
  '00000000-0000-4000-8000-000000000099' as `${string}-${string}-${string}-${string}-${string}`;

/**
 * Yield a task_started system message for subagent lifecycle testing.
 *
 * @param taskId - Background task id
 * @param description - Human-readable task description
 * @param toolUseId - Optional Task tool_use id, used to correlate forwarded
 *   subagent text (`sdkSubagentText`) back to this task
 */
export function sdkTaskStarted(
  taskId: string,
  description: string,
  toolUseId?: string
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    description,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    session_id: `subagent-${taskId}`,
    uuid: SUBAGENT_UUID,
  } as SDKMessage;
}

/**
 * Yield a forwarded subagent text message (SDK `forwardSubagentText`). The SDK
 * forwards a subagent's text as a complete `assistant` message tagged with
 * `parent_tool_use_id` (NOT as stream-event deltas), which correlates it to the
 * spawning Task tool call.
 *
 * @param parentToolUseId - tool_use id of the Task tool that spawned the subagent
 * @param text - Forwarded subagent text
 */
export function sdkSubagentText(parentToolUseId: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: parentToolUseId,
    subagent_type: 'general-purpose',
    session_id: `subagent-${parentToolUseId}`,
    uuid: SUBAGENT_UUID,
  } as unknown as SDKMessage;
}

/**
 * Yield a forwarded subagent *stream event* (SDK `forwardSubagentText`). The SDK
 * does not deliver subagent text this way, but defensive handling must drop any
 * such event without corrupting the main-thread `toolState`. Defaults to a
 * `tool_use` content_block_start — the shape most likely to corrupt tool state.
 *
 * @param parentToolUseId - tool_use id of the Task tool that spawned the subagent
 */
export function sdkSubagentStreamEvent(parentToolUseId: string): SDKMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'subagent-tool-1', name: 'Read', input: {} },
    },
    parent_tool_use_id: parentToolUseId,
    session_id: `subagent-${parentToolUseId}`,
    uuid: SUBAGENT_UUID,
  } as unknown as SDKMessage;
}

/** Yield a task_progress system message for subagent lifecycle testing. */
export function sdkTaskProgress(
  taskId: string,
  toolUses: number,
  durationMs: number,
  lastToolName?: string
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    description: 'test task',
    usage: { total_tokens: 1000, tool_uses: toolUses, duration_ms: durationMs },
    last_tool_name: lastToolName,
    session_id: `subagent-${taskId}`,
    uuid: SUBAGENT_UUID,
  } as SDKMessage;
}

/** Yield a task_notification system message for subagent lifecycle testing. */
export function sdkTaskNotification(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    output_file: '/tmp/output.txt',
    summary,
    usage: { total_tokens: 2000, tool_uses: 5, duration_ms: 3000 },
    session_id: `subagent-${taskId}`,
    uuid: SUBAGENT_UUID,
  } as SDKMessage;
}
