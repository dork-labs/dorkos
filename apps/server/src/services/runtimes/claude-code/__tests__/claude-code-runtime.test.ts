import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { readManifest } from '@dorkos/shared/manifest';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import { wrapSdkQuery, sdkSimpleText } from './sdk-scenarios.js';
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';
import { SESSIONS } from '../../../../config/constants.js';
import {
  PLUGIN_RELOAD_CEILING_MS,
  PLUGIN_RELOAD_RECHECK_MS,
  PLUGIN_RELOAD_SILENT_TOKENS,
} from '../messaging/plugin-reload-policy.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { registerEveryFolderAsHome } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

// The secrets the spawn env must never carry are present BEFORE the static
// imports below load `env.ts`, which parses `process.env` once at module load.
// The graph used to be re-imported after `beforeEach` stubbed them; this keeps
// that load-time view identical now that it loads once (DOR-4190). The per-test
// stubs in `beforeEach` are what each spawn actually reads.
vi.hoisted(() => {
  vi.stubEnv('MCP_API_KEY', 'synthetic-server-token');
  vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-nango-key');
  vi.stubEnv('DO_NOT_TRACK', '1');
});

// Hoist shared mock functions so the test and ClaudeCodeRuntime share the same
// vi.fn() instances for context-builder.
const { _mockBuildSystemPromptAppend, _mockRenderContextEntry, contextBuilderFactory } = vi.hoisted(
  () => {
    const bspa = vi.fn().mockResolvedValue({
      text: '<env>\nWorking directory: /mock\n</env>',
      stable: '<env>\nWorking directory: /mock\n</env>',
    });
    const render = vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`);
    return {
      _mockBuildSystemPromptAppend: bspa,
      _mockRenderContextEntry: render,
      contextBuilderFactory: () => ({
        buildSystemPromptAppend: bspa,
        renderContextEntry: render,
      }),
    };
  }
);

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
// Mock createIdlePrompt so the warm-probe teardown (close on the held prompt)
// can be spied; resolveClaudeCliPath is preserved for the runtime constructor.
// `_binary` also steers the two resolvers the runtime spawns through, so a test
// can say "nothing resolved at boot, then a one-click install landed one".
const { _mockCreateIdlePrompt, _binary } = vi.hoisted(() => ({
  _mockCreateIdlePrompt: vi.fn(),
  _binary: { atBoot: undefined as string | undefined, beforePath: null as string | null },
}));
vi.mock('../sdk/sdk-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sdk/sdk-utils.js')>()),
  createIdlePrompt: _mockCreateIdlePrompt,
  resolveClaudeCliPath: () => _binary.atBoot,
  resolveClaudeBinaryBeforePath: () => _binary.beforePath,
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
const { _mockListEnabledPluginNames, _mockListConsentedPluginNames, _mockBuildPluginsArray } =
  vi.hoisted(() => ({
    _mockListEnabledPluginNames: vi.fn().mockResolvedValue([]),
    _mockListConsentedPluginNames: vi.fn().mockResolvedValue([]),
    _mockBuildPluginsArray: vi.fn().mockResolvedValue([]),
  }));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-test'),
}));
vi.mock('../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: _mockListEnabledPluginNames,
}));
// Which global packages a person approved is decided in the marketplace layer
// (DOR-2306); the runtime must hand the SDK that list and nothing wider.
vi.mock('../../../marketplace/consent/global-plugin-consent.js', () => ({
  listConsentedPluginNames: _mockListConsentedPluginNames,
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: _mockBuildPluginsArray,
}));

describe('ClaudeCodeRuntime', () => {
  let agentManager: ClaudeCodeRuntime;
  let settingsOwner: RuntimeRegistry;
  let settingsDb: ReturnType<typeof createTestDb> | undefined;

  // The module graph is loaded ONCE for the file and each test gets a new
  // runtime (DOR-4190). It used to `vi.resetModules()` and re-import the runtime
  // before every test, which was most of this file's run time. Nothing a test
  // asserts depends on module state read at import: the env stubs below are
  // read per spawn, not at load (the afterEach proves it on every call), and
  // what a test mutates on a module-level mock is put back here.
  beforeEach(() => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/mock/claude-code-test-account');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
      vi.stubEnv(key, '');
    vi.stubEnv('MCP_API_KEY', 'synthetic-server-token');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-nango-key');
    vi.stubEnv('DO_NOT_TRACK', '1');
    // A fresh graph minted these two mocks fresh. `query` carries each test's
    // scripted turn and its call log, which the env-secret check below reads,
    // so it must start empty; `readManifest` is set to throw by one test.
    vi.mocked(query).mockReset();
    vi.mocked(readManifest).mockReset().mockResolvedValue(null);
    agentManager = new ClaudeCodeRuntime('/tmp/dorkos-test');
    settingsOwner = new RuntimeRegistry();
    settingsDb = createTestDb();
    settingsOwner.setDb(settingsDb);
    agentManager.setSessionSettings(settingsOwner);
    // Every scratch folder counts as a registered home here, so this suite's
    // mocked mesh decides who is an agent, as it did before homes (DOR-2355).
    registerEveryFolderAsHome();
  });

  afterEach(async () => {
    try {
      // Every spawn THIS test made (the log is cleared in beforeEach).
      for (const [args] of vi.mocked(query).mock.calls) {
        expect(args.options?.env).toBeDefined();
        expect(args.options?.env).not.toHaveProperty('MCP_API_KEY');
        expect(args.options?.env).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
        expect(args.options?.env?.DO_NOT_TRACK).toBe('1');
      }
    } finally {
      vi.unstubAllEnvs();
      settingsDb?.$client.close();
      settingsDb = undefined;
    }
  });

  // DOR-1334 review, MUST-FIX 1. The requirements ladder and the SDK spawn seam
  // are one ladder now, but the runtime resolved it ONCE at construction — so a
  // successful "Install Claude" flipped the card to Ready while every session
  // started afterwards still spawned with no executable path and the SDK threw,
  // until somebody restarted the server.
  describe('the binary a spawn is pointed at', () => {
    /** Drive one full turn and hand back the options the SDK was called with. */
    async function turnOptions(
      runtime: ClaudeCodeRuntime,
      sessionId: string
    ): Promise<Record<string, unknown>> {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(sdkSimpleText('ok')));
      runtime.ensureSession(sessionId, { permissionMode: 'default' });
      for await (const event of runtime.sendMessage(sessionId, 'hello')) void event;
      const lastCall = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      return (lastCall[0] as { options: Record<string, unknown> }).options;
    }

    it('picks up a binary that only appeared after startup (a one-click install)', async () => {
      // Boot on a host with no `claude` anywhere.
      _binary.atBoot = undefined;
      _binary.beforePath = null;
      const runtime = new ClaudeCodeRuntime('/tmp/dorkos-test');
      runtime.setSessionSettings(settingsOwner);

      const before = await turnOptions(runtime, 'no-binary');
      expect(before.pathToClaudeCodeExecutable).toBeUndefined();

      // The provisioner installs one — the same rung `resolveClaudeBinaryBeforePath`
      // reports, which is what the requirements payload just re-walked.
      _binary.beforePath = '/dork-home/runtimes/claude-code/claude';

      const after = await turnOptions(runtime, 'after-install');
      expect(after.pathToClaudeCodeExecutable).toBe('/dork-home/runtimes/claude-code/claude');
    });
  });

  describe('sendMessage()', () => {
    it('holds a turn unattended only while that turn runs', async () => {
      // An automatic carry-over's first turn has nobody to ask; a person's next
      // message in the same session must be able to ask them again.
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const seen: (boolean | undefined)[] = [];
      agentManager.setMcpServerFactory((session) => {
        seen.push((session as { unattendedTurn?: boolean }).unattendedTurn);
        return {};
      });
      (mockedQuery as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(wrapSdkQuery(sdkSimpleText('first')))
        .mockReturnValueOnce(wrapSdkQuery(sdkSimpleText('second')));

      agentManager.ensureSession('carried', { permissionMode: 'default' });
      for await (const event of agentManager.sendMessage('carried', 'go on', { unattended: true }))
        void event;
      for await (const event of agentManager.sendMessage('carried', 'thanks, one more thing'))
        void event;

      expect(seen).toEqual([true, false]);
    });

    it.each(['hello', '  /help'])(
      'opens lazily and keeps slash commands free of Accounts context: %s',
      async (content) => {
        _mockRenderContextEntry.mockClear();
        const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
        const proof = { claims: { kind: 'runtime' } } as ServerPrincipalProof;
        const principals: ConnectorRuntimePrincipalPort = {
          openTurn: vi.fn().mockResolvedValue({
            bindingId: 'binding-1',
            bearer: 'turn-secret',
            expiresAt: '2099-01-01T00:00:00.000Z',
            renewalPermit: {} as never,
          }),
          renew: vi.fn(),
          resolve: vi.fn().mockResolvedValue({ status: 'resolved', principal: proof }),
          revoke: vi.fn().mockResolvedValue(undefined),
        };
        agentManager.setMeshCore({
          getByPath: () => ({ id: 'agent-1', name: 'agent' }),
          listWithPaths: () => [],
          updateLastSeen: () => undefined,
        });
        const accessSnapshot = vi
          .fn()
          .mockResolvedValue({ accountCount: 1, revision: 'private-revision' });
        agentManager.setConnectorRuntimeTools({
          principals,
          listenerUrl: 'http://127.0.0.1:4341/mcp',
          isConnectorCapabilityId: (id) => id === 'connectors.execute_read',
          accessSnapshot,
        });

        let connectorTurn: { resolvePrincipal(): Promise<ServerPrincipalProof> } | undefined;
        agentManager.setMcpServerFactory((session) => {
          connectorTurn = session.connectorTurn;
          return {};
        });
        const source = sdkSimpleText('ok', 'canonical-claude-session');
        (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
          wrapSdkQuery(
            (async function* () {
              for await (const message of source) {
                yield message;
                if (message.type === 'system' && message.subtype === 'init') {
                  await connectorTurn?.resolvePrincipal();
                }
              }
            })()
          )
        );

        agentManager.ensureSession('requested-session', { permissionMode: 'default' });
        for await (const event of agentManager.sendMessage('requested-session', content))
          void event;

        const entries = _mockRenderContextEntry.mock.calls.map((call) => call[0]);
        if (content.trimStart().startsWith('/')) {
          expect(accessSnapshot).not.toHaveBeenCalled();
          expect(entries.some((entry) => entry.kind === 'accounts_access')).toBe(false);
        } else {
          expect(accessSnapshot).toHaveBeenCalledOnce();
          expect(entries).toContainEqual({
            kind: 'accounts_access',
            scope: 'per-turn',
            data: { accountCount: 1, changed: false, serviceCatalog: true },
          });
        }

        expect(principals.openTurn).toHaveBeenCalledWith(
          {
            runtime: 'claude-code',
            canonicalSessionId: 'canonical-claude-session',
            agentPath: DEFAULT_CWD,
            canonicalCwd: DEFAULT_CWD,
            signal: expect.any(AbortSignal),
          },
          { isCurrent: expect.any(Function), readToolTurn: expect.any(Function) }
        );
        expect(principals.resolve).toHaveBeenCalledWith({
          bearer: 'turn-secret',
          expectedRuntime: 'claude-code',
          expectedCanonicalCwd: DEFAULT_CWD,
        });
        expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_terminal');
      }
    );

    describe('which agent a room turn opens its connections as (DOR-2091)', () => {
      // A room turn names the agent it is for. The connections binding is opened
      // for the agent the directory anchors to, and only when that is the
      // turn's agent — a turn for Ben that stands in Ana's folder must never
      // open Ana's connections. Seeded: `agentPath = cwdKey` (no anchor, no
      // cross-check) reddens the refusal row.
      const ANA = '/agents/ana';

      async function turnFor(cwd: string, forAgent: string) {
        const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
        const principals: ConnectorRuntimePrincipalPort = {
          openTurn: vi.fn().mockResolvedValue({
            bindingId: 'binding-1',
            bearer: 'turn-secret',
            expiresAt: '2099-01-01T00:00:00.000Z',
            renewalPermit: {} as never,
          }),
          renew: vi.fn(),
          resolve: vi.fn().mockResolvedValue({
            status: 'resolved',
            principal: { claims: { kind: 'runtime' } } as ServerPrincipalProof,
          }),
          revoke: vi.fn().mockResolvedValue(undefined),
        };
        agentManager.setMeshCore({
          getByPath: (p: string) => (p === ANA ? { id: 'agent-ana', name: 'ana' } : undefined),
          listWithPaths: () => [],
          updateLastSeen: () => undefined,
        });
        agentManager.setConnectorRuntimeTools({
          principals,
          listenerUrl: 'http://127.0.0.1:4341/mcp',
          isConnectorCapabilityId: (id) => id === 'connectors.execute_read',
          accessSnapshot: vi.fn().mockResolvedValue({ accountCount: 0, revision: 'r' }),
        });
        let connectorTurn: { resolvePrincipal(): Promise<ServerPrincipalProof> } | undefined;
        agentManager.setMcpServerFactory((session) => {
          connectorTurn = session.connectorTurn;
          return {};
        });
        const source = sdkSimpleText('ok', 'canonical-room-session');
        (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
          wrapSdkQuery(
            (async function* () {
              for await (const message of source) {
                yield message;
                if (message.type === 'system' && message.subtype === 'init') {
                  await connectorTurn?.resolvePrincipal();
                }
              }
            })()
          )
        );
        agentManager.ensureSession('room-session', { permissionMode: 'default', cwd });
        for await (const event of agentManager.sendMessage('room-session', 'hi', {
          cwd,
          roomTurn: { roomId: '01ROOM', authorId: 'a-1', turnId: 't-1', cwd, agentPath: forAgent },
        }))
          void event;
        return { principals, connectorTurn };
      }

      it('opens the connections as the agent, standing in its home', async () => {
        // A room turn stands at home (spec `agent-home-desk` §5.1).
        const { principals } = await turnFor(ANA, ANA);

        expect(principals.openTurn).toHaveBeenCalledWith(
          expect.objectContaining({ agentPath: ANA, canonicalCwd: ANA }),
          expect.anything()
        );
      });

      it("opens nothing for a turn for Ben that stands in Ana's own folder", async () => {
        const { principals, connectorTurn } = await turnFor(ANA, '/agents/ben');

        expect(connectorTurn).toBeUndefined();
        expect(principals.openTurn).not.toHaveBeenCalled();
      });
    });

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
        endedAt: expect.any(Number),
      });
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    // DOR-2838. A chat set to "Never ask" launches the SDK in `dontAsk`, and the
    // two callbacks the launch registers refuse rather than put anything to a
    // person: a tool call is denied and an MCP server's request is declined.
    it('launches Never ask as dontAsk and refuses through both callbacks', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
      let launched: Options | undefined;
      let tool: unknown;
      let elicitation: unknown;
      (mockedQuery as ReturnType<typeof vi.fn>).mockImplementation((args: { options: Options }) =>
        wrapSdkQuery(
          (async function* () {
            launched = args.options;
            tool = await args.options.canUseTool?.('Bash', { command: 'ls' }, {
              signal: new AbortController().signal,
              toolUseID: 'never-1',
            } as never);
            elicitation = await args.options.onElicitation?.(
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
              session_id: 'never-ask',
            };
          })()
        )
      );

      agentManager.ensureSession('never-ask', { permissionMode: 'dontAsk' });
      const events: StreamEvent[] = [];
      for await (const event of agentManager.sendMessage('never-ask', 'hello')) {
        events.push(event);
      }

      expect(launched?.permissionMode).toBe('dontAsk');
      expect(tool).toMatchObject({ behavior: 'deny' });
      expect(elicitation).toEqual({ action: 'decline' });
      expect(events.find((e) => e.type === 'approval_required')).toBeUndefined();
      expect(events.find((e) => e.type === 'elicitation_prompt')).toBeUndefined();
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

  describe('isTurnOpen()', () => {
    it('reports a turn the server never dispatched — a relay-style direct send — until it ends (DOR-2732)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The SDK streams its first message, then the turn stays open until released.
      async function* heldTurn() {
        const messages = sdkSimpleText('ok');
        const first = await messages.next();
        if (!first.done) yield first.value;
        await hold;
        yield* messages;
      }
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(heldTurn()));
      agentManager.ensureSession('relay-1', { permissionMode: 'default' });
      expect(agentManager.isTurnOpen('relay-1')).toBe(false);

      const turn = agentManager
        .sendMessage('relay-1', 'from another agent')
        [Symbol.asyncIterator]();
      await turn.next();
      expect(agentManager.isTurnOpen('relay-1')).toBe(true);

      release();
      while (!(await turn.next()).done) {
        // drain
      }
      expect(agentManager.isTurnOpen('relay-1')).toBe(false);
    });
  });

  describe('executeCommandIntent()', () => {
    it('RT-CMP-02: the agent’s own request runs /compact with its note, and the record keeps who asked', async () => {
      // The same module instances this runtime uses: the graph is loaded once
      // for the file, so these are the dispatcher, projector and store it holds.
      const { AgentCompactionService } =
        await import('../../../session/agent-compaction/agent-compaction-service.js');
      const session = await import('../../../session/index.js');
      const { resetMessageDispatcher } = await import('../../../session/message-dispatcher.js');
      const { createTestDb } = await import('@dorkos/test-utils/db');
      const store = new session.SessionEventStore(createTestDb());
      session.setSessionEventStore(store);
      try {
        agentManager.ensureSession('cmp-1', { permissionMode: 'default', cwd: '/mock' });
        const sendSpy = vi
          .spyOn(agentManager, 'sendMessage')
          .mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
            yield {
              type: 'compact_boundary',
              data: { trigger: 'manual', preTokens: 178_000 },
            } as StreamEvent;
            yield { type: 'done', data: {} } as StreamEvent;
          });
        const compaction = new AgentCompactionService({ resolveRuntime: async () => agentManager });

        const outcome = await compaction.request({ sessionId: 'cmp-1', note: 'keep the plan' });
        expect(outcome.status).toBe('scheduled');
        await vi.waitFor(() => expect(store.readAgentCompactions('cmp-1')).toHaveLength(1));

        expect(sendSpy).toHaveBeenCalledWith('cmp-1', '/compact keep the plan', expect.anything());
        // The transcript says a summary happened; the overlay puts back who asked.
        const reopened = session.overlayAgentCompactions('cmp-1', [
          { id: 'c1', role: 'user', content: 'summary', messageType: 'compaction' },
        ]);
        expect(reopened[0]!.compactMetadata).toMatchObject({ requestedBy: 'agent' });
      } finally {
        resetMessageDispatcher();
        session.disposeProjector('cmp-1');
        session.setSessionEventStore(undefined);
      }
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

    // I1 fix (chat-stream-reconnection): an evicted session's projector is
    // dropped so the registry Map does not grow forever, and an in-flight turn
    // is finalized `interrupted` first (no phantom `streaming` post-restart).
    it('marks an in-flight turn interrupted and disposes the projector on eviction', async () => {
      // Import the projector from the SAME module graph the runtime uses. The
      // registry outlives the test (the graph is loaded once), so the session
      // id here is this test's own.
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
      // The UUID redirects onto the same instance — one projector, two names
      // (DOR-1262) — so eviction below must not leave half of it behind.
      expect(peekProjector('uuid-evict')).toBe(projector);

      vi.useFakeTimers();
      vi.advanceTimersByTime(31 * 60 * 1000);
      agentManager.checkSessionHealth();
      vi.useRealTimers();

      // The rekeyed projector was finalized interrupted and dropped — eviction
      // followed the canonical alias, not just the store key.
      expect(projector.getStatus().lifecycle).toBe('interrupted');
      expect(peekProjector('canonical-evict')).toBeUndefined();
      // Both names are gone with it: a redirect must never outlive the projector
      // it points at, or the next lookup under the UUID would resurrect a ghost.
      expect(peekProjector('uuid-evict')).toBeUndefined();
    });
  });

  describe('sendMessage() tool-doc gates', () => {
    /** SDK mock that yields init + result (minimal successful flow). */
    function mockSuccessFlow() {
      return wrapSdkQuery(sdkSimpleText(''));
    }

    it('passes the tool-doc gates to buildSystemPromptAppend', async () => {
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
      expect(typeof callArgs[0]).toBe('string'); // home
      expect(typeof callArgs[1]).toBe('string'); // cwd
      expect(callArgs[2]).toEqual(
        expect.objectContaining({
          tasks: expect.any(Boolean),
          relay: expect.any(Boolean),
          mesh: expect.any(Boolean),
          adapter: expect.any(Boolean),
          packages: expect.any(Boolean),
        })
      );
    });

    // Regression guard for DOR-519. The retired tool-group toggles used to feed the
    // SDK's `allowedTools`, which auto-approves the names in it rather than
    // restricting them. Nothing may put DorkOS tools back on that option:
    // `canUseTool` is the only place allowed to decide what skips a prompt.
    it('never sets allowedTools', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockSuccessFlow());

      agentManager.ensureSession('tf-3', { permissionMode: 'default' });
      const events = [];
      for await (const event of agentManager.sendMessage('tf-3', 'hello')) {
        events.push(event);
      }

      const callArgs = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.options.allowedTools).toBeUndefined();
    });
  });

  describe('getCommands() SDK caching', () => {
    /** SDK mock that yields init + result (minimal successful flow). */
    function mockSuccessFlow() {
      return wrapSdkQuery(sdkSimpleText(''));
    }

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
  });

  describe('refreshActivatedPlugins() command propagation (UX-12)', () => {
    beforeEach(() => {
      _mockBroadcast.mockClear();
      _mockListEnabledPluginNames.mockResolvedValue([]);
      _mockListConsentedPluginNames.mockResolvedValue([]);
      _mockBuildPluginsArray.mockResolvedValue([]);
    });

    it('hands the SDK only the global packages a person approved (DOR-2306)', async () => {
      // Purpose: every installed global package is a candidate, but one whose
      // programs nobody approved must never reach a session.
      _mockListEnabledPluginNames.mockResolvedValue(['approved', 'held-back']);
      _mockListConsentedPluginNames.mockResolvedValue(['approved']);

      await agentManager.refreshActivatedPlugins();

      expect(_mockBuildPluginsArray).toHaveBeenCalledWith(
        expect.objectContaining({ enabledPluginNames: ['approved'] })
      );
    });

    it('drops every global plugin when the approval check itself fails, never keeping the old list (DOR-2306, I-1)', async () => {
      // Purpose: a refresh that cannot say which packages are approved must not
      // leave the previous approved set loading into every session.
      _mockListConsentedPluginNames.mockResolvedValue(['approved']);
      _mockBuildPluginsArray.mockImplementation(async ({ enabledPluginNames }) =>
        (enabledPluginNames as string[]).map((name) => ({
          type: 'local',
          path: `/h/plugins/${name}`,
        }))
      );
      await agentManager.refreshActivatedPlugins();
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const optionsOfLastTurn = async (sessionId: string) => {
        (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(wrapSdkQuery(sdkSimpleText('')));
        agentManager.ensureSession(sessionId, { permissionMode: 'default' });
        for await (const _ of agentManager.sendMessage(sessionId, 'hello')) {
          // drain
        }
        return (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.options;
      };
      expect((await optionsOfLastTurn('partition-ok'))?.plugins).toEqual([
        { type: 'local', path: '/h/plugins/approved' },
      ]);

      _mockListConsentedPluginNames.mockRejectedValue(new Error('settings unreadable'));
      await agentManager.refreshActivatedPlugins();

      expect((await optionsOfLastTurn('partition-threw'))?.plugins ?? []).toEqual([]);
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

    it('reports a reload the CLI never confirmed as a timeout, not as "no query" (DOR-1301)', async () => {
      // `null` is the route's "send a message first" answer. Saying that about a
      // session that HAS a query which did not answer tells the operator to do
      // something they already did, so the timeout must stay distinguishable all
      // the way out to the route.
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      // From the SAME registry the runtime under test was imported from, so
      // `instanceof` checks the class the runtime actually throws.
      const { ControlRequestTimeoutError, PLUGIN_RELOAD_ACK_TIMEOUT_MS } =
        await import('../sessions/bounded-control.js');
      const queryResult = wrapSdkQuery(sdkSimpleText(''));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);
      agentManager.ensureSession('reload-deaf', { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage('reload-deaf', 'hello')) {
        // drain
      }

      queryResult.reloadPlugins.mockImplementation(() => new Promise<never>(() => {}));

      vi.useFakeTimers();
      try {
        const reloading = agentManager.reloadPlugins('reload-deaf');
        const settled = reloading.catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_ACK_TIMEOUT_MS);
        expect(await settled).toBeInstanceOf(ControlRequestTimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('refreshProjectCommands() (DOR-2696)', () => {
    it("drops the project's cached commands and tells clients, reloading no session's plugins", async () => {
      // Purpose: a project dev link's projected command must reach that
      // project's palette; the cached list would otherwise stay stale until a
      // restart, and a session reload would cost a cache rebuild for nothing.
      _mockListConsentedPluginNames.mockResolvedValue([]);
      _mockBuildPluginsArray.mockResolvedValue([]);
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryResult = wrapSdkQuery(sdkSimpleText(''));
      queryResult.supportedCommands.mockResolvedValue([
        { name: '/stale', description: 'From before the projection', argumentHint: '' },
      ]);
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);
      const cwd = process.cwd();
      agentManager.ensureSession('project-cmds', { permissionMode: 'default', cwd });
      for await (const _ of agentManager.sendMessage('project-cmds', 'hello')) {
        // drain
      }
      await vi.waitFor(async () => {
        const result = await agentManager.getCommands(false, cwd);
        expect(result.commands.map((c) => c.fullCommand)).toContain('/stale');
      });
      _mockBroadcast.mockClear();

      agentManager.refreshProjectCommands(cwd);

      const result = await agentManager.getCommands(false, cwd);
      expect(result.commands.map((c) => c.fullCommand)).not.toContain('/stale');
      expect(queryResult.reloadPlugins).not.toHaveBeenCalled();
      expect(_mockBroadcast).toHaveBeenCalledWith(
        'commands_changed',
        expect.objectContaining({ changedAt: expect.any(String) })
      );
    });
  });

  // ===========================================================================
  // What a plugin reload costs, and when it is worth waiting for
  // (spec `plugin-reload-cache-cost`)
  // ===========================================================================

  describe('reloads that respect the prompt cache', () => {
    /** A live session with a query the reload paths will find. */
    async function liveSession(sessionId: string) {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryResult = wrapSdkQuery(sdkSimpleText(''));
      (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(queryResult);
      agentManager.ensureSession(sessionId, { permissionMode: 'default' });
      for await (const _ of agentManager.sendMessage(sessionId, 'hello')) {
        // drain
      }
      return queryResult;
    }

    /** Say how big this session's conversation is, the way a real turn would. */
    function setContextTokens(sessionId: string, cacheReadTokens: number): void {
      const store = (
        agentManager as unknown as {
          sessionStore: {
            findSession(id: string): { lastRequestUsage?: unknown } | undefined;
          };
        }
      ).sessionStore;
      const session = store.findSession(sessionId);
      if (!session) throw new Error(`no session ${sessionId}`);
      session.lastRequestUsage = { inputTokens: 0, cacheReadTokens, cacheCreationTokens: 0 };
    }

    /** The reload response the CLI sends when it refuses to disturb the cache. */
    const HELD = {
      commands: [],
      agents: null,
      plugins: [],
      mcpServers: [],
      error_count: 0,
      held: true,
      cache_impact: {
        mcp_servers_added: ['plugin:flow:linear'],
        mcp_servers_removed: [],
        lsp_tool_change: null,
      },
    };

    beforeEach(() => {
      _mockBroadcast.mockClear();
      _mockListEnabledPluginNames.mockResolvedValue([]);
      _mockBuildPluginsArray.mockResolvedValue([]);
    });

    it('holds a big conversation instead of paying for it', async () => {
      const paid = vi.fn();
      agentManager.setPluginReloadActivity(paid);
      const queryResult = await liveSession('reload-big');
      setContextTokens('reload-big', PLUGIN_RELOAD_SILENT_TOKENS);
      queryResult.reloadPlugins.mockResolvedValue(HELD);

      await agentManager.refreshActivatedPlugins();

      // Asked, and NOT applied. Nothing is recorded until something is paid.
      expect(queryResult.reloadPlugins).toHaveBeenCalledTimes(1);
      expect(paid).not.toHaveBeenCalled();
    });

    it('asks again on a recheck, and records a free reload when the runtime applies one', async () => {
      const paid = vi.fn();
      agentManager.setPluginReloadActivity(paid);
      const queryResult = await liveSession('reload-recheck');
      setContextTokens('reload-recheck', 400_000);
      queryResult.reloadPlugins.mockResolvedValue(HELD);

      vi.useFakeTimers();
      try {
        await agentManager.refreshActivatedPlugins();
        expect(queryResult.reloadPlugins).toHaveBeenCalledTimes(1);

        // Still warm at the first recheck: asked again, nothing applied.
        await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_RECHECK_MS);
        expect(queryResult.reloadPlugins).toHaveBeenCalledTimes(2);
        expect(queryResult.reloadPlugins).toHaveBeenLastCalledWith({ holdOnCacheImpact: true });
        expect(paid).not.toHaveBeenCalled();

        // Now the runtime says it applied it, which is what "free" looks like.
        queryResult.reloadPlugins.mockResolvedValue({
          commands: [],
          agents: null,
          plugins: [],
          mcpServers: [],
          error_count: 0,
          held: false,
        });
        await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_RECHECK_MS);
      } finally {
        vi.useRealTimers();
      }

      expect(paid).toHaveBeenCalledWith(
        expect.objectContaining({ deferred: true, release: 'cache-cold', contextTokens: 400_000 })
      );
    });

    it('applies a hand-triggered reload at once however big the conversation is', async () => {
      const paid = vi.fn();
      agentManager.setPluginReloadActivity(paid);
      const queryResult = await liveSession('reload-hand');
      setContextTokens('reload-hand', 400_000);
      queryResult.reloadPlugins.mockResolvedValue(HELD);
      await agentManager.refreshActivatedPlugins();

      const result = await agentManager.reloadPlugins('reload-hand');

      // Applied unconditionally — no hold option on the hand-triggered call.
      expect(queryResult.reloadPlugins).toHaveBeenLastCalledWith();
      // And the route never learns what it cost.
      expect(result).toEqual({ commandCount: 0, pluginCount: 0, errorCount: 0 });
      expect(paid).toHaveBeenCalledWith(
        expect.objectContaining({ deferred: true, release: 'hand-triggered' })
      );
    });

    it('drops a held reload when the session is evicted, applying nothing', async () => {
      const paid = vi.fn();
      agentManager.setPluginReloadActivity(paid);
      const queryResult = await liveSession('reload-evicted');
      setContextTokens('reload-evicted', 400_000);
      queryResult.reloadPlugins.mockResolvedValue(HELD);

      vi.useFakeTimers();
      let callsWhileHolding: number;
      try {
        await agentManager.refreshActivatedPlugins();
        callsWhileHolding = queryResult.reloadPlugins.mock.calls.length;

        // Age the record past the eviction window and run the sweep that
        // retires it, then let every clock the hold could have been waiting on
        // run out.
        const store = (
          agentManager as unknown as {
            sessionStore: { findSession(id: string): { lastActivity: number } | undefined };
          }
        ).sessionStore;
        const session = store.findSession('reload-evicted');
        if (!session) throw new Error('no session to evict');
        session.lastActivity = Date.now() - SESSIONS.TIMEOUT_MS - 60_000;
        agentManager.checkSessionHealth();

        await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_CEILING_MS * 2);
      } finally {
        vi.useRealTimers();
      }

      expect(callsWhileHolding).toBe(1);
      expect(queryResult.reloadPlugins).toHaveBeenCalledTimes(callsWhileHolding);
      expect(paid).not.toHaveBeenCalled();
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
      // The probe never loads the repo's settings: nothing checked them (DOR-3298).
      const options = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.options;
      expect(options?.settingSources).toEqual(['user']);
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
  });
});
