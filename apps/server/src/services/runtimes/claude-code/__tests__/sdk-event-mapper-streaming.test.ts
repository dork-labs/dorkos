import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

/** Collect all events from the async generator. */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-123',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeToolState(): ToolState {
  let inTool = false;
  let currentToolName = '';
  let currentToolId = '';
  let taskToolInput = '';
  let inThinking = false;
  let thinkingStartMs = 0;
  return {
    get inTool() {
      return inTool;
    },
    get currentToolName() {
      return currentToolName;
    },
    get currentToolId() {
      return currentToolId;
    },
    get taskToolInput() {
      return taskToolInput;
    },
    get inThinking() {
      return inThinking;
    },
    set inThinking(v: boolean) {
      inThinking = v;
    },
    get thinkingStartMs() {
      return thinkingStartMs;
    },
    set thinkingStartMs(v: number) {
      thinkingStartMs = v;
    },
    toolNameById: new Map<string, string>(),
    resolvedResultIds: new Set<string>(),
    toolInputReceived: new Set<string>(),
    appendTaskInput: (chunk: string) => {
      taskToolInput += chunk;
    },
    resetTaskInput: () => {
      taskToolInput = '';
    },
    setToolState: (tool: boolean, name: string, id: string) => {
      inTool = tool;
      currentToolName = name;
      currentToolId = id;
    },
  };
}

describe('mapSdkMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('system/init messages', () => {
    it('emits session_status with model on init', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'system',
            subtype: 'init',
            session_id: 'new-sdk-id',
            model: 'claude-3',
          } as unknown,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session_status');
      expect((events[0].data as Record<string, unknown>).model).toBe('claude-3');
    });
  });

  describe('stream_event messages', () => {
    it('content_block_start (tool_use) emits tool_call_start', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tc-1', name: 'Read', input: {} },
            },
          } as unknown,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_start');
      expect((events[0].data as Record<string, unknown>).toolName).toBe('Read');
      expect((events[0].data as Record<string, unknown>).toolCallId).toBe('tc-1');
    });

    it('content_block_delta (text_delta, not in tool) emits text_delta', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello world' },
            },
          } as unknown,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      expect((events[0].data as Record<string, unknown>).text).toBe('Hello world');
    });
  });

  describe('MCP tool result streaming', () => {
    it('emits tool_result from user message for MCP tools', async () => {
      // Setup: simulate content_block_start to register the tool in toolNameById
      const toolState = makeToolState();
      const session = makeSession();

      // First, register the tool via content_block_start
      await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'mcp-tc-1',
                name: 'mcp__dorkos__mesh_list',
                input: {},
              },
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // Then, send the user message with tool_result
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'mcp-tc-1',
                  content: [{ type: 'text', text: '{"agents":[{"name":"agent-1"}]}' }],
                },
              ],
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_result');
      expect((events[0].data as Record<string, unknown>).toolCallId).toBe('mcp-tc-1');
      expect((events[0].data as Record<string, unknown>).toolName).toBe('mcp__dorkos__mesh_list');
      expect((events[0].data as Record<string, unknown>).result).toBe(
        '{"agents":[{"name":"agent-1"}]}'
      );
      expect((events[0].data as Record<string, unknown>).status).toBe('complete');
    });

    it('deduplicates tool_result when tool_use_summary already fired', async () => {
      const toolState = makeToolState();
      const session = makeSession();

      // Register tool
      await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'builtin-tc-1',
                name: 'Read',
                input: {},
              },
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // tool_use_summary fires for built-in tool (adds to resolvedResultIds)
      await collectEvents(
        mapSdkMessage(
          {
            type: 'tool_use_summary',
            summary: 'File contents here',
            preceding_tool_use_ids: ['builtin-tc-1'],
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // User message arrives with the same tool ID
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'builtin-tc-1',
                  content: [{ type: 'text', text: 'File contents here' }],
                },
              ],
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // Should yield nothing — already resolved via tool_use_summary
      expect(events).toHaveLength(0);
    });

    it('backfills tool input from assistant message when no input_json_delta was received', async () => {
      const toolState = makeToolState();
      const session = makeSession();

      // Register tool via content_block_start (no input_json_delta follows)
      await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'mcp-tc-2',
                name: 'mcp__dorkos__mesh_list',
                input: {},
              },
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // content_block_stop (no input_json_delta in between)
      await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      // Assistant message with the full tool_use block
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'mcp-tc-2',
                  name: 'mcp__dorkos__mesh_list',
                  input: {},
                },
              ],
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_delta');
      expect((events[0].data as Record<string, unknown>).toolCallId).toBe('mcp-tc-2');
      expect((events[0].data as Record<string, unknown>).input).toBe('{}');
    });

    it('skips user messages with isReplay: true (replay guard)', async () => {
      const toolState = makeToolState();
      const session = makeSession();

      // Register tool
      toolState.toolNameById.set('mcp-tc-4', 'mcp__dorkos__mesh_list');

      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'user',
            isReplay: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'mcp-tc-4',
                  content: [{ type: 'text', text: 'stale result' }],
                },
              ],
            },
          } as unknown,
          session,
          'session-1',
          toolState
        )
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('tool_use_summary messages', () => {
    it('emits tool_result for each preceding tool use ID', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'tool_use_summary',
            summary: 'File read successfully',
            preceding_tool_use_ids: ['tc-1', 'tc-2'],
          } as unknown,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_result');
      expect((events[0].data as Record<string, unknown>).toolCallId).toBe('tc-1');
      expect(events[1].type).toBe('tool_result');
      expect((events[1].data as Record<string, unknown>).toolCallId).toBe('tc-2');
    });
  });

  describe('tool_progress messages', () => {
    it('emits tool_progress with toolCallId and content', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'tool_progress',
            tool_use_id: 'tc-1',
            content: 'Installing dependencies...\n',
          } as unknown,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_progress');
      expect((events[0].data as Record<string, unknown>).toolCallId).toBe('tc-1');
      expect((events[0].data as Record<string, unknown>).content).toBe(
        'Installing dependencies...\n'
      );
    });
  });

  describe('result messages', () => {
    it('RT-CMP-03: includes token counts from the last request usage, and the model’s window', async () => {
      // contextTokens reflects the most recent request (captured during streaming),
      // not the result message's cumulative usage. contextWindow is a per-model
      // constant read from the aggregate.
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'result',
            model: 'claude-3',
            total_cost_usd: 0.002,
            usage: { input_tokens: 200, output_tokens: 100 },
            modelUsage: { 'claude-3': { contextWindow: 200000 } },
          } as unknown,
          makeSession({
            lastRequestUsage: { inputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
          }),
          'session-1',
          makeToolState()
        )
      );
      const statusEvent = events.find((e) => e.type === 'session_status');
      expect((statusEvent!.data as Record<string, unknown>).contextTokens).toBe(200);
      expect((statusEvent!.data as Record<string, unknown>).contextMaxTokens).toBe(200000);
    });
  });

  describe('rate_limit_event messages', () => {
    it('projects subscription usage onto session_status when rate_limit_info is present', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed', utilization: 0.5, rateLimitType: 'five_hour' },
          } as unknown,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session_status');
    });
  });
});
