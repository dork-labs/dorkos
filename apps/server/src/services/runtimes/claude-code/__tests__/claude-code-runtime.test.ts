import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { wrapSdkQuery, sdkSimpleText, sdkToolCall } from './sdk-scenarios.js';
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';

// Hoist shared mock functions so the test and ClaudeCodeRuntime share the same
// vi.fn() instances for context-builder and tool-filter.
const {
  _mockBuildSystemPromptAppend,
  _mockResolveToolConfig,
  contextBuilderFactory,
  toolFilterFactory,
} = vi.hoisted(() => {
  const bspa = vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>');
  const rtc = vi.fn().mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true });
  return {
    _mockBuildSystemPromptAppend: bspa,
    _mockResolveToolConfig: rtc,
    contextBuilderFactory: () => ({
      buildSystemPromptAppend: bspa,
      renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
    }),
    toolFilterFactory: () => ({ resolveToolConfig: rtc }),
  };
});

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
// Mock createIdlePrompt so the warm-probe teardown (close on the held prompt)
// can be spied; resolveClaudeCliPath is preserved for the runtime constructor.
const { _mockCreateIdlePrompt } = vi.hoisted(() => ({ _mockCreateIdlePrompt: vi.fn() }));
vi.mock('../sdk/sdk-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sdk/sdk-utils.js')>()),
  createIdlePrompt: _mockCreateIdlePrompt,
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
vi.mock('../messaging/context-builder.js', contextBuilderFactory);
vi.mock('../tooling/tool-filter.js', toolFilterFactory);
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
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
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
vi.mock('../tooling/command-registry.js', () => ({
  CommandRegistryService: vi.fn().mockImplementation(function () {
    return {
      getCommands: vi
        .fn()
        .mockResolvedValue({ commands: [], lastScanned: new Date().toISOString() }),
      invalidateCache: vi.fn(),
    };
  }),
}));
// Mock the unified-stream fan-out so command-list broadcasts can be asserted
// without an open SSE connection.
const _mockBroadcast = vi.hoisted(() => vi.fn());
vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: _mockBroadcast, addClient: vi.fn(), clientCount: 0 },
}));
// Mock the dynamic imports refreshActivatedPlugins() pulls in so the plugin-set
// swap is deterministic and never touches the real filesystem.
const { _mockListEnabledPluginNames, _mockBuildPluginsArray } = vi.hoisted(() => ({
  _mockListEnabledPluginNames: vi.fn().mockResolvedValue([]),
  _mockBuildPluginsArray: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-test'),
}));
vi.mock('../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: _mockListEnabledPluginNames,
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: _mockBuildPluginsArray,
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

    it("connection-scoping §Part 1: hydrates connector attachments for the session's agent before the turn runs", async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(sdkSimpleText('hi')));

      const hydrateSession = vi.fn().mockResolvedValue(undefined);
      agentManager.setSessionConnectors({ hydrateSession } as unknown as Parameters<
        typeof agentManager.setSessionConnectors
      >[0]);
      agentManager.setMeshCore({
        getByPath: (cwd: string) => (cwd === DEFAULT_CWD ? { id: 'agent-a' } : undefined),
        updateLastSeen: vi.fn(),
        listWithPaths: vi.fn().mockReturnValue([]),
      });

      for await (const event of agentManager.sendMessage('hydrate-1', 'hello')) {
        void event;
      }

      expect(hydrateSession).toHaveBeenCalledWith('hydrate-1', 'agent-a');
    });

    it('connection-scoping §Part 1: skips hydration when the cwd has no registered agent, without throwing', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(sdkSimpleText('hi')));

      const hydrateSession = vi.fn().mockResolvedValue(undefined);
      agentManager.setSessionConnectors({ hydrateSession } as unknown as Parameters<
        typeof agentManager.setSessionConnectors
      >[0]);
      agentManager.setMeshCore({
        getByPath: () => undefined,
        updateLastSeen: vi.fn(),
        listWithPaths: vi.fn().mockReturnValue([]),
      });

      for await (const event of agentManager.sendMessage('hydrate-2', 'hello')) {
        void event;
      }

      expect(hydrateSession).not.toHaveBeenCalled();
    });

    it('MAJOR 2: a rejected hydrateSession does not fail the turn — it still streams to done', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(sdkSimpleText('hi')));

      const hydrateSession = vi.fn().mockRejectedValue(new Error('simulated hydration failure'));
      agentManager.setSessionConnectors({ hydrateSession } as unknown as Parameters<
        typeof agentManager.setSessionConnectors
      >[0]);
      agentManager.setMeshCore({
        getByPath: (cwd: string) => (cwd === DEFAULT_CWD ? { id: 'agent-a' } : undefined),
        updateLastSeen: vi.fn(),
        listWithPaths: vi.fn().mockReturnValue([]),
      });

      const events: StreamEvent[] = [];
      for await (const event of agentManager.sendMessage('hydrate-3', 'hello')) {
        events.push(event);
      }

      expect(hydrateSession).toHaveBeenCalledWith('hydrate-3', 'agent-a');
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    it('carries supportedModels() capability fields into the next turn as summarized thinking', async () => {
      // Regression pin for the omitted-thinking incident: the supportedModels()
      // call site re-picked five fields and dropped supportsAdaptiveThinking,
      // so the capability gate in resolveThinkingOptions never opened and every
      // adaptive-capable session streamed empty thinking blocks. The SDK's
      // model objects must reach the cache whole.
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      const q1 = wrapSdkQuery(sdkSimpleText('first'));
      q1.supportedModels.mockResolvedValue([
        {
          value: 'default',
          displayName: 'Default (Opus 4.8)',
          description: 'test model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
          supportsAutoMode: true,
        },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce(q1);

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        void event;
      }

      // The model fetch is deliberately non-blocking on the send path — let its
      // .then() continuation land before the next turn reads the cache.
      await q1.supportedModels.mock.results[0]!.value;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const q2 = wrapSdkQuery(sdkSimpleText('second'));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce(q2);
      for await (const event of agentManager.sendMessage('s1', 'again')) {
        void event;
      }

      const lastCall = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const options = (lastCall[0] as { options: Record<string, unknown> }).options;
      expect(options.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
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

    it('fetches the SDK context-usage breakdown and emits it before done', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const q = wrapSdkQuery(sdkSimpleText('hi'));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(q);

      agentManager.ensureSession('s1', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('s1', 'hello')) {
        events.push(event);
      }

      // getContextUsage() is reachable only because the prompt stream is held open
      // past the result message.
      expect(q.getContextUsage).toHaveBeenCalledTimes(1);

      const usageIdx = events.findIndex((e) => e.type === 'context_usage');
      const doneIdx = events.findIndex((e) => e.type === 'done');
      expect(usageIdx).toBeGreaterThanOrEqual(0);
      // Before done so it survives the first-message session-ID remap.
      expect(usageIdx).toBeLessThan(doneIdx);

      const usage = events[usageIdx].data as Record<string, unknown>;
      // "Free space" is filtered out of the breakdown; "Messages" is kept.
      expect((usage.categories as Array<{ name: string }>).map((c) => c.name)).toEqual([
        'Messages',
      ]);
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
              // DOR-132: strip the preset's native dynamic sections so DorkOS's
              // own <git_status> block is the single source of truth.
              excludeDynamicSections: true,
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
            // eslint-disable-next-line require-yield -- simulates an SDK query that throws before yielding
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
          // eslint-disable-next-line require-yield -- simulates an SDK query that throws before yielding
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
          // eslint-disable-next-line require-yield -- simulates an SDK query that throws before yielding
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

    // DOR-1235. A `/compact` turn produces NO assistant output — the SDK
    // compacts, the model has nothing left to say, and the turn closes. To a
    // guard that only counts text/thinking/tools that is bit-for-bit a dead
    // stream, so a compaction that visibly worked reported "stopped
    // unexpectedly". The messages below are the live shape, taken from the
    // transcript of session 8352171c-382f-433a-a285-fa8d35c3c55f: the boundary
    // in the SDK's snake_case stream form, then the FOUR user messages that
    // follow it — the post-compaction continuation summary and the three
    // local-command records. Every one of their `message.content` fields is a
    // bare STRING (not a block array), so the mapper drops them all and none
    // can stand in for content.
    function compactStream(trigger: 'manual' | 'auto') {
      return async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'compact-turn',
          tools: [],
          mcp_servers: [],
          model: 'test',
          permissionMode: 'default',
          slash_commands: ['/compact'],
          output_style: 'text',
          skills: [],
          plugins: [],
          cwd: '/test',
          apiKeySource: 'user',
          uuid: 'uuid-init',
        };
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger,
            pre_tokens: 38234,
            post_tokens: 3035,
            duration_ms: 19707,
          },
          session_id: 'compact-turn',
          uuid: 'uuid-boundary',
        };
        for (const [i, record] of [
          // The summary that replaces the history, flagged `isCompactSummary`.
          {
            isCompactSummary: true,
            text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: …',
          },
          {
            isMeta: true,
            text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
          },
          {
            text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
          },
          { text: '<local-command-stdout>\u001b[2mCompacted \u001b[22m</local-command-stdout>' },
        ].entries()) {
          const { text, ...flags } = record;
          yield {
            type: 'user',
            ...flags,
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: 'compact-turn',
            uuid: `uuid-post-boundary-${i}`,
          };
        }
        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: 19_800,
          duration_api_ms: 19_700,
          is_error: false,
          num_turns: 1,
          result: '',
          stop_reason: 'end_turn',
          total_cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: {},
          permission_denials: [],
          uuid: 'uuid-result',
          session_id: 'compact-turn',
        };
      };
    }

    it('does not call a successful /compact turn a crash, and still renders the boundary', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(compactStream('manual')())
      );

      agentManager.ensureSession('compact-ok', { permissionMode: 'default' });
      const events: StreamEvent[] = [];
      for await (const event of agentManager.executeCommandIntent('compact-ok', 'compact', {
        cwd: '/mock',
      })) {
        events.push(event);
      }

      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      const boundary = events.find((e) => e.type === 'compact_boundary');
      expect(boundary).toBeDefined();
      expect(boundary!.data).toEqual({
        trigger: 'manual',
        preTokens: 38234,
        postTokens: 3035,
        durationMs: 19707,
      });
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    it('still reports a silent turn when the compaction was automatic', async () => {
      // An auto boundary is incidental: context pressure fired while the person
      // was waiting on an answer to something else, so a turn that compacts and
      // then says nothing still owes them one.
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(compactStream('auto')())
      );

      agentManager.ensureSession('compact-auto', { permissionMode: 'default' });
      const events: StreamEvent[] = [];
      for await (const event of agentManager.sendMessage('compact-auto', 'summarise the repo')) {
        events.push(event);
      }

      expect(events.find((e) => e.type === 'compact_boundary')).toBeDefined();
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as Record<string, unknown>).message).toContain('did not respond');
    });

    it('lets a failed compaction report its own reason, and nothing vaguer', async () => {
      // A compaction that cannot run fires NO boundary — just the resolving
      // status, which the mapper turns into `operation_progress` failed with the
      // reason. That is neither content nor a typed `error`, so the turn used to
      // collect a second verdict on top: "The agent did not respond. The service
      // may be temporarily unavailable." — vaguer than the reason already on
      // screen, and wrong about the cause.
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          (async function* () {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'compact-fail',
              tools: [],
              mcp_servers: [],
              model: 'test',
              permissionMode: 'default',
              slash_commands: ['/compact'],
              output_style: 'text',
              skills: [],
              plugins: [],
              cwd: '/test',
              apiKeySource: 'user',
              uuid: 'uuid-init',
            };
            yield {
              type: 'system',
              subtype: 'status',
              status: 'compacting',
              session_id: 'compact-fail',
              uuid: 'uuid-compacting',
            };
            yield {
              type: 'system',
              subtype: 'status',
              // The resolving status clears `status` and carries the result.
              status: null,
              compact_result: 'failed',
              compact_error: 'context too large to summarize',
              session_id: 'compact-fail',
              uuid: 'uuid-compact-failed',
            };
            yield {
              type: 'result',
              subtype: 'success',
              duration_ms: 1_200,
              duration_api_ms: 1_100,
              is_error: false,
              num_turns: 1,
              result: '',
              stop_reason: 'end_turn',
              total_cost_usd: 0.001,
              usage: { input_tokens: 10, output_tokens: 5 },
              modelUsage: {},
              permission_denials: [],
              uuid: 'uuid-result',
              session_id: 'compact-fail',
            };
          })()
        )
      );

      agentManager.ensureSession('compact-fail', { permissionMode: 'default' });
      const events: StreamEvent[] = [];
      for await (const event of agentManager.executeCommandIntent('compact-fail', 'compact', {
        cwd: '/mock',
      })) {
        events.push(event);
      }

      const failure = events.filter(
        (e) => e.type === 'operation_progress' && (e.data as { state?: string }).state === 'failed'
      );
      expect(failure).toHaveLength(1);
      expect(failure[0]!.data).toMatchObject({
        operation: 'compaction',
        error: 'context too large to summarize',
      });
      // The only verdict. No generic error piled on top of the specific one.
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    // DOR-1240. An MCP elicitation reaches the SDK consumer via the
    // `onElicitation` option the launch resolver registers — real
    // `interactive-handlers.ts` code, which pushes an `elicitation_prompt`
    // event straight onto `session.eventQueue` and holds its returned promise
    // open until a person answers. Nobody answers here, mirroring the module's
    // own reachability note: the underlying CLI is expected to stay blocked on
    // that promise, so a stream that closes with nothing but the prompt is
    // exactly the shape the guard has to tell apart from real silence, not a
    // shape today's SDK is expected to produce on its own.
    it('does not call an elicitation-only turn a crash', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      (mockedQuery as ReturnType<typeof vi.fn>).mockImplementation((args: { options: Options }) =>
        wrapSdkQuery(
          (async function* () {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'elicit-only',
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
              uuid: 'uuid-init',
            };
            // Fire the callback without awaiting its promise — nothing in this
            // test ever answers it, matching an elicitation left pending.
            void args.options.onElicitation?.(
              { serverName: 'test-server', message: 'Which environment?' },
              { signal: new AbortController().signal }
            );
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
              uuid: 'uuid-result',
              session_id: 'elicit-only',
            };
          })()
        )
      );

      agentManager.ensureSession('elicit-only', { permissionMode: 'default' });
      const events: StreamEvent[] = [];
      for await (const event of agentManager.sendMessage('elicit-only', 'hello')) {
        events.push(event);
      }

      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect(events.find((e) => e.type === 'elicitation_prompt')).toBeDefined();
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    it('retries resume failure once then surfaces error on second failure', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();

      // Both calls throw 'session not found' — a genuine resume failure
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
        wrapSdkQuery(
          // eslint-disable-next-line require-yield -- simulates an SDK query that throws before yielding
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
      const { validateBoundaryOrDorkHome } = await import('../../../../lib/boundary.js');
      const { BoundaryError } = await import('../../../../lib/boundary.js');

      // The turn cwd is validated through the DorkHome-aware seam; make it reject.
      (validateBoundaryOrDorkHome as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
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

  describe('executeCommandIntent()', () => {
    /** Stub sendMessage with an empty turn so only the composed prompt matters. */
    function spySend() {
      return vi
        .spyOn(agentManager, 'sendMessage')
        .mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
          // No events — the assertion is on the composed prompt.
        });
    }

    /** Drain an async generator to completion. */
    async function drain(gen: AsyncGenerator<unknown>) {
      for await (const _ of gen) {
        // events discarded — the assertion is on the sendMessage call
      }
    }

    it('sends the bare /compact when no instructions are supplied', async () => {
      // The intent wraps the shipped /compact mechanism verbatim (DOR-109).
      const sendSpy = spySend();
      await drain(agentManager.executeCommandIntent('s1', 'compact', { cwd: '/mock' }));
      expect(sendSpy).toHaveBeenCalledWith(
        's1',
        '/compact',
        expect.objectContaining({ cwd: '/mock' })
      );
    });

    it('appends trailing instructions to /compact so they reach the CLI verbatim', async () => {
      // `/compact <instructions>` reached the CLI verbatim pre-DOR-109; the
      // intent path must preserve that (review Important 1).
      const sendSpy = spySend();
      await drain(
        agentManager.executeCommandIntent('s1', 'compact', {
          cwd: '/mock',
          instructions: 'focus on the API changes',
        })
      );
      expect(sendSpy).toHaveBeenCalledWith(
        's1',
        '/compact focus on the API changes',
        expect.anything()
      );
    });

    it('treats whitespace-only instructions as absent (bare /compact)', async () => {
      const sendSpy = spySend();
      await drain(
        agentManager.executeCommandIntent('s1', 'compact', { cwd: '/mock', instructions: '   ' })
      );
      expect(sendSpy).toHaveBeenCalledWith('s1', '/compact', expect.anything());
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

  describe('getSessionWarmth() / reapSession()', () => {
    // Purpose: the honest answer for a runtime that holds no warm process —
    // which is every server today, since nothing launches a pump until the
    // per-session opt-in (task 3.8). A session it has never heard of is cold.
    it('reports cold for any session, warm processes not being wired yet', () => {
      agentManager.ensureSession('s1', { permissionMode: 'default' });
      expect(agentManager.getSessionWarmth?.('s1')).toBe('cold');
      expect(agentManager.getSessionWarmth?.('never-seen')).toBe('cold');
    });

    // Purpose: reapSession's callers are timers and sweeps. Asking about a
    // session with no process must be free, silent, and repeatable.
    it('reapSession is idempotent and a no-op when cold', async () => {
      await expect(agentManager.reapSession?.('s1')).resolves.toBeUndefined();
      await expect(agentManager.reapSession?.('s1')).resolves.toBeUndefined();
      expect(agentManager.getSessionWarmth?.('s1')).toBe('cold');
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

    // I1 fix (chat-stream-reconnection): an evicted session's projector is
    // dropped so the registry Map does not grow forever, and an in-flight turn
    // is finalized `interrupted` first (no phantom `streaming` post-restart).
    it('marks an in-flight turn interrupted and disposes the projector on eviction', async () => {
      // Import the projector from the SAME module graph the runtime uses
      // (vi.resetModules() in beforeEach gives each test a fresh singleton).
      const { getOrCreateProjector, peekProjector } =
        await import('../../../session/session-state-projector.js');

      agentManager.ensureSession('stale', { permissionMode: 'default' });
      const projector = getOrCreateProjector('stale');
      projector.ingest({ type: 'turn_start' });
      expect(projector.getStatus().lifecycle).toBe('streaming');

      vi.useFakeTimers();
      vi.advanceTimersByTime(31 * 60 * 1000);
      agentManager.checkSessionHealth();
      vi.useRealTimers();

      // Finalized interrupted before disposal…
      expect(projector.getStatus().lifecycle).toBe('interrupted');
      // …and dropped from the registry (a fresh peek returns undefined).
      expect(peekProjector('stale')).toBeUndefined();
    });

    // SRV-I2 (branch review): rekeyProjector moves a brand-new session's
    // projector from the request UUID to the canonical id mid-first-turn, while
    // the store entry stays keyed by the UUID. Eviction disposing by store keys
    // alone missed every rekeyed projector — a permanent projector+EventLog
    // leak per new session, and markInterrupted was skipped.
    it('disposes a REKEYED projector on eviction (registry keyed by canonical id, store by UUID)', async () => {
      const { getOrCreateProjector, peekProjector, rekeyProjector } =
        await import('../../../session/session-state-projector.js');

      agentManager.ensureSession('uuid-evict', { permissionMode: 'default' });
      const projector = getOrCreateProjector('uuid-evict');
      projector.ingest({ type: 'turn_start' });

      // What the trigger path does when the SDK assigns the canonical id
      // mid-turn: record it on the store entry and re-key the projector.
      const store = (
        agentManager as unknown as {
          sessionStore: { findSession(id: string): { sdkSessionId: string } | undefined };
        }
      ).sessionStore;
      store.findSession('uuid-evict')!.sdkSessionId = 'canonical-evict';
      rekeyProjector('uuid-evict', 'canonical-evict');
      expect(peekProjector('canonical-evict')).toBe(projector);
      expect(peekProjector('uuid-evict')).toBeUndefined();

      vi.useFakeTimers();
      vi.advanceTimersByTime(31 * 60 * 1000);
      agentManager.checkSessionHealth();
      vi.useRealTimers();

      // The rekeyed projector was finalized interrupted and dropped — eviction
      // followed the canonical alias, not just the store key.
      expect(projector.getStatus().lifecycle).toBe('interrupted');
      expect(peekProjector('canonical-evict')).toBeUndefined();
    });
  });

  describe('sendMessage() tool-group resolution', () => {
    /** SDK mock that yields init + result (minimal successful flow). */
    function mockSuccessFlow() {
      return wrapSdkQuery(sdkSimpleText(''));
    }

    it('calls resolveToolConfig with manifest enabledToolGroups', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tooling/tool-filter.js');

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
      const { buildSystemPromptAppend } = await import('../messaging/context-builder.js');

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

    // Regression guard for DOR-519. The toggles used to feed the SDK's `allowedTools`,
    // which auto-approves the names in it rather than restricting them, and the list
    // was only non-empty once a group was turned OFF. Switching a group off therefore
    // widened the agent's auto-approval. Nothing may put DorkOS tools back on that
    // option: `canUseTool` is the only place allowed to decide what skips a prompt.
    it('never sets allowedTools, not even when a tool group is turned off', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tooling/tool-filter.js');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());
      (readManifest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-id',
        name: 'test',
        enabledToolGroups: { relay: false, tasks: false, mesh: false, adapter: false },
      });
      (resolveToolConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        tasks: false,
        relay: false,
        mesh: false,
        adapter: false,
      });

      agentManager.ensureSession('tf-3', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-3', 'hello')) {
        events.push(event);
      }

      const callArgs = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.options.allowedTools).toBeUndefined();
    });

    it('uses global config defaults when no agent manifest exists', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const { readManifest } = await import('@dorkos/shared/manifest');
      const { resolveToolConfig } = await import('../tooling/tool-filter.js');

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

  describe('refreshActivatedPlugins() command propagation (UX-12)', () => {
    beforeEach(() => {
      _mockBroadcast.mockClear();
      _mockListEnabledPluginNames.mockResolvedValue([]);
      _mockBuildPluginsArray.mockResolvedValue([]);
    });

    it('broadcasts commands_changed so clients re-fetch the registry', async () => {
      await agentManager.refreshActivatedPlugins();

      expect(_mockBroadcast).toHaveBeenCalledWith(
        'commands_changed',
        expect.objectContaining({ changedAt: expect.any(String) })
      );
    });

    it('hot-reloads live sessions and replaces their cached command list', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      // Establish a session with a query (preserved as lastQuery after the turn).
      const queryResult = wrapSdkQuery(sdkSimpleText(''));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);
      agentManager.ensureSession('reload-1', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('reload-1', 'hello')) {
        // drain
      }

      // The newly-installed plugin reports a fresh command via reload_plugins.
      queryResult.reloadPlugins.mockResolvedValue({
        commands: [
          { name: '/flow:execute', description: 'Run the execute stage', argumentHint: '' },
        ],
        agents: null,
        plugins: [{ name: 'flow', path: '/p' }],
        mcpServers: [],
        error_count: 0,
      });

      await agentManager.refreshActivatedPlugins();

      // reload_plugins was round-tripped on the live (last) query...
      expect(queryResult.reloadPlugins).toHaveBeenCalledTimes(1);
      // ...and the new command now surfaces from the cache without a fresh turn.
      const result = await agentManager.getCommands();
      expect(result.commands.map((c) => c.fullCommand)).toContain('/flow:execute');
      // ...and clients were told to re-fetch.
      expect(_mockBroadcast).toHaveBeenCalledWith('commands_changed', expect.any(Object));
    });

    it('broadcasts even when there are no live sessions to hot-reload', async () => {
      // No sendMessage → no reloadable session. The broadcast must still fire so
      // a cold-cache palette re-fetches and the filesystem/next-query path wins.
      await agentManager.refreshActivatedPlugins();
      expect(_mockBroadcast).toHaveBeenCalledTimes(1);
    });

    it('does not throw when a session hot-reload fails', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryResult = wrapSdkQuery(sdkSimpleText(''));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);
      agentManager.ensureSession('reload-fail', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('reload-fail', 'hello')) {
        // drain
      }

      queryResult.reloadPlugins.mockRejectedValue(new Error('subprocess gone'));

      await expect(agentManager.refreshActivatedPlugins()).resolves.toBeUndefined();
      // The broadcast still fires so other clients/sessions can re-sync.
      expect(_mockBroadcast).toHaveBeenCalledWith('commands_changed', expect.any(Object));
    });
  });

  describe('getCommands() warm-on-open (cold-cache plugin discovery)', () => {
    /** Populate the private activated-plugins list as if a plugin were installed. */
    function setInstalledPlugin() {
      (
        agentManager as unknown as { activatedPlugins: Array<{ type: 'local'; path: string }> }
      ).activatedPlugins = [{ type: 'local', path: '/dork/plugins/flow' }];
    }

    // Warm probes call createIdlePrompt(); give it a default that yields nothing
    // and a spy-able close, so tests can assert the subprocess teardown.
    beforeEach(() => {
      _mockCreateIdlePrompt.mockReset();
      _mockCreateIdlePrompt.mockImplementation(() => ({
        prompt: (async function* () {
          yield* [];
        })(),
        close: vi.fn(),
      }));
    });

    it('probes for plugin commands via an idle (no-turn) query when a plugin is installed and the cache is cold', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockResolvedValue([
        { name: '/flow:capture', description: 'Capture', argumentHint: '' },
        { name: '/flow:triage', description: 'Triage', argumentHint: '' },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const cwd = '/tmp/dorkos-warm-cold';
      // The cold read returns the filesystem set now, but kicks off the probe.
      await agentManager.getCommands(false, cwd);
      expect(mockedQuery).toHaveBeenCalled();

      // Once the probe resolves, the plugin commands surface — no turn was run,
      // so `supportedCommands()` came from the idle probe, not a message.
      await vi.waitFor(async () => {
        const result = await agentManager.getCommands(false, cwd);
        expect(result.commands.map((c) => c.fullCommand)).toEqual(
          expect.arrayContaining(['/flow:capture', '/flow:triage'])
        );
      });
      expect(probe.supportedCommands).toHaveBeenCalled();
    });

    it('does not probe when no plugin is installed (filesystem scan already covers it)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      (agentManager as unknown as { activatedPlugins: unknown[] }).activatedPlugins = [];

      await agentManager.getCommands(false, '/tmp/dorkos-warm-noplugins');
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it('does not re-probe once the cache is warm', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockResolvedValue([
        { name: '/flow:capture', description: 'Capture', argumentHint: '' },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const cwd = '/tmp/dorkos-warm-once';
      await agentManager.getCommands(false, cwd);
      await vi.waitFor(async () => {
        const r = await agentManager.getCommands(false, cwd);
        expect(r.commands).toHaveLength(1);
      });
      const callsAfterWarm = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      // Cache is warm now → further reads must not spawn another probe.
      await agentManager.getCommands(false, cwd);
      expect((mockedQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterWarm);
    });

    it('closes the idle probe even when supportedCommands() rejects (teardown runs)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const closeSpy = vi.fn();
      _mockCreateIdlePrompt.mockReturnValueOnce({
        prompt: (async function* () {
          yield* [];
        })(),
        close: closeSpy,
      });
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockRejectedValue(new Error('subprocess boot failed'));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      // The probe rejects, but the finally must still close BOTH the query
      // (Query.close() kills the CLI child — closing stdin alone doesn't) and the
      // held prompt (releases stdin) so no subprocess leaks.
      await agentManager.getCommands(false, '/tmp/dorkos-warm-teardown');
      await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));
      expect(probe.close).toHaveBeenCalledTimes(1);
    });

    it('closes the probe query on the success path too (kills the CLI child)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockResolvedValue([
        { name: '/flow:capture', description: 'Capture', argumentHint: '' },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const cwd = '/tmp/dorkos-warm-success-close';
      await agentManager.getCommands(false, cwd);
      await vi.waitFor(() => expect(probe.supportedCommands).toHaveBeenCalled());
      // Query.close() must run even when the probe succeeds — matches
      // RuntimeCache.warmup(), which closes the query after supportedModels().
      await vi.waitFor(() => expect(probe.close).toHaveBeenCalledTimes(1));
    });

    it('does not re-probe within the failure cooldown after a failed warm', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockRejectedValue(new Error('boot failed'));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const cwd = '/tmp/dorkos-warm-cooldown';
      await agentManager.getCommands(false, cwd);
      await vi.waitFor(() => expect(probe.supportedCommands).toHaveBeenCalledTimes(1));
      const callsAfterFail = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      // A cold read within the cooldown must NOT spawn a fresh probe — retrying a
      // presumed-broken SDK on every read would storm it with timeout-long boots.
      await agentManager.getCommands(false, cwd);
      expect((mockedQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFail);
    });

    it('writes the warm result as PROVISIONAL so the first real message re-fetches (finding #4)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      // Warm probe reports a partial (MCP-less) command set.
      probe.supportedCommands.mockResolvedValue([
        { name: '/flow:capture', description: 'Capture', argumentHint: '' },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const cwd = '/tmp/dorkos-warm-provisional';
      await agentManager.getCommands(false, cwd);
      // Palette populates immediately from the warm probe…
      await vi.waitFor(async () => {
        const r = await agentManager.getCommands(false, cwd);
        expect(r.commands.map((c) => c.fullCommand)).toContain('/flow:capture');
      });

      // …but the cache entry is provisional, so a real message must still fetch
      // the authoritative, MCP-inclusive list rather than trust the warm write.
      const cache = (
        agentManager as unknown as {
          cache: { isSdkCommandsProvisional(cwd: string): boolean };
        }
      ).cache;
      expect(cache.isSdkCommandsProvisional(cwd)).toBe(true);
    });

    it('prunes warmFailedAt entries past the cooldown when a new failure is recorded (finding #10)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const probe = wrapSdkQuery(sdkSimpleText(''));
      probe.supportedCommands.mockRejectedValue(new Error('boot failed'));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(probe);
      setInstalledPlugin();

      const warmFailedAt = (agentManager as unknown as { warmFailedAt: Map<string, number> })
        .warmFailedAt;

      // Seed a stale entry (well past the 60s cooldown) for a cwd that will not
      // be re-probed. Prune-on-add must evict it when a fresh failure lands.
      warmFailedAt.set('/tmp/dorkos-warm-stale', Date.now() - 10 * 60 * 1000);

      await agentManager.getCommands(false, '/tmp/dorkos-warm-prune');
      await vi.waitFor(() => expect(warmFailedAt.has('/tmp/dorkos-warm-prune')).toBe(true));

      // The stale entry was pruned on the new failure; only the fresh one remains.
      expect(warmFailedAt.has('/tmp/dorkos-warm-stale')).toBe(false);
    });
  });
});
