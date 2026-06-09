import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import { logger } from '../../../../lib/logger.js';
import {
  sdkTaskStarted,
  sdkTaskProgress,
  sdkTaskNotification,
  sdkSubagentText,
  sdkSubagentStreamEvent,
} from './sdk-scenarios.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type {
  StreamEvent,
  ErrorEvent,
  ApiRetryEvent,
  PromptSuggestionEvent,
  HookStartedEvent,
  HookProgressEvent,
  HookResponseEvent,
  PermissionDeniedEvent,
} from '@dorkos/shared/types';

/** Collect all events yielded by the mapper for a single message. */
async function collectEvents(...args: Parameters<typeof mapSdkMessage>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of mapSdkMessage(...args)) {
    events.push(event);
  }
  return events;
}

function makeSession(): AgentSession {
  return {
    sdkSessionId: null,
    hasStarted: false,
  } as AgentSession;
}

function makeToolState(): ToolState {
  return {
    inTool: false,
    currentToolName: '',
    currentToolId: '',
    taskToolInput: '',
    toolNameById: new Map(),
    setToolState(inTool: boolean, name: string, id: string) {
      this.inTool = inTool;
      this.currentToolName = name;
      this.currentToolId = id;
    },
    resetTaskInput() {
      this.taskToolInput = '';
    },
    appendTaskInput(chunk: string) {
      this.taskToolInput += chunk;
    },
  } as ToolState;
}

