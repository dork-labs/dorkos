import { vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SESSION_ID = 'test-session-id';
const BASE_UUID = '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`;

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
  responseText: string,
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
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: responseText } },
    parent_tool_use_id: null,
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
  tasks: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>,
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
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  } as SDKMessage;
}
