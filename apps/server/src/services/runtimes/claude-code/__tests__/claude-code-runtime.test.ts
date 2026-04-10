import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wrapSdkQuery, sdkSimpleText, sdkToolCall } from './sdk-scenarios.js';

// Hoist shared mock functions so the test and ClaudeCodeRuntime share the same
// vi.fn() instances for context-builder and tool-filter.
const {
  _mockBuildSystemPromptAppend,
  _mockResolveToolConfig,
  _mockBuildAllowedTools,
  contextBuilderFactory,
  toolFilterFactory,
} = vi.hoisted(() => {
  const bspa = vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>');
  const rtc = vi.fn().mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true });
  const bat = vi.fn().mockReturnValue(undefined);
  return {
    _mockBuildSystemPromptAppend: bspa,
    _mockResolveToolConfig: rtc,
    _mockBuildAllowedTools: bat,
    contextBuilderFactory: () => ({
      buildSystemPromptAppend: bspa,
      buildPerMessageContext: vi.fn().mockResolvedValue(''),
    }),
    toolFilterFactory: () => ({ resolveToolConfig: rtc, buildAllowedTools: bat }),
  };
});

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
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
  initLogger: vi.fn(),
}));
// Mock the canonical paths so that ClaudeCodeRuntime's direct imports are intercepted.
vi.mock('../context-builder.js', contextBuilderFactory);
vi.mock('../tool-filter.js', toolFilterFactory);
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({
      tasksTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
    }),
  },
}));
vi.mock('../../../../lib/boundary.js', () => ({
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
// Mock the filesystem command scanner so tests don't read real .claude/commands/ on disk
vi.mock('../command-registry.js', () => ({
  CommandRegistryService: vi.fn().mockImplementation(() => ({
    getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: new Date().toISOString() }),
    invalidateCache: vi.fn(),
  })),
}));

describe('ClaudeCodeRuntime', () => {
  let agentManager: InstanceType<typeof import('../claude-code-runtime.js').ClaudeCodeRuntime>;

  beforeEach(async () => {
    vi.resetModules();
    // Re-mock after resetModules
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));
    const mod = await import('../claude-code-runtime.js');
    agentManager = new mod.ClaudeCodeRuntime('/tmp/dorkos-test');
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
        wrapSdkQuery(
          (async function* () {
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
          })()
        )
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
        wrapSdkQuery(sdkSimpleText('Hello world'))
      );

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        events.push(event);
      }

      const textEvent = events.find((e) => e.type === 'text_delta');
      expect(textEvent).toBeDefined();
      expect((textEvent!.data as Record<string, unknown>).text).toBe('Hello world');

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as Record<string, unknown>).sessionId).toBe('s1');
    });

    it('streams tool call events', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(sdkToolCall('Read', { file: 'test.ts' }, ''))
      );

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'read test.ts')) {
        events.push(event);
      }

      const startEvent = events.find((e) => e.type === 'tool_call_start');
      expect(startEvent).toBeDefined();
      expect((startEvent!.data as Record<string, unknown>).toolName).toBe('Read');

      const deltaEvent = events.find((e) => e.type === 'tool_call_delta');
      expect(deltaEvent).toBeDefined();
      expect((deltaEvent!.data as Record<string, unknown>).input).toBe('{"file":"test.ts"}');

      const endEvent = events.find((e) => e.type === 'tool_call_end');
      expect(endEvent).toBeDefined();
      expect((endEvent!.data as Record<string, unknown>).status).toBe('complete');
    });

    it('passes systemPrompt with claude_code preset to SDK query', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
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
          })()
        )
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
          return wrapSdkQuery(
            (async function* () {
              throw new Error('Query closed before response received');
            })()
          );
        }
        // Second call: succeed normally with content
        return wrapSdkQuery(sdkSimpleText('retry succeeded'));
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

    it('surfaces process exit code errors immediately (not treated as resume failure)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
            throw new Error('Claude Code process exited with code 1');
          })()
        )
      );

      agentManager.ensureSession('stale-exit', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('stale-exit', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data.category).toBe('execution_error');
      expect(errorEvent!.data.message).toContain('stopped unexpectedly');
      // Should NOT retry — process exit is not a resume failure
      expect(mockedQuery).toHaveBeenCalledTimes(1);
    });

    it('uses opts.cwd over empty session.cwd', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
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
          })()
        )
      );

      // Session created with empty cwd (simulating stale binding)
      agentManager.ensureSession('cwd-empty', { permissionMode: 'default', cwd: '' });

      const events = [];
      for await (const event of agentManager.sendMessage('cwd-empty', 'hello', {
        cwd: '/correct/path',
      })) {
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
        wrapSdkQuery(
          (async function* () {
            throw new Error('API key not found');
          })()
        )
      );

      // Use hasStarted: true so the retry path is reachable — but non-resume errors should not retry
      agentManager.ensureSession('s1', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      const errorData = errorEvent!.data as Record<string, unknown>;
      expect(errorData.message).toContain('stopped unexpectedly');
      expect(errorData.category).toBe('execution_error');
      expect(errorData.details).toBe('API key not found');

      // Should still emit done
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      // Should only have been called once — no retry
      expect(mockedQuery).toHaveBeenCalledTimes(1);
    });

    it('emits error when stream completes with zero content events', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      // SDK yields only init + success result — no text_delta or tool_call_start
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'empty-stream',
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
              session_id: 'empty-stream',
            };
          })()
        )
      );

      agentManager.ensureSession('empty', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('empty', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as Record<string, unknown>).message).toContain('did not respond');
      expect((errorEvent!.data as Record<string, unknown>).category).toBe('execution_error');
    });

    it('retries resume failure once then surfaces error on second failure', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      // Both calls throw 'session not found' — a genuine resume failure
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
            throw new Error('session not found');
          })()
        )
      );

      agentManager.ensureSession('retry-exhaust', { permissionMode: 'default', hasStarted: true });
      const events = [];
      for await (const event of agentManager.sendMessage('retry-exhaust', 'hello')) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as Record<string, unknown>).category).toBe('execution_error');
      // Called twice: original + one retry (MAX_RESUME_RETRIES = 1)
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendMessage() boundary enforcement', () => {
    it('yields error event when cwd violates boundary', async () => {
      const { validateBoundary } = await import('../../../../lib/boundary.js');
      const { BoundaryError } = await import('../../../../lib/boundary.js');

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
      expect((errorEvent!.data as Record<string, unknown>).message).toContain(
        'Directory boundary violation'
      );
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
      return wrapSdkQuery(sdkSimpleText(''));
    }

    it('calls resolveToolConfig with manifest enabledToolGroups', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (readManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'test-id',
        name: 'test',
        enabledToolGroups: { tasks: false },
      });

      agentManager.ensureSession('tf-1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-1', 'hello')) {
        events.push(event);
      }

      expect(resolveToolConfig).toHaveBeenCalledWith(
        { tasks: false },
        expect.objectContaining({
          tasksEnabled: expect.any(Boolean),
          relayEnabled: expect.any(Boolean),
          globalConfig: expect.objectContaining({
            tasksTools: true,
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
      expect(callArgs[1]).toEqual(
        expect.objectContaining({
          tasks: expect.any(Boolean),
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

    it('uses global config defaults when no agent manifest exists', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      // readManifest throws (no .dork/agent.json)
      (readManifest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      agentManager.ensureSession('tf-5', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-5', 'hello')) {
        events.push(event);
      }

      // Should pass undefined for agentConfig (no manifest)
      expect(resolveToolConfig).toHaveBeenCalledWith(undefined, expect.any(Object));
      // Should still complete without errors
      expect(events.find((e) => e.type === 'done')).toBeDefined();
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
    });
  });

  describe('getCommands() SDK caching', () => {
    /** SDK mock that yields init + result (minimal successful flow). */
    function mockSuccessFlow() {
      return wrapSdkQuery(sdkSimpleText(''));
    }

    it('returns filesystem-only commands before any sendMessage', async () => {
      // Pass a temp cwd with no .claude/commands/ so the filesystem scanner finds nothing
      const result = await agentManager.getCommands(false, '/tmp/dorkos-test-nonexistent');
      // No SDK commands cached yet — should fall back to filesystem scanner
      expect(result.commands).toEqual([]);
      expect(result.lastScanned).toBeDefined();
    });

    it('caches SDK commands after first sendMessage', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockCommands = [
        { name: '/compact', description: 'Compact conversation', argumentHint: '' },
        { name: '/help', description: 'Show help', argumentHint: '[topic]' },
      ];

      const queryResult = mockSuccessFlow();
      queryResult.supportedCommands.mockResolvedValue(mockCommands);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);

      agentManager.ensureSession('cmd-1', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('cmd-1', 'hello')) {
        // drain stream
      }

      // Wait for non-blocking supportedCommands() to resolve
      await vi.waitFor(async () => {
        const result = await agentManager.getCommands();
        expect(result.commands).toHaveLength(2);
      });

      const result = await agentManager.getCommands();
      expect(result.commands[0].fullCommand).toBe('/compact');
      expect(result.commands[1].fullCommand).toBe('/help');
      expect(result.commands[1].argumentHint).toBe('[topic]');
    });

    it('does not re-fetch commands on subsequent messages', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockCommands = [
        { name: '/compact', description: 'Compact conversation', argumentHint: '' },
      ];

      // First message — populates cache
      const queryResult1 = mockSuccessFlow();
      queryResult1.supportedCommands.mockResolvedValue(mockCommands);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult1);

      agentManager.ensureSession('cmd-2', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('cmd-2', 'hello')) {
        // drain
      }

      await vi.waitFor(async () => {
        const result = await agentManager.getCommands();
        expect(result.commands).toHaveLength(1);
      });

      // Second message — should NOT call supportedCommands again
      const queryResult2 = mockSuccessFlow();
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult2);

      for await (const _ of agentManager.sendMessage('cmd-2', 'world')) {
        // drain
      }

      // supportedCommands on the second query should never be called
      expect(queryResult2.supportedCommands).not.toHaveBeenCalled();
    });

    it('preserves SDK commands on forceRefresh (only refreshes filesystem metadata)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockCommands = [
        { name: '/compact', description: 'Compact conversation', argumentHint: '' },
      ];

      const queryResult = mockSuccessFlow();
      queryResult.supportedCommands.mockResolvedValue(mockCommands);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);

      agentManager.ensureSession('cmd-3', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('cmd-3', 'hello')) {
        // drain
      }

      await vi.waitFor(async () => {
        const result = await agentManager.getCommands();
        expect(result.commands).toHaveLength(1);
      });

      // forceRefresh refreshes filesystem metadata but preserves SDK commands
      const result = await agentManager.getCommands(true);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].fullCommand).toBe('/compact');
    });

    it('sorts SDK commands alphabetically by fullCommand', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockCommands = [
        { name: '/zebra', description: 'Last', argumentHint: '' },
        { name: '/alpha', description: 'First', argumentHint: '' },
        { name: '/middle', description: 'Middle', argumentHint: '' },
      ];

      const queryResult = mockSuccessFlow();
      queryResult.supportedCommands.mockResolvedValue(mockCommands);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);

      agentManager.ensureSession('cmd-4', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('cmd-4', 'hello')) {
        // drain
      }

      await vi.waitFor(async () => {
        const result = await agentManager.getCommands();
        expect(result.commands).toHaveLength(3);
      });

      const result = await agentManager.getCommands();
      expect(result.commands.map((c) => c.fullCommand)).toEqual(['/alpha', '/middle', '/zebra']);
    });
  });
});