describe('sdk-event-mapper background task lifecycle', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps task_started to background_task_started', async () => {
    const msg = sdkTaskStarted('task-1', 'Explore codebase');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_started');
    expect(events[0].data).toMatchObject({
      taskId: 'task-1',
      taskType: 'agent',
      subagentSessionId: 'subagent-task-1',
      toolUseId: undefined,
      description: 'Explore codebase',
    });
    expect((events[0].data as Record<string, unknown>).startedAt).toEqual(expect.any(Number));
  });

  it('maps task_progress to background_task_progress', async () => {
    const msg = sdkTaskProgress('task-1', 3, 5000, 'Read');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_progress');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      toolUses: 3,
      lastToolName: 'Read',
      durationMs: 5000,
    });
  });

  it('maps task_progress without lastToolName', async () => {
    const msg = sdkTaskProgress('task-1', 1, 1000);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      toolUses: 1,
      lastToolName: undefined,
      durationMs: 1000,
    });
  });

  it('maps task_notification (completed) to background_task_done', async () => {
    const msg = sdkTaskNotification('task-1', 'completed', 'Found 7 files');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_done');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      status: 'completed',
      summary: 'Found 7 files',
      toolUses: 5,
      durationMs: 3000,
    });
  });

  it('maps task_notification (failed) to background_task_done', async () => {
    const msg = sdkTaskNotification('task-1', 'failed', 'Error occurred');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_done');
    expect(events[0].data).toMatchObject({
      taskId: 'task-1',
      status: 'failed',
      summary: 'Error occurred',
    });
  });

  it('yields nothing for unknown system subtypes', async () => {
    const msg = {
      type: 'system',
      subtype: 'unknown_future_subtype',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('swallows thinking_tokens (estimated-token progress) without yielding', async () => {
    // Purpose: thinking_tokens streams during omitted/redacted thinking. We render
    // thinking from thinking_delta text instead, so it must be handled explicitly —
    // not fall through to the catch-all "Unhandled SDK message type" log.
    const msg = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 128,
      estimated_tokens_delta: 16,
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000002',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('yields system_status event with message text from body field', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
      body: 'Compacting context...',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect(events[0].data).toEqual({ message: 'Compacting context...' });
  });

  it('yields system_status event with message text from message field', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
      message: 'Permission mode changed',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect(events[0].data).toEqual({ message: 'Permission mode changed' });
  });

  it('yields nothing for status messages with no text', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('yields compact_boundary event', async () => {
    const msg = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('compact_boundary');
    expect(events[0].data).toEqual({});
  });

  it('yields elicitation_complete event', async () => {
    const msg = {
      type: 'system',
      subtype: 'elicitation_complete',
      mcp_server_name: 'github-oauth',
      elicitation_id: 'elicit-456',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('elicitation_complete');
    expect(events[0].data).toEqual({
      serverName: 'github-oauth',
      elicitationId: 'elicit-456',
    });
  });
});

describe('sdk-event-mapper forwarded subagent text (SDK forwardSubagentText)', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const SUBAGENT_UUID = '00000000-0000-4000-8000-000000000099';

  it('maps a forwarded subagent assistant text block to subagent_text_delta', async () => {
    const toolState = makeToolState();
    // The SDK forwards subagent text as a complete `assistant` message tagged
    // with parent_tool_use_id — not as stream-event deltas.
    const msg = sdkSubagentText('toolu_parent_1', 'Exploring the auth module');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_text_delta');
    expect(events[0].data).toEqual({
      parentToolUseId: 'toolu_parent_1',
      text: 'Exploring the auth module',
    });
  });

  it('emits one subagent_text_delta per text block in a forwarded assistant message', async () => {
    const toolState = makeToolState();
    const msg = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent_1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First paragraph. ' },
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: 'Second paragraph.' },
        ],
      },
      session_id: 'subagent-x',
      uuid: SUBAGENT_UUID,
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    // Two text blocks → two deltas; the thinking block is dropped (v1 is text only).
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.data as { text: string }).text)).toEqual([
      'First paragraph. ',
      'Second paragraph.',
    ]);
    expect(events.every((e) => e.type === 'subagent_text_delta')).toBe(true);
  });

  it('does NOT leak forwarded subagent text into the main text_delta stream', async () => {
    const toolState = makeToolState();
    const msg = sdkSubagentText('toolu_parent_1', 'subagent output');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('drops forwarded subagent stream events without corrupting main-thread toolState', async () => {
    const toolState = makeToolState();
    // A subagent starting its own tool call (forwarded as a stream_event) must not
    // flip main-thread tool state or emit a spurious tool_call_start.
    const msg = sdkSubagentStreamEvent('toolu_parent_1');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
    expect(toolState.inTool).toBe(false);
    expect(toolState.currentToolId).toBe('');
  });

  it('drops forwarded subagent user messages (subagent input, not output)', async () => {
    const toolState = makeToolState();
    const msg = {
      type: 'user',
      parent_tool_use_id: 'toolu_parent_1',
      message: { role: 'user', content: [{ type: 'text', text: 'the task prompt' }] },
      session_id: 'subagent-x',
      uuid: SUBAGENT_UUID,
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('carries toolUseId on background_task_started for correlation', async () => {
    const toolState = makeToolState();
    const msg = sdkTaskStarted('task-9', 'Run analysis', 'toolu_parent_1');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_started');
    expect(events[0].data).toMatchObject({
      taskId: 'task-9',
      toolUseId: 'toolu_parent_1',
    });
  });
});

describe('sdk-event-mapper result messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  function makeResultMessage(
    subtype: string,
    errors?: string[]
  ): Parameters<typeof mapSdkMessage>[0] {
    return {
      type: 'result',
      subtype,
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: { 'claude-sonnet-4-20250514': { contextWindow: 200000 } },
      ...(errors ? { errors } : {}),
    } as unknown as Parameters<typeof mapSdkMessage>[0];
  }

  it('success result yields session_status + context_usage + done (3 events)', async () => {
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('context_usage');
    expect(events[2].type).toBe('done');
    expect(events[2].data).toEqual({ sessionId: 'test-session' });
  });

  it('success result carries cost and token data in session_status', async () => {
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    const status = events[0].data as Record<string, unknown>;
    expect(status.costUsd).toBe(0.05);
    expect(status.contextTokens).toBe(1000);
    expect(status.model).toBe('claude-sonnet-4-20250514');
  });

  it('contextTokens sums input, cache-read, and cache-creation tokens', async () => {
    // The context window is the full input side of the turn — counting
    // input_tokens alone (the pre-fix behavior) drastically understates a
    // cached/resumed conversation.
    const msg = {
      type: 'result',
      subtype: 'success',
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: {
        'claude-sonnet-4-20250514': {
          contextWindow: 200000,
          cacheReadInputTokens: 17451,
          cacheCreationInputTokens: 5670,
        },
      },
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    const status = events[0].data as Record<string, unknown>;
    expect(status.contextTokens).toBe(1000 + 17451 + 5670);
  });

  it('emits context_usage derived from the result figures', async () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: {
        'claude-sonnet-4-20250514': {
          contextWindow: 200000,
          cacheReadInputTokens: 17451,
          cacheCreationInputTokens: 5670,
        },
      },
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    const usageEvent = events.find((e) => e.type === 'context_usage');
    expect(usageEvent).toBeDefined();
    const usage = usageEvent!.data as Record<string, unknown>;
    const total = 1000 + 17451 + 5670;
    expect(usage.totalTokens).toBe(total);
    expect(usage.maxTokens).toBe(200000);
    expect(usage.percentage).toBeCloseTo((total / 200000) * 100, 5);
    expect(usage.model).toBe('claude-sonnet-4-20250514');
    expect(usage.categories).toEqual([]);
  });

  it('omits context_usage when the context window size is unknown', async () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      // No modelUsage → contextWindow unknown → no usable percentage.
      modelUsage: {},
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events.some((e) => e.type === 'context_usage')).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['session_status', 'done']);
  });

  it('error_max_turns yields session_status + context_usage + error + done (4 events)', async () => {
    const msg = makeResultMessage('error_max_turns', ['Reached 10 turn limit']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('context_usage');
    expect(events[2].type).toBe('error');
    expect(events[3].type).toBe('done');

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('max_turns');
    expect(err.message).toBe('Reached 10 turn limit');
    expect(err.code).toBe('error_max_turns');
  });

  it('error_during_execution maps to execution_error category', async () => {
    const msg = makeResultMessage('error_during_execution', ['API rate limit exceeded']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('execution_error');
    expect(err.message).toBe('API rate limit exceeded');
    expect(err.details).toBe('API rate limit exceeded');
  });

  it('error_max_budget_usd maps to budget_exceeded category', async () => {
    const msg = makeResultMessage('error_max_budget_usd', ['Budget of $1.00 exceeded']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('budget_exceeded');
    expect(err.code).toBe('error_max_budget_usd');
  });

  it('error_max_structured_output_retries maps to output_format_error', async () => {
    const msg = makeResultMessage('error_max_structured_output_retries', [
      'Failed to produce valid JSON',
    ]);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('output_format_error');
  });

  it('error with multiple errors joins them in details', async () => {
    const msg = makeResultMessage('error_during_execution', ['Error 1', 'Error 2']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.message).toBe('Error 1');
    expect(err.details).toBe('Error 1\nError 2');
  });

  it('error with no errors array uses fallback message', async () => {
    const msg = makeResultMessage('error_during_execution');
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.message).toBe('An unexpected error occurred.');
  });

  it('unknown error subtype defaults to execution_error', async () => {
    const msg = makeResultMessage('error_unknown_future_type', ['Something new']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('execution_error');
  });
});

describe('sdk-event-mapper prompt suggestion messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps singular suggestion field to suggestions array', async () => {
    const msg = {
      type: 'prompt_suggestion',
      suggestion: 'What files were changed?',
      uuid: 'uuid-suggestion-1',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('prompt_suggestion');
    const data = events[0].data as PromptSuggestionEvent;
    expect(data.suggestions).toEqual(['What files were changed?']);
  });

  it('yields nothing for empty suggestion', async () => {
    const msg = {
      type: 'prompt_suggestion',
      suggestion: '',
      uuid: 'uuid-suggestion-2',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('yields nothing when suggestion field is missing', async () => {
    const msg = {
      type: 'prompt_suggestion',
      uuid: 'uuid-suggestion-3',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });
});

describe('sdk-event-mapper api_retry messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps api_retry system subtype to api_retry event', async () => {
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 3000,
      error_status: 429,
      error: { type: 'overloaded_error', message: 'Overloaded' },
      uuid: 'uuid-retry-1',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('api_retry');
    const data = events[0].data as ApiRetryEvent;
    expect(data).toEqual({
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 3000,
      errorStatus: 429,
    });
  });

  it('maps null error_status correctly', async () => {
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error_status: null,
      error: { type: 'api_error', message: 'Connection failed' },
      uuid: 'uuid-retry-2',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    const data = events[0].data as ApiRetryEvent;
    expect(data.errorStatus).toBeNull();
  });
});

// --- Hook lifecycle SDK message factories ---

type SDKMessage = Parameters<typeof mapSdkMessage>[0];

function sdkHookStarted(hookId: string, hookName: string, hookEvent: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_started',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    uuid: `uuid-${hookId}`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function sdkHookProgress(
  hookId: string,
  hookName: string,
  hookEvent: string,
  stdout: string,
  stderr: string
): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_progress',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    stdout,
    stderr,
    output: stdout + stderr,
    uuid: `uuid-${hookId}-progress`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function sdkHookResponse(
  hookId: string,
  hookName: string,
  hookEvent: string,
  outcome: string,
  exitCode?: number,
  stdout = '',
  stderr = ''
): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_response',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    output: stdout + stderr,
    stdout,
    stderr,
    exit_code: exitCode,
    outcome,
    uuid: `uuid-${hookId}-response`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

describe('sdk-event-mapper hook lifecycle events', () => {
  const session = makeSession();
  const sessionId = 'test-session';

  it('hook_started (tool-contextual) yields hook_started event', async () => {
    const toolState = makeToolState();
    toolState.currentToolId = 'tool-123';
    const msg = sdkHookStarted('hook-1', 'pre-commit', 'PreToolUse');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_started');
    const data = events[0].data as HookStartedEvent;
    expect(data).toEqual({
      hookId: 'hook-1',
      hookName: 'pre-commit',
      hookEvent: 'PreToolUse',
      toolCallId: 'tool-123',
    });
  });

  it('hook_started (session-level) yields system_status event', async () => {
    const toolState = makeToolState();
    const msg = sdkHookStarted('hook-2', 'session-init', 'SessionStart');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect(events[0].data).toEqual({
      message: 'Running hook "session-init"...',
    });
  });

  it('hook_progress (tool-contextual) yields hook_progress event', async () => {
    const toolState = makeToolState();
    const msg = sdkHookProgress('hook-1', 'pre-commit', 'PreToolUse', 'checking files...', '');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_progress');
    const data = events[0].data as HookProgressEvent;
    expect(data).toEqual({
      hookId: 'hook-1',
      stdout: 'checking files...',
      stderr: '',
    });
  });

  it('hook_progress (session-level) yields nothing', async () => {
    const toolState = makeToolState();
    const msg = sdkHookProgress('hook-2', 'session-init', 'SessionStart', 'output', '');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('hook_response (tool-contextual, success) yields hook_response', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse(
      'hook-1',
      'pre-commit',
      'PostToolUse',
      'success',
      0,
      'all good',
      ''
    );
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_response');
    const data = events[0].data as HookResponseEvent;
    expect(data).toEqual({
      hookId: 'hook-1',
      hookName: 'pre-commit',
      exitCode: 0,
      outcome: 'success',
      stdout: 'all good',
      stderr: '',
    });
  });

  it('hook_response (tool-contextual, error) yields hook_response', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse(
      'hook-1',
      'pre-commit',
      'PostToolUseFailure',
      'error',
      1,
      '',
      'trailing whitespace'
    );
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_response');
    const data = events[0].data as HookResponseEvent;
    expect(data.outcome).toBe('error');
    expect(data.stderr).toBe('trailing whitespace');
  });

  it('hook_response (session-level, error) yields error event', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse(
      'hook-3',
      'env-check',
      'SessionStart',
      'error',
      1,
      '',
      'missing env var'
    );
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    const data = events[0].data as ErrorEvent;
    expect(data.code).toBe('hook_failure');
    expect(data.category).toBe('execution_error');
    expect(data.message).toBe('Hook "env-check" failed (SessionStart)');
    expect(data.details).toBe('missing env var');
  });

  it('hook_response (session-level, success) yields nothing', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse('hook-3', 'env-check', 'SessionStart', 'success', 0);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });

  it('hook_started with empty currentToolId yields toolCallId: null', async () => {
    const toolState = makeToolState();
    toolState.currentToolId = '';
    const msg = sdkHookStarted('hook-4', 'pre-commit', 'PreToolUse');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_started');
    const data = events[0].data as HookStartedEvent;
    expect(data.toolCallId).toBeNull();
  });
});

