import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
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
  initLogger: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>'),
}));
vi.mock('../tool-filter.js', () => ({
  resolveToolConfig: vi.fn().mockReturnValue({ pulse: true, relay: true, mesh: true, adapter: true }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../pulse/pulse-state.js', () => ({
  isPulseEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({
      pulseTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
    }),
  },
}));
vi.mock('../../../lib/boundary.js', () => ({
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

/** Wrap an async generator with stub SDK query methods so the mock matches the real shape. */
function mockQueryResult(gen: AsyncGenerator) {
  return Object.assign(gen, {
    supportedModels: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  });
}

describe('AgentManager', () => {
  let agentManager: typeof import('../agent-manager.js').agentManager;

  beforeEach(async () => {
    vi.resetModules();
    // Re-mock after resetModules
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));
    const mod = await import('../agent-manager.js');
    agentManager = mod.agentManager;
  });

  describe('ensureSession()', () => {
    it('stores session with correct defaults', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      expect(agentManager.hasSession('s1')).toBe(true);
    });

    it('stores session with bypassPermissions mode', () => {
      agentManager.ensureSession('s2', { permissionMode: 'bypassPermissions' });
      expect(agentManager.hasSession('s2')).toBe(true);
    });

    it('does not overwrite existing session', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      agentManager.ensureSession('s1', { permissionMode: 'bypassPermissions' });
      // Should still be 'default' since the first call created it
      expect(agentManager.hasSession('s1')).toBe(true);
    });
  });

  describe('sendMessage()', () => {
    it('auto-creates session if not in memory', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'nonexistent',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-2',
            session_id: 'nonexistent',
          };
        })())
      );

      // Don't call ensureSession first - sendMessage should auto-create
      const events = [];
      for await (const event of agentManager.sendMessage('nonexistent', 'hello')) {
        events.push(event);
      }

      expect(agentManager.hasSession('nonexistent')).toBe(true);
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
    });

    it('streams SDK text_delta events', async () => {
      // Re-import to get the mocked query
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      // Mock SDK to yield an init message and a text delta
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-123',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello world' },
            },
            parent_tool_use_id: null,
            uuid: 'uuid-2',
            session_id: 'sdk-session-123',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: 'Hello world',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-3',
            session_id: 'sdk-session-123',
          };
        })())
      );

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        events.push(event);
      }

      const textEvent = events.find((e) => e.type === 'text_delta');
      expect(textEvent).toBeDefined();
      expect((textEvent!.data as any).text).toBe('Hello world');

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as any).sessionId).toBe('s1');
    });

    it('streams tool call events', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-456',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tc-1', name: 'Read', input: {} },
            },
            parent_tool_use_id: null,
            uuid: 'uuid-2',
            session_id: 'sdk-session-456',
          };
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"file":"test.ts"}' },
            },
            parent_tool_use_id: null,
            uuid: 'uuid-3',
            session_id: 'sdk-session-456',
          };
          yield {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
            parent_tool_use_id: null,
            uuid: 'uuid-4',
            session_id: 'sdk-session-456',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-5',
            session_id: 'sdk-session-456',
          };
        })())
      );

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'read test.ts')) {
        events.push(event);
      }

      const startEvent = events.find((e) => e.type === 'tool_call_start');
      expect(startEvent).toBeDefined();
      expect((startEvent!.data as any).toolName).toBe('Read');

      const deltaEvent = events.find((e) => e.type === 'tool_call_delta');
      expect(deltaEvent).toBeDefined();
      expect((deltaEvent!.data as any).input).toBe('{"file":"test.ts"}');

      const endEvent = events.find((e) => e.type === 'tool_call_end');
      expect(endEvent).toBeDefined();
      expect((endEvent!.data as any).status).toBe('complete');
    });

    it('passes systemPrompt with claude_code preset to SDK query', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-sp',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-2',
            session_id: 'sdk-session-sp',
          };
        })())
      );

      agentManager.ensureSession('sp-test', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('sp-test', 'hello')) {
        events.push(event);
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: expect.stringContaining('<env>'),
            },
          }),
        })
      );
    });

    it('retries without resume when SDK throws a resume failure', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      let callCount = 0;
      (mockedQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: simulate a stale session resume failure
          return mockQueryResult((async function* () {
            throw new Error('Query closed before response received');
          })());
        }
        // Second call: succeed normally
        return mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'new-session',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-2',
            session_id: 'new-session',
          };
        })());
      });

      // Start with hasStarted: true so the first call uses resume
      agentManager.ensureSession('stale', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('stale', 'hello')) {
        events.push(event);
      }

      // Should NOT have an error event — retry succeeded
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      // Should have a done event from the successful retry
      expect(events.find((e) => e.type === 'done')).toBeDefined();
      // SDK query should have been called twice (first with resume, second without)
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });

    it('retries when Claude Code process exits with code 1 (stale resume)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      let callCount = 0;
      (mockedQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockQueryResult((async function* () {
            throw new Error('Claude Code process exited with code 1');
          })());
        }
        return mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'new-session-2',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-2',
            session_id: 'new-session-2',
          };
        })());
      });

      agentManager.ensureSession('stale-exit', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('stale-exit', 'hello')) {
        events.push(event);
      }

      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect(events.find((e) => e.type === 'done')).toBeDefined();
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });

    it('uses opts.cwd over empty session.cwd', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'cwd-test',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/correct/path',
            apiKeySource: 'user',
            uuid: 'uuid-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-2',
            session_id: 'cwd-test',
          };
        })())
      );

      // Session created with empty cwd (simulating stale binding)
      agentManager.ensureSession('cwd-empty', { permissionMode: 'default', cwd: '' });

      const events = [];
      for await (const event of agentManager.sendMessage('cwd-empty', 'hello', { cwd: '/correct/path' })) {
        events.push(event);
      }

      // Should use opts.cwd, not the empty session.cwd
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: '/correct/path',
          }),
        })
      );
    });

    it('does not retry for non-resume SDK errors', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        mockQueryResult((async function* () {
          throw new Error('API key not found');
        })())
      );

      // Use hasStarted: true so the retry path is reachable — but non-resume errors should not retry
      agentManager.ensureSession('s1', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as any).message).toBe('API key not found');

      // Should still emit done
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      // Should only have been called once — no retry
      expect(mockedQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage() boundary enforcement', () => {
    it('yields error event when cwd violates boundary', async () => {
      const { validateBoundary } = await import('../../../lib/boundary.js');
      const { BoundaryError } = await import('../../../lib/boundary.js');

      // Make validateBoundary reject with BoundaryError
      (validateBoundary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      agentManager.ensureSession('boundary-test', {
        permissionMode: 'default',
        cwd: '/outside/boundary',
      });

      const events = [];
      for await (const event of agentManager.sendMessage('boundary-test', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as any).message).toContain('Directory boundary violation');
    });
  });

  describe('approveTool()', () => {
    it('returns false when no pending approval', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      expect(agentManager.approveTool('s1', 'tc1', true)).toBe(false);
    });

    it('returns false for nonexistent session', () => {
      expect(agentManager.approveTool('nonexistent', 'tc1', true)).toBe(false);
    });
  });

  describe('hasSession()', () => {
    it('returns true for existing session', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      expect(agentManager.hasSession('s1')).toBe(true);
    });

    it('returns false for non-existing session', () => {
      expect(agentManager.hasSession('nonexistent')).toBe(false);
    });
  });

  describe('getSdkSessionId()', () => {
    it('returns session id for existing session', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      expect(agentManager.getSdkSessionId('s1')).toBe('s1');
    });

    it('returns undefined for non-existing session', () => {
      expect(agentManager.getSdkSessionId('nonexistent')).toBeUndefined();
    });
  });

  describe('checkSessionHealth()', () => {
    it('removes sessions older than 30 minutes', () => {
      agentManager.ensureSession('old', { permissionMode: 'default' });

      // Advance time by 31 minutes
      vi.useFakeTimers();
      vi.advanceTimersByTime(31 * 60 * 1000);

      agentManager.checkSessionHealth();
      expect(agentManager.hasSession('old')).toBe(false);

      vi.useRealTimers();
    });

    it('keeps fresh sessions', () => {
      agentManager.ensureSession('fresh', { permissionMode: 'default' });

      vi.useFakeTimers();
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 minutes

      agentManager.checkSessionHealth();
      expect(agentManager.hasSession('fresh')).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('sendMessage() tool filtering', () => {
    /** SDK mock that yields init + result (minimal successful flow). */
    function mockSuccessFlow() {
      return mockQueryResult(
        (async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'tf-session',
            tools: [],
            mcp_servers: [],
            model: 'test',
            permissionMode: 'default',
            slash_commands: [],
            output_style: 'text',
            skills: [],
            plugins: [],
            cwd: '/test',
            apiKeySource: 'user',
            uuid: 'uuid-tf-1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            duration_ms: 100,
            duration_api_ms: 80,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: {},
            permission_denials: [],
            uuid: 'uuid-tf-2',
            session_id: 'tf-session',
          };
        })()
      );
    }

    it('calls resolveToolConfig with manifest enabledToolGroups', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (readManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'test-id',
        name: 'test',
        enabledToolGroups: { pulse: false },
      });

      agentManager.ensureSession('tf-1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-1', 'hello')) {
        events.push(event);
      }

      expect(resolveToolConfig).toHaveBeenCalledWith(
        { pulse: false },
        expect.objectContaining({
          pulseEnabled: expect.any(Boolean),
          relayEnabled: expect.any(Boolean),
          globalConfig: expect.objectContaining({
            pulseTools: true,
            relayTools: true,
          }),
        })
      );
    });

    it('passes toolConfig to buildSystemPromptAppend', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { buildSystemPromptAppend } = await import('../context-builder.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (buildSystemPromptAppend as ReturnType<typeof vi.fn>).mockClear();

      agentManager.ensureSession('tf-2', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-2', 'hello')) {
        events.push(event);
      }

      expect(buildSystemPromptAppend).toHaveBeenCalledTimes(1);
      const callArgs = (buildSystemPromptAppend as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof callArgs[0]).toBe('string'); // cwd
      // callArgs[1] is meshCore (null when not set)
      expect(callArgs[2]).toEqual(
        expect.objectContaining({
          pulse: expect.any(Boolean),
          relay: expect.any(Boolean),
          mesh: expect.any(Boolean),
          adapter: expect.any(Boolean),
        })
      );
    });

    it('applies allowedTools to SDK options when buildAllowedTools returns a list', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { buildAllowedTools } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (buildAllowedTools as ReturnType<typeof vi.fn>).mockReturnValue([
        'mcp__dorkos__ping',
        'mcp__dorkos__get_server_info',
      ]);

      agentManager.ensureSession('tf-3', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-3', 'hello')) {
        events.push(event);
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: expect.arrayContaining([
              'mcp__dorkos__ping',
              'mcp__dorkos__get_server_info',
            ]),
          }),
        })
      );
    });

    it('does not set allowedTools when buildAllowedTools returns undefined', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { buildAllowedTools } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (buildAllowedTools as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      agentManager.ensureSession('tf-4', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-4', 'hello')) {
        events.push(event);
      }

      const callArgs = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.options.allowedTools).toBeUndefined();
    });

    it('uses global defaults when no agent manifest exists', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      // readManifest throws (no .dork/agent.json)
      (readManifest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ENOENT')
      );

      agentManager.ensureSession('tf-5', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-5', 'hello')) {
        events.push(event);
      }

      // Should pass undefined for agentConfig (no manifest)
      expect(resolveToolConfig).toHaveBeenCalledWith(
        undefined,
        expect.any(Object)
      );
      // Should still complete without errors
      expect(events.find((e) => e.type === 'done')).toBeDefined();
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
    });
  });
});
