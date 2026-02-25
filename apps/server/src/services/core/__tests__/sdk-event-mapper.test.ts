import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../session/build-task-event.js', () => ({
  buildTaskEvent: vi.fn(),
  TASK_TOOL_NAMES: new Set(['TaskCreate', 'TaskUpdate']),
}));
vi.mock('../../../lib/logger.js', () => ({
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

import { mapSdkMessage } from '../sdk-event-mapper.js';
import { buildTaskEvent } from '../../session/build-task-event.js';
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
          } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session_status');
      expect((events[0].data as any).model).toBe('claude-3');
    });

    it('sets session.sdkSessionId and hasStarted on init', async () => {
      const session = makeSession({ sdkSessionId: 'old', hasStarted: false });
      await collectEvents(
        mapSdkMessage(
          {
            type: 'system',
            subtype: 'init',
            session_id: 'new-sdk-id',
            model: 'claude-3',
          } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(session.sdkSessionId).toBe('new-sdk-id');
      expect(session.hasStarted).toBe(true);
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
          } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_start');
      expect((events[0].data as any).toolName).toBe('Read');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
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
          } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      expect((events[0].data as any).text).toBe('Hello world');
    });

    it('content_block_delta (input_json, in tool) emits tool_call_delta', async () => {
      const toolState = makeToolState();
      toolState.setToolState(true, 'Read', 'tc-1');
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"file":"test.ts"}' },
            },
          } as any,
          makeSession(),
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_delta');
      expect((events[0].data as any).input).toBe('{"file":"test.ts"}');
    });

    it('content_block_stop (in tool) emits tool_call_end', async () => {
      const toolState = makeToolState();
      toolState.setToolState(true, 'Read', 'tc-1');
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          } as any,
          makeSession(),
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_end');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
      expect((events[0].data as any).status).toBe('complete');
    });

    it('task tool stop also emits task_update when buildTaskEvent returns event', async () => {
      const toolState = makeToolState();
      toolState.setToolState(true, 'TaskCreate', 'tc-task');
      toolState.appendTaskInput('{"subject":"Test task"}');

      const mockTaskEvent = { id: 'task-1', subject: 'Test task', status: 'in_progress' };
      (buildTaskEvent as ReturnType<typeof vi.fn>).mockReturnValue(mockTaskEvent);

      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          } as any,
          makeSession(),
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_call_end');
      expect(events[1].type).toBe('task_update');
      expect(events[1].data).toEqual(mockTaskEvent);
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
          } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_result');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
      expect(events[1].type).toBe('tool_result');
      expect((events[1].data as any).toolCallId).toBe('tc-2');
    });
  });

  describe('result messages', () => {
    it('emits session_status + done', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'result',
            model: 'claude-3',
            total_cost_usd: 0.001,
            usage: { input_tokens: 100, output_tokens: 50 },
            modelUsage: {},
          } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('session_status');
      expect((events[0].data as any).costUsd).toBe(0.001);
      expect(events[1].type).toBe('done');
    });

    it('includes token counts from usage', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'result',
            model: 'claude-3',
            total_cost_usd: 0.002,
            usage: { input_tokens: 200, output_tokens: 100 },
            modelUsage: { 'claude-3': { contextWindow: 200000 } },
          } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      const statusEvent = events.find((e) => e.type === 'session_status');
      expect((statusEvent!.data as any).contextTokens).toBe(200);
      expect((statusEvent!.data as any).contextMaxTokens).toBe(200000);
    });
  });

  describe('unknown messages', () => {
    it('yields nothing and does not throw', async () => {
      const events = await collectEvents(
        mapSdkMessage(
          { type: 'unknown_type', data: {} } as any,
          makeSession(),
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(0);
    });
  });
});