describe('result message terminal_reason (SDK 0.2.91+)', () => {
  const sessionId = 'test-session';

  // Purpose: terminal_reason forwards to session_status when set on the SDK result
  it('includes terminalReason on session_status when terminal_reason is set', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'result',
      subtype: 'success',
      terminal_reason: 'max_turns',
      total_cost_usd: 0.01,
      usage: { input_tokens: 100 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
      model: 'claude-opus-4-7',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);
    const sessionStatus = events.find((e) => e.type === 'session_status');
    expect(sessionStatus).toBeDefined();
    expect((sessionStatus?.data as Record<string, unknown>).terminalReason).toBe('max_turns');
  });

  // Purpose: terminal_reason absent means the field is omitted entirely (not set to undefined)
  it('omits terminalReason when result has no terminal_reason', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      usage: { input_tokens: 100 },
      model: 'claude-opus-4-7',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);
    const sessionStatus = events.find((e) => e.type === 'session_status');
    expect(sessionStatus).toBeDefined();
    expect(sessionStatus?.data).not.toHaveProperty('terminalReason');
  });
});

describe('system.memory_recall events (SDK 0.2.105+)', () => {
  const sessionId = 'test-session';

  // Purpose: system/memory_recall forwards to a memory_recall StreamEvent with mode + memories
  it('emits memory_recall event and aggregates paths onto the session', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'system',
      subtype: 'memory_recall',
      mode: 'select',
      memories: [
        { path: '/foo/bar.md', scope: 'personal' },
        { path: '/baz.md', scope: 'team' },
      ],
      session_id: sessionId,
      uuid: 'uuid-1',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('memory_recall');
    expect(events[0].data).toMatchObject({
      mode: 'select',
      memories: [
        { path: '/foo/bar.md', scope: 'personal' },
        { path: '/baz.md', scope: 'team' },
      ],
    });
    expect(session.memoryPaths).toEqual(['/foo/bar.md', '/baz.md']);
  });

  // Purpose: successive memory_recall events dedupe paths on the session
  it('dedupes memoryPaths across repeated recalls', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg1 = {
      type: 'system',
      subtype: 'memory_recall',
      mode: 'select',
      memories: [{ path: '/foo.md', scope: 'personal' }],
      session_id: sessionId,
      uuid: 'u-1',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const msg2 = {
      type: 'system',
      subtype: 'memory_recall',
      mode: 'synthesize',
      memories: [
        { path: '/foo.md', scope: 'personal' },
        { path: '<synthesis:/notes>', scope: 'team', content: 'Summary.' },
      ],
      session_id: sessionId,
      uuid: 'u-2',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    await collectEvents(msg1, session, sessionId, toolState);
    await collectEvents(msg2, session, sessionId, toolState);

    expect(session.memoryPaths).toEqual(['/foo.md', '<synthesis:/notes>']);
  });
});

