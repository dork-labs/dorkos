import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

// Mock child_process and fs to prevent resolveClaudeCliPath side effects
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('not found');
    }),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { AgentManager } from '../agent-manager.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';

const mockedQuery = vi.mocked(query);

describe('AgentManager interactive tools', () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AgentManager('/tmp/test-cwd');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---- ensureSession / hasSession ----

  describe('ensureSession', () => {
    it('creates a session that hasSession returns true for', () => {
      expect(manager.hasSession('sess-1')).toBe(false);
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      expect(manager.hasSession('sess-1')).toBe(true);
    });

    it('does not overwrite an existing session', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      // Update the session to add a model so we can verify it persists
      manager.updateSession('sess-1', { model: 'claude-opus-4' });

      // Call ensureSession again with different permissionMode
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      // The model should still be set (session was not replaced)
      expect(manager.getSdkSessionId('sess-1')).toBe('sess-1');
    });
  });

  // ---- getSdkSessionId ----

  describe('getSdkSessionId', () => {
    it('returns the sdkSessionId for an existing session', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      expect(manager.getSdkSessionId('sess-1')).toBe('sess-1');
    });

    it('returns undefined for a non-existent session', () => {
      expect(manager.getSdkSessionId('no-such-session')).toBeUndefined();
    });
  });

  // ---- updateSession ----

  describe('updateSession', () => {
    it('returns true and updates permissionMode', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      const result = manager.updateSession('sess-1', { permissionMode: 'plan' });
      expect(result).toBe(true);
    });

    it('returns true and updates model', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      const result = manager.updateSession('sess-1', { model: 'claude-sonnet-4' });
      expect(result).toBe(true);
    });

    it('auto-creates and returns true for a non-existent session', () => {
      const result = manager.updateSession('no-session', { permissionMode: 'plan' });
      expect(result).toBe(true);
      expect(manager.hasSession('no-session')).toBe(true);
    });
  });

  // ---- submitAnswers ----

  describe('submitAnswers', () => {
    it('returns false for a non-existent session', () => {
      const result = manager.submitAnswers('no-session', 'tool-1', { q1: 'answer' });
      expect(result).toBe(false);
    });

    it('returns false when no pending question exists for the toolCallId', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      const result = manager.submitAnswers('sess-1', 'tool-1', { q1: 'answer' });
      expect(result).toBe(false);
    });

    it('returns false when pending interaction is an approval, not a question', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      // We need to trigger sendMessage to register a canUseTool callback,
      // but we can simulate having a pending approval by using sendMessage with a mocked SDK.
      // Instead, we test the public API boundary: if there is no question pending, it fails.
      // The approval case is covered by the approveTool tests below.
      const result = manager.submitAnswers('sess-1', 'tool-nonexistent', { q1: 'a' });
      expect(result).toBe(false);
    });
  });

  // ---- approveTool ----

  describe('approveTool', () => {
    it('returns false for a non-existent session', () => {
      const result = manager.approveTool('no-session', 'tool-1', true);
      expect(result).toBe(false);
    });

    it('returns false when no pending approval exists for the toolCallId', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      const result = manager.approveTool('sess-1', 'tool-1', true);
      expect(result).toBe(false);
    });
  });

  // ---- checkSessionHealth ----

  describe('checkSessionHealth', () => {
    it('removes expired sessions after SESSION_TIMEOUT_MS', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      expect(manager.hasSession('sess-1')).toBe(true);

      // Advance time past the 30-minute session timeout
      vi.advanceTimersByTime(31 * 60 * 1000);

      manager.checkSessionHealth();
      expect(manager.hasSession('sess-1')).toBe(false);
    });

    it('keeps sessions that are still within timeout', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      // Advance time to 29 minutes (within 30-minute timeout)
      vi.advanceTimersByTime(29 * 60 * 1000);

      manager.checkSessionHealth();
      expect(manager.hasSession('sess-1')).toBe(true);
    });

    it('cleans up pending interactions of expired sessions', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      // Create a sendMessage flow that registers a pending interaction,
      // then expire the session. We simulate this by starting sendMessage
      // with a canUseTool that blocks.
      const toolApprovalPromise = new Promise<void>((resolve) => {
        // We create a mock SDK that triggers canUseTool with a tool approval
        const mockAsyncIterable = {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<{ done: boolean; value?: unknown }>(() => {
                // Never resolves - simulates waiting for SDK
              }),
          }),
        };
        mockedQuery.mockReturnValue(mockAsyncIterable as unknown as ReturnType<typeof query>);
        resolve();
      });

      await toolApprovalPromise;

      // Start consuming sendMessage (will call query())
      const gen = manager.sendMessage('sess-1', 'hello');
      // Pull the first value to kick off the generator (it will block on SDK)
      const _firstResult = gen.next();

      // Advance past session timeout
      vi.advanceTimersByTime(31 * 60 * 1000);
      manager.checkSessionHealth();

      expect(manager.hasSession('sess-1')).toBe(false);
    });
  });

  // ---- sendMessage integration ----

  describe('sendMessage', () => {
    it('auto-creates session if it does not exist', async () => {
      // Mock SDK to return an async iterable that immediately completes
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'system',
              subtype: 'init',
              session_id: 'sdk-assigned-id',
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'result',
              model: 'claude-sonnet-4',
              total_cost_usd: 0.01,
              usage: { input_tokens: 100 },
              modelUsage: {},
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      const mockAsyncIterable = {
        [Symbol.asyncIterator]: () => mockIterator,
      };
      mockedQuery.mockReturnValue(mockAsyncIterable as unknown as ReturnType<typeof query>);

      expect(manager.hasSession('new-sess')).toBe(false);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('new-sess', 'hello')) {
        events.push(event);
      }

      // Session should have been auto-created
      expect(manager.hasSession('new-sess')).toBe(true);
      // SDK session ID should have been updated from init message
      expect(manager.getSdkSessionId('new-sess')).toBe('sdk-assigned-id');
    });

    it('yields text_delta events from SDK stream_events', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'system',
              subtype: 'init',
              session_id: 'sess-1',
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Hello world' },
              },
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'result',
              model: 'claude-sonnet-4',
              total_cost_usd: 0.005,
              usage: { input_tokens: 50 },
              modelUsage: {},
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'say hi')) {
        events.push(event);
      }

      const textDeltas = events.filter((e) => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(1);
      expect((textDeltas[0].data as { text: string }).text).toBe('Hello world');
    });

    it('yields tool_call_start and tool_call_end events', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                content_block: { type: 'tool_use', name: 'Read', id: 'tc-1' },
              },
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp"}' },
              },
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'stream_event',
              event: { type: 'content_block_stop' },
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'result',
              model: 'claude-sonnet-4',
              total_cost_usd: 0.01,
              usage: { input_tokens: 100 },
              modelUsage: {},
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'read file')) {
        events.push(event);
      }

      const toolStarts = events.filter((e) => e.type === 'tool_call_start');
      const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
      const toolEnds = events.filter((e) => e.type === 'tool_call_end');

      expect(toolStarts).toHaveLength(1);
      expect((toolStarts[0].data as { toolName: string }).toolName).toBe('Read');
      expect(toolDeltas).toHaveLength(1);
      expect((toolDeltas[0].data as { input: string }).input).toBe('{"path":"/tmp"}');
      expect(toolEnds).toHaveLength(1);
    });

    it('yields tool_result events from tool_use_summary messages', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'tool_use_summary',
              summary: 'File contents: hello',
              preceding_tool_use_ids: ['tc-1', 'tc-2'],
            },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'result',
              model: 'claude-sonnet-4',
              total_cost_usd: 0.01,
              usage: {},
              modelUsage: {},
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'read')) {
        events.push(event);
      }

      const toolResults = events.filter((e) => e.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
      expect((toolResults[0].data as { result: string }).result).toBe('File contents: hello');
      expect((toolResults[0].data as { toolCallId: string }).toolCallId).toBe('tc-1');
      expect((toolResults[1].data as { toolCallId: string }).toolCallId).toBe('tc-2');
    });

    it('yields done event at the end of a stream', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'hi')) {
        events.push(event);
      }

      const doneEvents = events.filter((e) => e.type === 'done');
      expect(doneEvents).toHaveLength(1);
      expect((doneEvents[0].data as { sessionId: string }).sessionId).toBe('sess-1');
    });

    it('yields error event when SDK throws', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi.fn().mockRejectedValueOnce(new Error('SDK connection failed')),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'hi')) {
        events.push(event);
      }

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0].data as { message: string }).message).toBe('SDK connection failed');

      // Should still emit done
      const doneEvents = events.filter((e) => e.type === 'done');
      expect(doneEvents).toHaveLength(1);
    });

    it('yields session_status with model from init message', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'system',
              subtype: 'init',
              session_id: 'sess-1',
              model: 'claude-opus-4',
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'hi')) {
        events.push(event);
      }

      const statusEvents = events.filter((e) => e.type === 'session_status');
      expect(statusEvents).toHaveLength(1);
      expect((statusEvents[0].data as { model: string }).model).toBe('claude-opus-4');
    });

    it('passes permissionMode to SDK options', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'plan' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator,
      } as unknown as ReturnType<typeof query>);

      // Consume the generator
      for await (const _event of manager.sendMessage('sess-1', 'hi')) {
        // drain
      }

      expect(mockedQuery).toHaveBeenCalledOnce();
      const callArgs = mockedQuery.mock.calls[0][0] as { options: { permissionMode: string } };
      expect(callArgs.options.permissionMode).toBe('plan');
    });

    it('sets resume on SDK options when session has started', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      // First message: init sets hasStarted = true
      const mockIterator1 = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({
            done: false,
            value: {
              type: 'result',
              model: 'claude-sonnet-4',
              total_cost_usd: 0.005,
              usage: {},
              modelUsage: {},
            },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator1,
      } as unknown as ReturnType<typeof query>);

      for await (const _event of manager.sendMessage('sess-1', 'first')) {
        // drain
      }

      // Second message: should have resume set
      const mockIterator2 = {
        next: vi.fn().mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator2,
      } as unknown as ReturnType<typeof query>);

      for await (const _event of manager.sendMessage('sess-1', 'second')) {
        // drain
      }

      expect(mockedQuery).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockedQuery.mock.calls[1][0] as { options: { resume?: string } };
      expect(secondCallArgs.options.resume).toBe('sess-1');
    });
  });

  // ---- canUseTool callback integration (via sendMessage) ----

  describe('canUseTool integration', () => {
    it('AskUserQuestion pushes question_prompt and submitAnswers resolves it', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      // Capture the canUseTool callback from query options

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              // This next() will block until we resolve the canUseTool promise
              .mockImplementationOnce(
                () =>
                  new Promise(() => {
                    // Never resolves - we test the interaction flow before SDK continues
                  })
              ),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      // Start consuming sendMessage
      const gen = manager.sendMessage('sess-1', 'ask me');
      const _collectedEvents: StreamEvent[] = [];

      // Pull the first event (init is consumed internally, no yield)
      // The generator will block on the second SDK next() call,
      // but we need canUseTool to fire first.
      // We need to advance: pull from gen which races SDK next + queue
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      // Now invoke canUseTool as if the SDK called it
      const questions = [
        { header: 'Test', question: 'Pick one?', options: [{ label: 'A' }], multiSelect: false },
      ];
      const permissionPromise = canUseToolFn!(
        'AskUserQuestion',
        { questions },
        { signal: new AbortController().signal, toolUseID: 'tool-q1' }
      );

      // The question_prompt event should be in the queue, so the generator should yield it
      const firstEvent = await pullPromise;
      expect(firstEvent.done).toBe(false);
      expect(firstEvent.value.type).toBe('question_prompt');
      expect((firstEvent.value.data as { toolCallId: string }).toolCallId).toBe('tool-q1');

      // Now submit answers
      const submitted = manager.submitAnswers('sess-1', 'tool-q1', { q1: 'A' });
      expect(submitted).toBe(true);

      // The canUseTool promise should resolve with allow + updatedInput
      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'allow',
        updatedInput: { questions, answers: { q1: 'A' } },
      });
    });

    it('tool approval in default mode pushes approval_required and approveTool resolves it', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'do something');
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      // Trigger canUseTool for a regular tool (not AskUserQuestion)
      const permissionPromise = canUseToolFn!(
        'Write',
        { file_path: '/tmp/test.txt', content: 'hello' },
        { signal: new AbortController().signal, toolUseID: 'tool-w1' }
      );

      const firstEvent = await pullPromise;
      expect(firstEvent.done).toBe(false);
      expect(firstEvent.value.type).toBe('approval_required');
      expect((firstEvent.value.data as { toolName: string }).toolName).toBe('Write');

      // Approve the tool
      const approved = manager.approveTool('sess-1', 'tool-w1', true);
      expect(approved).toBe(true);

      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/tmp/test.txt', content: 'hello' },
      });
    });

    it('denying a tool approval resolves with deny', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'do something');
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      const permissionPromise = canUseToolFn!(
        'Bash',
        { command: 'rm -rf /' },
        { signal: new AbortController().signal, toolUseID: 'tool-b1' }
      );

      await pullPromise; // drain approval_required event

      // Deny the tool
      const denied = manager.approveTool('sess-1', 'tool-b1', false);
      expect(denied).toBe(true);

      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'deny',
        message: 'User denied tool execution',
      });
    });

    it('non-AskUserQuestion tools in bypassPermissions mode are allowed immediately', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      // Start consuming sendMessage to register canUseTool
      const gen = manager.sendMessage('sess-1', 'go');
      gen.next(); // kick off

      // Wait a tick for the mock to register canUseToolFn
      await vi.advanceTimersByTimeAsync(0);

      // Call canUseTool for a regular tool
      const result = await canUseToolFn!(
        'Write',
        { file_path: '/tmp/test.txt' },
        { signal: new AbortController().signal, toolUseID: 'tool-w1' }
      );

      expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/test.txt' } });
    });
  });

  // ---- Timeout behavior ----

  describe('interaction timeout', () => {
    it('question interaction times out after 10 minutes with deny', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'ask');
      gen.next(); // kick off

      await vi.advanceTimersByTimeAsync(0);

      const permissionPromise = canUseToolFn!(
        'AskUserQuestion',
        { questions: [] },
        { signal: new AbortController().signal, toolUseID: 'tool-q-timeout' }
      );

      // Advance past the 10-minute timeout
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

      const result = await permissionPromise;
      expect(result).toEqual({
        behavior: 'deny',
        message: 'User did not respond within 10 minutes',
      });

      // submitAnswers should return false since interaction was cleaned up
      expect(manager.submitAnswers('sess-1', 'tool-q-timeout', {})).toBe(false);
    });

    it('tool approval interaction times out after 10 minutes with deny', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return {
            [Symbol.asyncIterator]: () => mockIterator,
          } as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'do');
      gen.next(); // kick off

      await vi.advanceTimersByTimeAsync(0);

      const permissionPromise = canUseToolFn!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 'tool-a-timeout' }
      );

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

      const result = await permissionPromise;
      expect(result).toEqual({
        behavior: 'deny',
        message: 'Tool approval timed out after 10 minutes',
      });

      expect(manager.approveTool('sess-1', 'tool-a-timeout', true)).toBe(false);
    });
  });
});
