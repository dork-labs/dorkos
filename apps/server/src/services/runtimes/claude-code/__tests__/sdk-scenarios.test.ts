import { describe, it, expect } from 'vitest';
import {
  wrapSdkQuery,
  sdkSimpleText,
  sdkToolCall,
  sdkTodoWrite,
  sdkError,
  sdkTaskStarted,
  sdkTaskProgress,
  sdkTaskNotification,
} from './sdk-scenarios.js';

describe('sdk-scenarios.ts', () => {
  describe('wrapSdkQuery', () => {
    it('attaches supportedModels and setPermissionMode stubs', async () => {
      // Purpose: verify the query() shape contract — if the stubs are missing,
      // ClaudeCodeRuntime will throw when it calls these methods on the mock.
      const gen = sdkSimpleText('hello');
      const wrapped = wrapSdkQuery(gen);
      expect(typeof wrapped.supportedModels).toBe('function');
      expect(typeof wrapped.setPermissionMode).toBe('function');
      await expect(wrapped.supportedModels()).resolves.toEqual([]);
    });

    it('setPermissionMode resolves to undefined', async () => {
      const wrapped = wrapSdkQuery(sdkSimpleText('test'));
      await expect(wrapped.setPermissionMode('default')).resolves.toBeUndefined();
    });
  });

  describe('sdkSimpleText', () => {
    it('yields init → text_delta stream_event → result in order', async () => {
      // Purpose: confirm the mapper receives messages in the required order.
      // init must come first (mapper emits session_status); result must come last (emits done).
      const messages = [];
      for await (const msg of sdkSimpleText('hi')) messages.push(msg);
      expect(messages[0].type).toBe('system');
      expect((messages[0] as { type: 'system'; subtype: string }).subtype).toBe('init');
      const delta = messages.find(
        (m) =>
          m.type === 'stream_event' &&
          (m as { event?: { delta?: { type?: string } } }).event?.delta?.type === 'text_delta'
      );
      expect(delta).toBeDefined();
      expect(messages.at(-1)?.type).toBe('result');
      expect((messages.at(-1) as { type: 'result'; subtype: string }).subtype).toBe('success');
    });

    it('includes the provided text in the text_delta event', async () => {
      const messages = [];
      for await (const msg of sdkSimpleText('Hello world')) messages.push(msg);
      const delta = messages.find(
        (m) =>
          m.type === 'stream_event' &&
          (m as { event?: { delta?: { type?: string } } }).event?.delta?.type === 'text_delta'
      );
      expect(
        (delta as { event?: { delta?: { text?: string } } } | undefined)?.event?.delta?.text
      ).toBe('Hello world');
    });
  });

  describe('sdkToolCall', () => {
    it('yields init → tool_use start/delta/stop → text → result', async () => {
      // Purpose: verify the tool call sequence matches sdk-event-mapper.ts expectations.
      const messages = [];
      for await (const msg of sdkToolCall('Bash', { command: 'echo hi' }, 'done'))
        messages.push(msg);
      const types = messages.map((m) => {
        if (m.type !== 'stream_event') return m.type;
        const sm = m as {
          event?: { type?: string; delta?: { type?: string }; content_block?: { type?: string } };
        };
        return `${sm.event?.type}/${sm.event?.delta?.type ?? sm.event?.content_block?.type ?? ''}`;
      });
      expect(types).toContain('content_block_start/tool_use');
      expect(types).toContain('content_block_delta/input_json_delta');
      expect(types).toContain('content_block_stop/');
    });

    it('includes the tool name in the content_block_start event', async () => {
      const messages = [];
      for await (const msg of sdkToolCall('Read', { path: '/foo' }, 'ok')) messages.push(msg);
      const start = messages.find(
        (m) =>
          m.type === 'stream_event' &&
          (m as { event?: { type?: string } }).event?.type === 'content_block_start'
      );
      expect(
        (start as { event?: { content_block?: { name?: string } } } | undefined)?.event
          ?.content_block?.name
      ).toBe('Read');
    });
  });

  describe('sdkTodoWrite', () => {
    it('includes tool_use_summary with correct task count', async () => {
      const tasks = [
        { id: '1', content: 'Task one', status: 'pending' as const },
        { id: '2', content: 'Task two', status: 'pending' as const },
      ];
      const messages = [];
      for await (const msg of sdkTodoWrite(tasks)) messages.push(msg);
      const summary = messages.find((m) => m.type === 'tool_use_summary');
      expect(summary).toBeDefined();
      expect((summary as { summary?: string } | undefined)?.summary).toContain('2');
    });
  });

  describe('sdkError', () => {
    it('yields is_error=true result with the provided message in errors array', async () => {
      // Purpose: verify error scenarios produce valid SDKMessage that the mapper
      // processes into an error StreamEvent, not an exception.
      const messages = [];
      for await (const msg of sdkError('oops')) messages.push(msg);
      const result = messages.find((m) => m.type === 'result');
      expect((result as { is_error?: boolean } | undefined)?.is_error).toBe(true);
      const errors = (result as { errors?: string[] } | undefined)?.errors;
      expect(errors).toBeDefined();
      expect(errors).toContain('oops');
    });
  });

  describe('sdkTaskStarted', () => {
    it('produces a system message with subtype task_started', () => {
      const msg = sdkTaskStarted('task-42', 'Explore the codebase');
      expect(msg.type).toBe('system');
      expect((msg as { subtype: string }).subtype).toBe('task_started');
      expect((msg as { task_id: string }).task_id).toBe('task-42');
      expect((msg as { description: string }).description).toBe('Explore the codebase');
    });
  });

  describe('sdkTaskProgress', () => {
    it('includes usage metrics and optional lastToolName', () => {
      const msg = sdkTaskProgress('task-42', 3, 5000, 'Read');
      expect((msg as { subtype: string }).subtype).toBe('task_progress');
      const usage = (msg as { usage: { tool_uses: number; duration_ms: number } }).usage;
      expect(usage.tool_uses).toBe(3);
      expect(usage.duration_ms).toBe(5000);
      expect((msg as { last_tool_name: string }).last_tool_name).toBe('Read');
    });
  });

  describe('sdkTaskNotification', () => {
    it('includes status, summary, and usage', () => {
      const msg = sdkTaskNotification('task-42', 'completed', 'Done exploring');
      expect((msg as { subtype: string }).subtype).toBe('task_notification');
      expect((msg as { status: string }).status).toBe('completed');
      expect((msg as { summary: string }).summary).toBe('Done exploring');
    });
  });
});