describe('system.status with status field (SDK 0.2.108+)', () => {
  const sessionId = 'test-session';

  // Purpose: requesting status with no body yields system_status with a synthesized message + raw status
  it('emits system_status with status and synthetic message when only status is set', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'system',
      subtype: 'status',
      status: 'requesting',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    const data = events[0].data as { message: string; status?: string };
    expect(data.status).toBe('requesting');
    expect(data.message).toMatch(/requesting/i);
  });

  // Purpose: legacy body-only status events keep working without a `status` field on the output
  it('emits system_status with message only when status is absent', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'system',
      subtype: 'status',
      body: 'Compacting context...',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect((events[0].data as { message: string }).message).toBe('Compacting context...');
    expect(events[0].data).not.toHaveProperty('status');
  });
});

describe('sdk-event-mapper refusal (SDK 0.3.162)', () => {
  const sessionId = 'test-session';

  // Purpose: a model refusal surfaces as a visible system_status, not a silent empty turn
  it('maps stop_reason "refusal" to a system_status with the detail hint', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_details: { message: 'unsafe content' } },
      },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect((events[0].data as { message: string }).message).toBe(
      'The model declined to respond: unsafe content'
    );
  });

  // Purpose: refusal still surfaces clearly when stop_details is absent/untyped
  it('falls back to a generic decline message when stop_details is missing', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'refusal' } },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect((events[0].data as { message: string }).message).toBe(
      'The model declined to respond to this request.'
    );
  });
});

describe('sdk-event-mapper assistant error (SDK 0.3.144)', () => {
  const sessionId = 'test-session';

  // Purpose: an unavailable model surfaces a clear, actionable error instead of a generic failure
  it('maps assistant error "model_not_found" to an error event', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'assistant',
      error: 'model_not_found',
      message: { content: [] },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    const data = events[0].data as ErrorEvent;
    expect(data.code).toBe('model_not_found');
    expect(data.category).toBe('execution_error');
    expect(data.message).toMatch(/model is unavailable/i);
  });

  // Purpose: transient errors owned by the retry/rate-limit channels are NOT double-reported here
  it('does not emit an error for rate_limit (handled by api_retry / rate_limit_event)', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [] },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });
});

describe('sdk-event-mapper permission_denied messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps an auto-mode classifier denial to a permission_denied event', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_denied_1',
      decision_reason_type: 'classifier',
      decision_reason: 'Command flagged as potentially destructive',
      message: 'This command was blocked by the auto-mode safety classifier.',
      uuid: '00000000-0000-4000-8000-0000000000aa',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_denied');
    expect(events[0].data as PermissionDeniedEvent).toEqual({
      toolCallId: 'toolu_denied_1',
      toolName: 'Bash',
      reasonType: 'classifier',
      reason: 'Command flagged as potentially destructive',
      message: 'This command was blocked by the auto-mode safety classifier.',
    });

    // It must NOT fall through to the catch-all unknown-subtype log.
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('omits optional reason fields when the SDK does not provide them', async () => {
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Write',
      tool_use_id: 'toolu_denied_2',
      message: 'Blocked.',
      uuid: '00000000-0000-4000-8000-0000000000ab',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    const data = events[0].data as PermissionDeniedEvent;
    expect(data.toolCallId).toBe('toolu_denied_2');
    expect(data.toolName).toBe('Write');
    expect(data.message).toBe('Blocked.');
    expect(data.reasonType).toBeUndefined();
    expect(data.reason).toBeUndefined();
  });
});
