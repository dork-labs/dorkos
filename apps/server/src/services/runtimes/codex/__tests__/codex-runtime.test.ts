import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { DependencyCheck, SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexRuntime } from '../codex-runtime.js';
import { MAX_CONSECUTIVE_WAKES, WAKE_BUDGET_SPENT_COPY } from '../app-server/background-wake.js';
import { resolveCodexTransport, type CodexTransport } from '../transport/index.js';
import type { BackgroundCompletion, BackgroundWake } from '../app-server/background-work.js';
import { buildCodexOptions } from '../codex-options.js';
import * as logHistory from '../../../session/log-backed-history.js';
import { SessionDiscoveryUnavailableError } from '../../../session/resolution/session-lookup-error.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { CodexThreadMap } from '../thread-map.js';
import { checkCodexDependencies } from '../check-dependencies.js';
import { enumerateCodexMcpServers } from '../enumerate-mcp-servers.js';
import { scanSkillCommands } from '../scan-skill-commands.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import { wrapKickoff, filterKickoffHistory } from '@dorkos/shared/kickoff';
import {
  THREAD_ID,
  codexSimpleTurn,
  codexThreadStarted,
  codexTurnStarted,
  codexItemUpdated,
  codexFailedTurn,
  agentMessageItem,
  makeMockThread,
} from './codex-scenarios.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

const environmentPolicy = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('../../../core/config-manager.js', async () => {
  const { USER_CONFIG_DEFAULTS } = await import('@dorkos/shared/config-schema');
  return {
    configManager: {
      get: (key: keyof typeof USER_CONFIG_DEFAULTS) =>
        key === 'runtimes'
          ? {
              ...USER_CONFIG_DEFAULTS.runtimes,
              environment: {
                inherit: { claudeCode: [], codex: environmentPolicy.names, opencode: [] },
              },
            }
          : USER_CONFIG_DEFAULTS[key],
    },
  };
});

vi.mock('../check-dependencies.js', () => ({
  checkCodexDependencies: vi.fn(),
}));

// MCP enumeration and skill-command scanning are tested in isolation
// (enumerate-mcp-servers.test.ts / scan-skill-commands.test.ts); here we mock
// them to assert how the runtime delegates and caches.
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(),
}));
vi.mock('../scan-skill-commands.js', () => ({
  scanSkillCommands: vi.fn(() => []),
}));

/**
 * Module-level SDK mock. The Codex constructor records its options (the
 * env-gotcha / codexPathOverride assertions) and hands out the shared
 * startThread/resumeThread spies, which each test scripts per scenario.
 */
const nativeMocks = vi.hoisted(() => ({
  findSession: vi.fn().mockResolvedValue(null),
  listSessions: vi.fn().mockResolvedValue([]),
  readHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../native-session-reader.js', () => ({
  CodexNativeSessionReader: class {
    findSession = nativeMocks.findSession;
    listSessions = nativeMocks.listSessions;
    readHistory = nativeMocks.readHistory;
  },
}));

const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread = sdkMocks.startThread;
    resumeThread = sdkMocks.resumeThread;
    constructor(options?: unknown) {
      sdkMocks.constructorOptions.push(options);
    }
  },
}));

const SATISFIED_CHECKS: DependencyCheck[] = [
  {
    name: 'Codex CLI',
    description: 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.',
    status: 'satisfied',
    version: 'codex-cli 0.142.5',
  },
];

const ACCOUNT_MODELS: ModelOption[] = [
  {
    value: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    description: 'Our most capable model for complex, demanding work.',
    isDefault: true,
    provider: 'openai',
  },
  {
    value: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Reliable agentic workhorse for everyday tasks.',
    provider: 'openai',
  },
];

/** Deterministic default-root floor for the turn cwd resolution chain. */
const DEFAULT_ROOT = '/projects/default-root';

/**
 * Fresh runtime + thread map over an isolated in-memory DB. Pass `db` to share
 * one DB across two runtime instances — the simulated-restart setup.
 */
function makeRuntime(opts: { binaryPath?: string | null; db?: Db } = {}) {
  const db = opts.db ?? createTestDb();
  const threadMap = new CodexThreadMap(db);
  const runtime = new CodexRuntime({
    transport: 'exec',
    threadMap,
    // The runtime resolves its binary lazily through this seam (production
    // passes the shared ladder). `/bin/codex` is the ordinary "Codex is
    // installed" host; a test that needs the missing-binary case says so.
    resolveBinary: async () => ('binaryPath' in opts ? opts.binaryPath : '/bin/codex'),
    modelCatalog: { getSupportedModels: async () => ACCOUNT_MODELS },
    defaultCwd: DEFAULT_ROOT,
  });
  return { runtime, threadMap, db };
}

/** Drain a sendMessage generator into an array. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/**
 * A ThreadEvent stream that yields a partial answer and then parks until the
 * captured TurnOptions.signal aborts, at which point it throws the AbortError
 * the real SDK surfaces (per-turn subprocess kill, NOTES.md Verdict 3).
 */
async function* abortableStream(getSignal: () => AbortSignal): AsyncGenerator<ThreadEvent> {
  yield codexThreadStarted();
  yield codexTurnStarted();
  yield codexItemUpdated(agentMessageItem('msg-1', 'partial answer'));
  await new Promise<never>((_, reject) => {
    const signal = getSignal();
    const abort = (): void => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

describe('CodexRuntime', () => {
  beforeEach(() => {
    environmentPolicy.names = [];
    vi.clearAllMocks();
    nativeMocks.findSession.mockReset().mockResolvedValue(null);
    nativeMocks.listSessions.mockReset().mockResolvedValue([]);
    nativeMocks.readHistory.mockReset().mockResolvedValue([]);
    sdkMocks.constructorOptions.length = 0;
    // Default scenario: a fresh single-turn thread per call (multi-turn safe).
    sdkMocks.startThread.mockImplementation(() => makeMockThread(codexSimpleTurn('Hello there')));
    sdkMocks.resumeThread.mockImplementation(() => makeMockThread(codexSimpleTurn('Resumed')));
    // ensureSession now pre-warms the MCP cache (fire-and-forget). Default the
    // probe to a clean "unavailable" so tests that don't care about MCP never
    // spawn `codex mcp list` and the warm is a cache no-op; MCP-specific tests
    // override this with their own resolved value.
    vi.mocked(enumerateCodexMcpServers).mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('does not promote pending settings or ensure metadata into native ownership', async () => {
    const { runtime, db } = makeRuntime();
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    registry.register(runtime);
    registry.setDefault('codex');
    const id = crypto.randomUUID();
    const settingsPort = {
      getSessionSettings: vi.fn().mockResolvedValue({}),
      saveSessionSettings: vi.fn().mockResolvedValue(undefined),
    };
    runtime.setSessionSettings(settingsPort);
    await runtime.updateSession(id, { permissionMode: 'plan', model: 'pending-model' });
    expect(settingsPort.saveSessionSettings).toHaveBeenCalledWith(id, {
      permissionMode: 'plan',
      model: 'pending-model',
    });
    expect(await registry.resolveSessionRuntime(id)).toEqual({ type: 'codex', bound: false });
    expect(await runtime.getSession('/projects/demo', id)).toBeNull();
    runtime.ensureSession(id, { cwd: '/projects/demo' });
    expect(await runtime.findSession(id)).toBeNull();
    expect(await runtime.listSessions('/projects/demo')).toEqual([expect.objectContaining({ id })]);
    const resolved = await registry.resolveSessionRuntime(id);
    const requestedRuntime = resolved.bound ? resolved.type : 'opencode';
    await registry.persistSessionRuntime(id, requestedRuntime, { kind: 'interactive' });
    expect(await registry.resolveSessionRuntime(id)).toEqual({ type: 'opencode', bound: true });
  });

  it('keeps imported native metadata and account after changing its settings', async () => {
    const { runtime } = makeRuntime();
    const id = crypto.randomUUID();
    const native = {
      id,
      runtime: 'codex',
      cwd: '/projects/demo',
      title: 'Native conversation',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      permissionMode: 'default',
      account: '/personal/codex-home',
    };
    nativeMocks.findSession.mockResolvedValue(native);
    nativeMocks.listSessions.mockResolvedValue([native]);
    await runtime.updateSession(id, { model: 'example' });
    expect(await runtime.findSession(id)).toMatchObject({ ...native, model: 'example' });
    expect(await runtime.getSession('/projects/demo', id)).toMatchObject({
      ...native,
      model: 'example',
    });
    expect(await runtime.listSessions('/projects/demo')).toEqual([
      expect.objectContaining({ ...native, model: 'example' }),
    ]);
  });

  it('preserves an imported native rename without replacing its directory or account', async () => {
    const { runtime, db, threadMap } = makeRuntime();
    const id = crypto.randomUUID();
    const native = {
      id,
      runtime: 'codex',
      cwd: '/projects/demo',
      title: 'Native title',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      permissionMode: 'default',
      account: '/personal/codex-home',
    };
    nativeMocks.findSession.mockResolvedValue(native);
    nativeMocks.listSessions.mockResolvedValue([native]);
    await runtime.renameSession(id, 'Chosen title');
    expect(threadMap.getThreadId(id)).toBe(id);
    const restarted = makeRuntime({ db }).runtime;
    await restarted.hydrateSessions();
    expect(await restarted.getSession('/projects/demo', id)).toMatchObject({
      id,
      title: 'Chosen title',
      cwd: native.cwd,
      account: native.account,
    });
    const missing = crypto.randomUUID();
    nativeMocks.findSession.mockResolvedValueOnce(null);
    await runtime.renameSession(missing, 'No native source');
    expect(threadMap.get(missing)).toBeUndefined();
    expect(await runtime.getSession('/projects/demo', id)).toMatchObject({
      id,
      cwd: native.cwd,
      account: native.account,
      title: 'Chosen title',
    });
    expect(await runtime.listSessions('/projects/demo')).toEqual([
      expect.objectContaining({
        id,
        cwd: native.cwd,
        account: native.account,
        title: 'Chosen title',
      }),
    ]);
  });

  it('keeps imported native history authoritative even when empty or unavailable', async () => {
    const { runtime, threadMap } = makeRuntime();
    const id = crypto.randomUUID();
    threadMap.setThreadId(id, id, '/projects/demo');
    const log = vi
      .spyOn(logHistory, 'readLogBackedHistory')
      .mockReturnValue([{ id: 'partial-dorkos', role: 'user', content: 'later DorkOS turn' }]);
    try {
      nativeMocks.readHistory.mockResolvedValueOnce([
        { id: 'native-first', role: 'user', content: 'earlier CLI turn' },
      ]);
      expect(await runtime.getMessageHistory('/projects/demo', id)).toEqual([
        { id: 'native-first', role: 'user', content: 'earlier CLI turn' },
      ]);
      nativeMocks.readHistory.mockResolvedValueOnce([]);
      expect(await runtime.getMessageHistory('/projects/demo', id)).toEqual([]);
      expect(nativeMocks.readHistory).toHaveBeenLastCalledWith(id, { required: true });
      nativeMocks.readHistory.mockRejectedValueOnce(new SessionDiscoveryUnavailableError('codex'));
      await expect(runtime.getMessageHistory('/projects/demo', id)).rejects.toBeInstanceOf(
        SessionDiscoveryUnavailableError
      );
      const owned = crypto.randomUUID();
      threadMap.setThreadId(owned, 'different-sdk-thread', '/projects/demo');
      expect(await runtime.getMessageHistory('/projects/demo', owned)).toEqual([
        { id: 'partial-dorkos', role: 'user', content: 'later DorkOS turn' },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('recognizes a personal native source before any DorkOS thread binding', async () => {
    const { runtime, threadMap } = makeRuntime();
    const id = crypto.randomUUID();
    nativeMocks.findSession.mockResolvedValueOnce({ id, cwd: '/project', runtime: 'codex' });
    expect(await runtime.sessionRunsOnCredits(id)).toBe(false);
    expect(threadMap.get(id)).toBeUndefined();
  });

  it('loads native external history and resumes the native thread rather than starting another', async () => {
    const { runtime, threadMap } = makeRuntime();
    const id = crypto.randomUUID();
    const session = {
      id,
      runtime: 'codex',
      cwd: '/projects/demo',
      title: 'external',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      permissionMode: 'default',
    };
    nativeMocks.findSession.mockResolvedValue(session);
    nativeMocks.readHistory.mockResolvedValueOnce([
      { id: 'native-0', role: 'user', content: 'hello' },
    ]);
    expect(await runtime.findSession(id)).toMatchObject(session);
    expect(await runtime.getMessageHistory('/projects/demo', id)).toEqual([
      { id: 'native-0', role: 'user', content: 'hello' },
    ]);
    await runtime.ensureSession(id, { cwd: '/projects/demo' });
    const events = [];
    for await (const event of runtime.sendMessage(id, 'continue', { cwd: '/projects/demo' }))
      events.push(event);
    expect(threadMap.getThreadId(id)).toBe(id);
    expect(sdkMocks.resumeThread).toHaveBeenCalledWith(id, expect.anything());
    expect(sdkMocks.startThread).not.toHaveBeenCalled();
  });

  it('uses native history once after an imported turn is also recorded in the DorkOS log', async () => {
    const { runtime, threadMap } = makeRuntime();
    const id = crypto.randomUUID();
    threadMap.setThreadId(id, id, '/projects/demo');
    const projector = getOrCreateProjector(id, '/projects/demo');
    await feedProjector(projector, runtime.sendMessage(id, 'continue', { cwd: '/projects/demo' }), {
      userMessage: 'continue',
    });
    nativeMocks.readHistory.mockResolvedValueOnce([
      { id: 'native-user', role: 'user', content: 'continue' },
      { id: 'native-assistant', role: 'assistant', content: 'Resumed' },
    ]);
    expect(
      (await runtime.getMessageHistory('/projects/demo', id)).map((message) => message.content)
    ).toEqual(['continue', 'Resumed']);
  });

  describe('identity and dependencies', () => {
    it('identifies as the codex runtime', () => {
      const { runtime } = makeRuntime();
      expect(runtime.type).toBe('codex');
    });

    it('delegates checkDependencies to checkCodexDependencies', async () => {
      vi.mocked(checkCodexDependencies).mockReturnValue(SATISFIED_CHECKS);
      const { runtime } = makeRuntime();

      const checks = await runtime.checkDependencies();

      expect(checkCodexDependencies).toHaveBeenCalledOnce();
      expect(checks).toEqual(SATISFIED_CHECKS);
    });

    // Purpose (DOR-1334 / F9): the SDK's `Codex` constructor throws when it
    // cannot find a binary, and in the packaged Mac app it never can — that
    // throw kept Codex out of the registry entirely, so the requirements payload
    // had no `codex` at all and the card had nothing honest to say.
    it('constructs and reports its dependencies with no codex binary anywhere', async () => {
      vi.mocked(checkCodexDependencies).mockReturnValue([
        {
          name: 'Codex CLI',
          description: 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.',
          status: 'missing',
          installHint: 'npm i -g @openai/codex',
        },
      ]);

      const { runtime } = makeRuntime({ binaryPath: null });

      expect(runtime.type).toBe('codex');
      // No SDK client was built — the constructor never touches the SDK now.
      expect(sdkMocks.constructorOptions).toHaveLength(0);
      const [cli] = await runtime.checkDependencies();
      expect(cli.status).toBe('missing');
      expect(cli.installHint).toBe('npm i -g @openai/codex');
    });

    // Purpose: with no binary, a turn must fail with a sentence a person can act
    // on — not an SDK stack trace about locating binaries.
    it('fails a turn with a named, actionable error when no binary resolves', async () => {
      const { runtime } = makeRuntime({ binaryPath: null });

      await expect(
        drain(runtime.sendMessage(crypto.randomUUID(), 'hi', { cwd: '/projects/demo' }))
      ).rejects.toThrow(
        /Codex CLI not found.*npm i -g @openai\/codex.*runtimes\.codex\.binaryPath/s
      );
      expect(sdkMocks.startThread).not.toHaveBeenCalled();
    });

    it('passes the resolved binary as codexPathOverride and a projected env on the shared client', async () => {
      const { runtime } = makeRuntime({ binaryPath: '/opt/custom/codex' });

      await drain(runtime.sendMessage(crypto.randomUUID(), 'hi', { cwd: '/projects/demo' }));

      const [shared] = sdkMocks.constructorOptions as Record<string, unknown>[];
      expect(shared).toMatchObject({ codexPathOverride: '/opt/custom/codex' });
      expect(shared).toHaveProperty('env');
    });

    it('reuses one shared client across turns while the resolved binary is unchanged', async () => {
      const { runtime } = makeRuntime({ binaryPath: '/opt/custom/codex' });

      await drain(runtime.sendMessage(crypto.randomUUID(), 'one', { cwd: '/projects/demo' }));
      await drain(runtime.sendMessage(crypto.randomUUID(), 'two', { cwd: '/projects/demo' }));

      expect(sdkMocks.constructorOptions).toHaveLength(1);
    });
  });

  describe('buildCodexOptions', () => {
    it('includes codexPathOverride and no config when nothing is injected', () => {
      // DorkOS used to always inject a scoped `dorkos_ui` bridge here, so every
      // launch carried a config. It is retired (spec `canvas-agent-seat` §5), so
      // a launch with no managed servers and no turn-bound servers carries none.
      const options = buildCodexOptions('/opt/custom/codex');
      expect(options).toEqual({ codexPathOverride: '/opt/custom/codex', env: expect.any(Object) });
      expect(options).not.toHaveProperty('config');
    });

    it('omits codexPathOverride when binaryPath is falsy', () => {
      expect(buildCodexOptions(null)).toEqual({ env: expect.any(Object) });
      expect(buildCodexOptions(undefined)).toEqual({ env: expect.any(Object) });
    });

    it('supplies complete env even without extraEnv', () => {
      expect(buildCodexOptions('/bin/codex')).toHaveProperty('env');
      expect(buildCodexOptions('/bin/codex', {})).toHaveProperty('env');
    });

    it('preserves OS inputs but withholds stale server identity when extraEnv is given', () => {
      // Only the freshly minted token may reach this launch.
      vi.stubEnv('DORKOS_BUILD_OPTIONS_PROBE', 'inherited');
      try {
        const env = buildCodexOptions(null, { DORKOS_AGENT_TOKEN: 'deadbeef' }).env as Record<
          string,
          string
        >;
        expect(env.DORKOS_AGENT_TOKEN).toBe('deadbeef');
        expect(env.DORKOS_BUILD_OPTIONS_PROBE).toBeUndefined();
        expect(env.PATH ?? env.Path).toBeDefined();
        // Nothing unset leaks through as the string "undefined".
        expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('rebuilds the actual shared client when the owner removes custom inheritance', async () => {
    vi.stubEnv('SYNTHETIC_TOOL_SETTING', 'synthetic-value');
    vi.stubEnv('MCP_API_KEY', 'synthetic-server-token');
    environmentPolicy.names = ['SYNTHETIC_TOOL_SETTING'];
    const { runtime } = makeRuntime();
    await drain(runtime.sendMessage('env-session', 'one'));
    const first = sdkMocks.constructorOptions.at(-1) as { env: Record<string, string> };
    expect(first.env.SYNTHETIC_TOOL_SETTING).toBe('synthetic-value');
    expect(first.env).not.toHaveProperty('MCP_API_KEY');
    environmentPolicy.names = [];
    const count = sdkMocks.constructorOptions.length;
    await drain(runtime.sendMessage('env-session', 'two'));
    expect(sdkMocks.constructorOptions).toHaveLength(count + 1);
    const second = sdkMocks.constructorOptions.at(-1) as { env: Record<string, string> };
    expect(second.env).not.toHaveProperty('SYNTHETIC_TOOL_SETTING');
    expect(second.env).not.toHaveProperty('MCP_API_KEY');
  });

  describe('buildCodexOptions — managed MCP servers (DOR-892)', () => {
    const servers = {
      files: { command: 'npx', args: ['-y', 'server-filesystem'] },
      remote: { url: 'https://example.com/mcp' },
    };
    const managed = { servers, env: {} };

    it('folds enabled managed servers into config.mcp_servers', () => {
      const options = buildCodexOptions(null, undefined, managed);
      expect(options.config?.mcp_servers).toEqual({
        files: { command: 'npx', args: ['-y', 'server-filesystem'] },
        remote: { url: 'https://example.com/mcp' },
      });
    });

    it('writes the DorkOS server LAST so a managed server can never shadow it', () => {
      // A managed server literally named `dorkos` must still resolve to the real
      // tool server, not the managed command.
      const shadowing = { servers: { dorkos: { command: 'evil' } }, env: {} };
      const options = buildCodexOptions(null, undefined, shadowing, {
        url: 'http://127.0.0.1:4242/agent-mcp',
        headers: {},
      });
      expect(options.config?.mcp_servers?.dorkos).toMatchObject({
        url: 'http://127.0.0.1:4242/agent-mcp',
      });
    });

    it('omits config entirely when there are no managed servers and nothing injected', () => {
      expect(buildCodexOptions(null, undefined, { servers: {}, env: {} })).not.toHaveProperty(
        'config'
      );
      expect(buildCodexOptions(null)).not.toHaveProperty('config');
    });

    it('puts a managed server header VALUE in env and nowhere in config (DOR-993)', () => {
      // The SDK flattens `config` into `--config key=value` arguments on the
      // `codex exec` command line, so a value written there is in the spawned
      // argv. Asserted by serialising the WHOLE config and searching it: the
      // flattening is recursive, so a value could reappear under any path.
      const bearer = 'Bearer ya29.a0-live-oauth-access-token';
      const options = buildCodexOptions(null, undefined, {
        servers: {
          notion: {
            url: 'https://mcp.notion.com/mcp',
            env_http_headers: { Authorization: 'DORKOS_MCP_HDR_NOTION_AUTHORIZATION' },
          },
        },
        env: { DORKOS_MCP_HDR_NOTION_AUTHORIZATION: bearer },
      });

      expect(JSON.stringify(options.config ?? {})).not.toContain(bearer);
      expect((options.env as Record<string, string>).DORKOS_MCP_HDR_NOTION_AUTHORIZATION).toBe(
        bearer
      );
      // And the header env must not have cost the subprocess its inherited PATH.
      const env = options.env as Record<string, string>;
      expect(env.PATH ?? env.Path).toBeDefined();
    });
  });

  describe('capabilities', () => {
    it('returns the finalized capability shape from the 2.2 verification', () => {
      const { runtime } = makeRuntime();
      const caps = runtime.getCapabilities();

      expect(caps).toMatchObject({
        type: 'codex',
        supportsToolApproval: false,
        supportsCostTracking: false,
        supportsResume: true,
        supportsMcp: false,
        // Codex hosts no in-process DorkOS tool server (`supportsMcp: false`)
        // but DOES accept the agent's own managed MCP servers (DOR-892).
        supportsManagedMcpServers: true,
        supportsQuestionPrompt: false,
        supportsPlugins: false,
        nativeContext: [],
      });
      expect(caps.permissionModes.supported).toBe(true);
      expect(caps.permissionModes.default).toBe('default');
      expect(caps.permissionModes.values.map((v) => v.id)).toEqual([
        'default',
        'acceptEdits',
        'bypassPermissions',
      ]);
    });

    it('declares what the app-server transport adds, and exec keeps its own (spec §14)', () => {
      const appServer = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/opt/codex',
        transport: 'app-server',
      });
      const caps = appServer.getCapabilities();
      expect(caps).toMatchObject({
        supportsToolApproval: true,
        supportsQuestionPrompt: true,
        supportsPersistentSession: true,
      });
      expect(caps.permissionModes.denyReason).toBe(false);
      expect(
        caps.permissionModes.values.map(({ id, label, asks, reach }) => ({
          id,
          label,
          asks,
          reach,
        }))
      ).toEqual([
        { id: 'default', label: 'Ask first', asks: 'always', reach: 'edit' },
        { id: 'acceptEdits', label: 'Workspace write', asks: 'when-risky', reach: 'workspace' },
        { id: 'bypassPermissions', label: 'Full access', asks: 'never', reach: 'everything' },
      ]);
      // Honest about what runs unasked and how far an approved step reaches
      // (proven on the binary: an MCP tool its server marks read-only runs
      // without a card).
      const [ask, write] = caps.permissionModes.values;
      expect(ask!.promise).toContain('read-only commands and tools');
      expect(ask!.description).toContain('beyond this project');
      expect(write!.description).toContain('Approved steps can go further');
      // App copy: no block over 15 words (writing-app-copy).
      for (const mode of caps.permissionModes.values) {
        for (const block of [mode.label, mode.description ?? '', mode.promise]) {
          expect(block.split(/\s+/).filter(Boolean).length, block).toBeLessThanOrEqual(15);
        }
      }

      const exec = makeRuntime().runtime.getCapabilities();
      expect(exec).toMatchObject({ supportsToolApproval: false, supportsQuestionPrompt: false });
      expect(exec.permissionModes.denyReason).toBeUndefined();
      expect(exec.permissionModes.values[0]!.label).toBe('Read only');
    });

    it('exposes the current account catalog and its CLI-reported default', async () => {
      const { runtime } = makeRuntime();
      const models = await runtime.getSupportedModels();

      const defaults = models.filter((m) => m.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.value).toBe('gpt-6-astra');
      expect(models.map((m) => m.value)).toContain('gpt-5.6-sol');
      for (const model of models) expect(model.provider).toBe('openai');
    });
  });

  describe('session lifecycle', () => {
    it('keeps ensureSession metadata private until a thread exists', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      expect(runtime.hasSession(sessionId)).toBe(false);
      runtime.ensureSession(sessionId, { permissionMode: 'acceptEdits', cwd: '/projects/demo' });
      expect(runtime.hasSession(sessionId)).toBe(true);

      expect(await runtime.getSession('/projects/demo', sessionId)).toBeNull();
      await expect(runtime.getSession('/projects/demo', crypto.randomUUID())).resolves.toBeNull();
    });

    it('lists tracked sessions scoped to the project directory', async () => {
      const { runtime } = makeRuntime();
      const inProject = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      runtime.ensureSession(inProject, { permissionMode: 'default', cwd: '/projects/demo' });
      runtime.ensureSession(elsewhere, { permissionMode: 'default', cwd: '/projects/other' });

      const sessions = await runtime.listSessions('/projects/demo');
      expect(sessions.map((s) => s.id)).toEqual([inProject]);
      expect(sessions[0]!.runtime).toBe('codex');
    });

    it('renameSession sets the tracked title', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default' });

      await runtime.renameSession(sessionId, 'Investigate flaky test', '/projects/demo');

      await drain(runtime.sendMessage(sessionId, 'hello', { cwd: '/projects/demo' }));
      const session = await runtime.getSession('/projects/demo', sessionId);
      expect(session?.title).toBe('Investigate flaky test');
    });

    it('updateSession saves pending choices without exposing a native session', async () => {
      const { runtime } = makeRuntime();
      const port: SessionSettingsPort = {
        getSessionSettings: vi.fn().mockResolvedValue(null),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
        // Codex never aliases a session id, so it never re-keys (DOR-493).
        rekeySessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      runtime.setSessionSettings(port);
      const sessionId = crypto.randomUUID();

      const updated = await runtime.updateSession(sessionId, { permissionMode: 'acceptEdits' });

      expect(updated).toEqual({ updated: true });
      expect(runtime.hasSession(sessionId)).toBe(true);
      expect(port.saveSessionSettings).toHaveBeenCalledWith(sessionId, {
        permissionMode: 'acceptEdits',
      });
      const session = await runtime.getSession('/projects/demo', sessionId);
      expect(session).toBeNull();
    });

    /**
     * A mode becomes a `sandboxMode` when the turn starts and nothing moves it
     * afterwards — there is no control channel and no ack to wait for. So a
     * tightening landed mid-turn is saved and NOT in force, and saying so is the
     * whole of DOR-1435 on this adapter.
     */
    describe('a permission change landed while a turn is streaming', () => {
      /** Start a turn and park it mid-stream, so `activeTurns` holds an entry. */
      function startParkedTurn(runtime: CodexRuntime, sessionId: string) {
        let capturedSignal: AbortSignal | undefined;
        sdkMocks.startThread.mockReturnValue({
          id: null,
          runStreamed: vi.fn((_input: unknown, turnOptions?: { signal?: AbortSignal }) => {
            capturedSignal = turnOptions?.signal;
            return Promise.resolve({ events: abortableStream(() => capturedSignal!) });
          }),
          run: vi.fn(),
        });
        const gen = runtime.sendMessage(sessionId, 'long task');
        return { gen, drainRest: async () => void (await drain(gen)) };
      }

      it('says a tightening has not reached the running turn', async () => {
        const { runtime } = makeRuntime();
        const sessionId = crypto.randomUUID();
        runtime.ensureSession(sessionId, {
          permissionMode: 'bypassPermissions',
          cwd: '/projects/demo',
        });
        const { gen, drainRest } = startParkedTurn(runtime, sessionId);
        await gen.next(); // the turn is now in flight

        // Full access → Read only: the run keeps full file and network access
        // until it ends, whatever the session now says.
        await expect(
          runtime.updateSession(sessionId, { permissionMode: 'default' })
        ).resolves.toEqual({ updated: true, permissionModePendingUntilNextTurn: true });

        await runtime.interruptQuery(sessionId);
        await drainRest();
      });

      it('stays quiet about a loosening, which the next turn simply picks up', async () => {
        const { runtime } = makeRuntime();
        const sessionId = crypto.randomUUID();
        runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });
        const { gen, drainRest } = startParkedTurn(runtime, sessionId);
        await gen.next();

        await expect(
          runtime.updateSession(sessionId, { permissionMode: 'bypassPermissions' })
        ).resolves.toEqual({ updated: true });

        await runtime.interruptQuery(sessionId);
        await drainRest();
      });

      it('stays quiet when no turn is running — the next one is projected from the new mode', async () => {
        const { runtime } = makeRuntime();
        const sessionId = crypto.randomUUID();
        runtime.ensureSession(sessionId, {
          permissionMode: 'bypassPermissions',
          cwd: '/projects/demo',
        });

        await expect(
          runtime.updateSession(sessionId, { permissionMode: 'default' })
        ).resolves.toEqual({ updated: true });
      });
    });

    it('forkSession is unsupported and resolves null', async () => {
      const { runtime } = makeRuntime();
      await expect(runtime.forkSession('/p', crypto.randomUUID())).resolves.toBeNull();
    });

    it('getInternalSessionId returns undefined — the DorkOS id is canonical (no rekey)', () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, THREAD_ID);

      // Returning the Codex thread id here would trip trigger-turn's C1 rekey
      // and re-key the projector (and the 202 canonical id) to the thread id.
      expect(runtime.getInternalSessionId(sessionId)).toBeUndefined();
    });
  });

  describe('durable metadata (restart survival)', () => {
    it('hydrateSessions restores the session list with title and preview after a simulated restart', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' }));

      // Simulated restart: a fresh runtime instance over the same DB.
      const { runtime: restarted } = makeRuntime({ db });
      await expect(restarted.listSessions('/projects/demo')).resolves.toEqual([]);
      await restarted.hydrateSessions();

      const sessions = await restarted.listSessions('/projects/demo');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        runtime: 'codex',
        title: 'Fix the flaky test',
        lastMessagePreview: 'Fix the flaky test',
        cwd: '/projects/demo',
      });
      expect(restarted.hasSession(sessionId)).toBe(true);
    });

    it('a hydrated cwd-less legacy row appears in NO project list but stays reachable by id (DOR-202)', async () => {
      const { threadMap, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      // A legacy orphan row: bound pre-cwd/pre-metadata, so cwd/title are NULL.
      threadMap.setThreadId(sessionId, 'thread-ghost');

      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();

      // Pre-fix these ghosts fanned into EVERY project's list.
      await expect(restarted.listSessions('/projects/demo')).resolves.toEqual([]);
      await expect(restarted.listSessions(DEFAULT_ROOT)).resolves.toEqual([]);
      // Still resolvable directly — hidden from lists, not lost.
      const session = await restarted.getSession('/projects/demo', sessionId);
      expect(session?.id).toBe(sessionId);
    });

    it('rename persists across a simulated restart', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      await runtime.renameSession(sessionId, 'Investigate flaky test', '/projects/demo');

      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();
      const session = await restarted.getSession('/projects/demo', sessionId);
      expect(session?.title).toBe('Investigate flaky test');
    });

    it('recordMessage writes preview/updatedAt through once the binding exists', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'first question', { cwd: '/projects/demo' }));
      const afterFirst = threadMap.get(sessionId)!;
      expect(afterFirst).toMatchObject({
        title: 'First question',
        lastMessagePreview: 'first question',
      });

      await drain(runtime.sendMessage(sessionId, 'second question', { cwd: '/projects/demo' }));
      const afterSecond = threadMap.get(sessionId)!;
      // Title is first-turn-derived and sticky; the preview tracks the latest turn.
      expect(afterSecond.title).toBe('First question');
      expect(afterSecond.lastMessagePreview).toBe('second question');
      expect(afterSecond.updatedAt! >= afterFirst.updatedAt!).toBe(true);
    });

    it('hydration joins persisted settings from the settings port', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const { runtime: restarted } = makeRuntime({ db });
      const port: SessionSettingsPort = {
        getSessionSettings: vi.fn().mockResolvedValue({
          permissionMode: 'acceptEdits',
          model: 'gpt-5.4-mini',
          effort: 'high',
          fastMode: true,
        }),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
        // Codex never aliases a session id, so it never re-keys (DOR-493).
        rekeySessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      restarted.setSessionSettings(port);
      await restarted.hydrateSessions();

      expect(port.getSessionSettings).toHaveBeenCalledWith(sessionId);
      const session = await restarted.getSession('/projects/demo', sessionId);
      expect(session).toMatchObject({
        permissionMode: 'acceptEdits',
        model: 'gpt-5.4-mini',
        effort: 'high',
        fastMode: true,
      });
    });

    it('hydrateSessions is idempotent and never clobbers fresher in-memory state', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();
      await restarted.renameSession(sessionId, 'renamed after hydrate', '/projects/demo');
      await restarted.hydrateSessions();

      const sessions = await restarted.listSessions('/projects/demo');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe('renamed after hydrate');
    });

    describe('pre-hydration touches (boot-time race)', () => {
      it('renameSession before hydration seeds the durable row, keeps the rename, and survives later hydration', async () => {
        const { runtime, db, threadMap } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );
        const durable = threadMap.getRecord(sessionId)!;

        // Simulated restart: the rename lands BEFORE hydrateSessions runs.
        const { runtime: restarted } = makeRuntime({ db });
        await restarted.renameSession(sessionId, 'Renamed before hydration', '/projects/demo');

        // The entry was seeded from the durable row (createdAt/cwd preserved),
        // with the genuinely fresher rename on top.
        const seeded = await restarted.getSession('/projects/demo', sessionId);
        expect(seeded).toMatchObject({
          title: 'Renamed before hydration',
          createdAt: durable.createdAt,
          cwd: '/projects/demo',
        });

        // Later startup hydration does not clobber the touched id.
        await restarted.hydrateSessions();
        const sessions = await restarted.listSessions('/projects/demo');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          title: 'Renamed before hydration',
          createdAt: durable.createdAt,
        });

        // The rename write-through persisted: a third instance hydrates it back.
        const { runtime: third } = makeRuntime({ db });
        await third.hydrateSessions();
        const rehydrated = await third.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Renamed before hydration');
      });

      it('sendMessage before hydration keeps the durable saved title while refreshing preview/updatedAt', async () => {
        const { runtime, db, threadMap } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(runtime.sendMessage(sessionId, 'first question', { cwd: '/projects/demo' }));
        await runtime.renameSession(sessionId, 'Saved title', '/projects/demo');
        const durable = threadMap.getRecord(sessionId)!;

        // Simulated restart: a message lands BEFORE hydrateSessions runs.
        const { runtime: restarted } = makeRuntime({ db });
        await drain(
          restarted.sendMessage(sessionId, 'follow-up question', { cwd: '/projects/demo' })
        );

        // The auto-derived preview must NOT overwrite the persisted title.
        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          title: 'Saved title',
          lastMessagePreview: 'follow-up question',
          createdAt: durable.createdAt,
          cwd: '/projects/demo',
        });
        expect(session!.updatedAt >= durable.updatedAt!).toBe(true);

        // The refreshed preview wrote through; the durable title stayed intact.
        const after = threadMap.getRecord(sessionId)!;
        expect(after.title).toBe('Saved title');
        expect(after.lastMessagePreview).toBe('follow-up question');

        // Later hydration does not resurrect the stale preview.
        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Saved title');
        expect(rehydrated?.lastMessagePreview).toBe('follow-up question');
      });

      it('updateSession before hydration seeds the durable row and applies the patch on top', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        // Simulated restart: the settings PATCH lands BEFORE hydrateSessions.
        const { runtime: restarted } = makeRuntime({ db });
        const port: SessionSettingsPort = {
          getSessionSettings: vi.fn().mockResolvedValue(null),
          saveSessionSettings: vi.fn().mockResolvedValue(undefined),
          // Codex never aliases a session id, so it never re-keys (DOR-493).
          rekeySessionSettings: vi.fn().mockResolvedValue(undefined),
        };
        restarted.setSessionSettings(port);
        await restarted.updateSession(sessionId, { permissionMode: 'acceptEdits' });

        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          title: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated).toMatchObject({
          title: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
        });
      });

      it('ensureSession before hydration seeds display metadata with the caller opts folded on top', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        // Simulated restart: ensureSession lands BEFORE hydrateSessions.
        const { runtime: restarted } = makeRuntime({ db });
        restarted.ensureSession(sessionId, {
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          id: sessionId,
          title: 'Fix the flaky test',
          lastMessagePreview: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Fix the flaky test');
        expect(rehydrated?.permissionMode).toBe('acceptEdits');
      });

      it('hydrateSessions after a pre-hydration touch emits no stale session_upserted for the touched id', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        const { runtime: restarted } = makeRuntime({ db });
        await restarted.renameSession(sessionId, 'Renamed before hydration', '/projects/demo');

        const iterator = restarted
          .subscribeSessionList({ permissionMode: 'default' })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value).toMatchObject({
          type: 'session_upserted',
          session: { id: sessionId, title: 'Renamed before hydration' },
        });

        await restarted.hydrateSessions();
        // Registry emissions are synchronous: had hydrate re-upserted the
        // tracked id, the stale event would already be queued and win this
        // race over the macrotask timer.
        const outcome = await Promise.race([
          iterator.next().then((result) => ({ kind: 'event' as const, result })),
          new Promise<{ kind: 'idle' }>((resolve) => setImmediate(() => resolve({ kind: 'idle' }))),
        ]);
        expect(outcome).toEqual({ kind: 'idle' });
        await iterator.return?.(undefined);
      });
    });
  });

  describe('sendMessage — start path', () => {
    it('starts a new thread with explicit read-only sandbox and never-approval options', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      const events = await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(sdkMocks.startThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.startThread).toHaveBeenCalledWith({
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/demo',
      });
      expect(sdkMocks.resumeThread).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.at(-1)!.type).toBe('done');
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
      expect(text).toBe('Hello there');
    });

    it('persists the thread binding from thread.started (first-write-wins map)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(threadMap.getThreadId(sessionId)).toBe(THREAD_ID);
    });

    it('persists the turn cwd and bind-time metadata alongside the binding so both survive a restart', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const binding = threadMap.get(sessionId)!;
      expect(binding).toMatchObject({
        threadId: THREAD_ID,
        cwd: '/projects/demo',
        // The first turn's registry metadata rides along with the bind.
        title: 'Hi',
        lastMessagePreview: 'hi',
      });
      expect(new Date(binding.updatedAt!).toISOString()).toBe(binding.updatedAt);
    });

    it('projects acceptEdits -> workspace-write and bypassPermissions -> danger-full-access', async () => {
      const { runtime } = makeRuntime();
      const editsSession = crypto.randomUUID();
      runtime.ensureSession(editsSession, { permissionMode: 'acceptEdits' });
      await drain(runtime.sendMessage(editsSession, 'hi'));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'workspace-write', approvalPolicy: 'never' })
      );

      const bypassSession = crypto.randomUUID();
      runtime.ensureSession(bypassSession, { permissionMode: 'bypassPermissions' });
      await drain(runtime.sendMessage(bypassSession, 'hi'));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
      );
    });

    // Power flows downstream, never up (spec `trusted-by-default-flip` §4).
    it('runs a Full autonomy thread read-only for a turn held to the runtime default, then not', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'bypassPermissions' });
      await drain(runtime.sendMessage(sessionId, 'hi', { permissionCeiling: 'runtime-default' }));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'read-only' })
      );
      const fresh = crypto.randomUUID();
      runtime.ensureSession(fresh, { permissionMode: 'bypassPermissions' });
      await drain(runtime.sendMessage(fresh, 'hi'));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'danger-full-access' })
      );
    });

    it('RT-MOD-01: projects session model and effort into ThreadOptions', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, {
        permissionMode: 'default',
        model: 'gpt-5.4',
        effort: 'max',
      });

      await drain(runtime.sendMessage(sessionId, 'hi'));

      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4', modelReasoningEffort: 'xhigh' })
      );
    });

    it('hydrates persisted settings for an untracked session (restart resume path)', async () => {
      const { runtime } = makeRuntime();
      const port: SessionSettingsPort = {
        getSessionSettings: vi
          .fn()
          .mockResolvedValue({ permissionMode: 'acceptEdits', model: 'gpt-5.4-mini' }),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
        // Codex never aliases a session id, so it never re-keys (DOR-493).
        rekeySessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      runtime.setSessionSettings(port);
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(port.getSessionSettings).toHaveBeenCalledWith(sessionId);
      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxMode: 'workspace-write', model: 'gpt-5.4-mini' })
      );
    });

    it('runs a seeded new session on the model and effort the server chose', async () => {
      // The other half of the execution-defaults seam (spec execution-defaults
      // E1): the server writes its per-runtime default onto `session_metadata`
      // at the session's first write, and this adapter reads that row like any
      // other persisted setting. Nothing in Codex knows about config.
      const { runtime } = makeRuntime();
      const port: SessionSettingsPort = {
        getSessionSettings: vi.fn().mockResolvedValue({ model: 'gpt-5.3-codex', effort: 'low' }),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
        // Codex never aliases a session id, so it never re-keys (DOR-493).
        rekeySessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      runtime.setSessionSettings(port);
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.3-codex', modelReasoningEffort: 'low' })
      );
    });

    it('prepends systemPromptAppend and additional context, keeping content last and unmutated', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const thread = makeMockThread(codexSimpleTurn('ok'));
      sdkMocks.startThread.mockReturnValue(thread);

      await drain(
        runtime.sendMessage(sessionId, 'What changed?', {
          cwd: '/projects/demo',
          systemPromptAppend: 'Scheduled task context',
          additionalContext: [
            { kind: 'git_status', scope: 'per-turn', data: { isRepo: true, branch: 'main' } },
          ],
        })
      );

      const [input] = thread.runStreamed.mock.calls[0]!;
      expect(input).toContain('Scheduled task context');
      expect(input).toContain('<git_status>');
      expect(input).toContain('</git_status>');
      expect(String(input).endsWith('What changed?')).toBe(true);
    });

    it('leads with the <gen_ui> block and keeps user content last when no context is supplied', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const thread = makeMockThread(codexSimpleTurn('ok'));
      sdkMocks.startThread.mockReturnValue(thread);

      await drain(runtime.sendMessage(sessionId, 'plain message'));

      // Codex has no cacheable system-prompt channel, so the static <gen_ui>
      // teaching block is prepended inline on every turn; content stays last.
      const input = thread.runStreamed.mock.calls[0]![0];
      expect(input).toContain('<gen_ui>');
      expect(String(input).endsWith('plain message')).toBe(true);
    });
  });

  describe('sendMessage — managed MCP servers (DOR-892)', () => {
    /** Latest per-turn client options recorded by the SDK mock, or undefined. */
    function lastConstructedConfig(): Record<string, unknown> | undefined {
      const last = sdkMocks.constructorOptions.at(-1) as { config?: Record<string, unknown> };
      return last?.config;
    }

    it('injects the resolver’s enabled servers into a per-turn client, keyed by the turn cwd', async () => {
      const { runtime } = makeRuntime();
      const injectableServersForCwd = vi.fn().mockReturnValue({
        files: { transport: 'stdio', command: 'npx', args: ['-y', 'fs'] },
      });
      runtime.setManagedMcpServers({ injectableServersForCwd });
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(injectableServersForCwd).toHaveBeenCalledWith('/projects/demo');
      expect(lastConstructedConfig()?.mcp_servers).toEqual({
        files: { command: 'npx', args: ['-y', 'fs'] },
      });
    });

    it('drops an sse managed server (Codex has no SSE transport) and injects the rest', async () => {
      const { runtime } = makeRuntime();
      runtime.setManagedMcpServers({
        injectableServersForCwd: () => ({
          files: { transport: 'stdio', command: 'npx' },
          stream: { transport: 'sse', url: 'https://example.com/sse' },
        }),
      });

      await drain(runtime.sendMessage(crypto.randomUUID(), 'hi', { cwd: '/projects/demo' }));

      const servers = lastConstructedConfig()?.mcp_servers as Record<string, unknown>;
      expect(servers).toHaveProperty('files');
      expect(servers).not.toHaveProperty('stream');
    });

    it('builds no per-turn client (reuses the shared client) when the agent has no managed servers', async () => {
      const { runtime } = makeRuntime();
      runtime.setManagedMcpServers({ injectableServersForCwd: () => ({}) });
      // The shared client is built on the FIRST turn now (nothing touches the
      // SDK before then); a second turn with no managed servers and no identity
      // token must not add another.
      await drain(runtime.sendMessage(crypto.randomUUID(), 'warm', { cwd: '/projects/demo' }));
      sdkMocks.constructorOptions.length = 0;

      await drain(runtime.sendMessage(crypto.randomUUID(), 'hi', { cwd: '/projects/demo' }));

      expect(sdkMocks.constructorOptions).toHaveLength(0);
    });
  });

  describe('sendMessage — resume path', () => {
    it('resumes the mapped thread with explicit options instead of starting a new one', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, 'thread-existing');
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      await drain(runtime.sendMessage(sessionId, 'continue', { cwd: '/projects/demo' }));

      expect(sdkMocks.resumeThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledWith('thread-existing', {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/demo',
      });
      expect(sdkMocks.startThread).not.toHaveBeenCalled();
      // The pre-existing binding stays intact (first-write-wins).
      expect(threadMap.getThreadId(sessionId)).toBe('thread-existing');
    });

    it('starts then resumes across two turns of one session', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'one'));
      await drain(runtime.sendMessage(sessionId, 'two'));

      expect(sdkMocks.startThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledWith(THREAD_ID, expect.any(Object));
    });

    it('resolves the persisted binding cwd when the in-memory registry is gone (post-restart)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      // A pre-restart binding persisted with its cwd; the in-memory registry is
      // empty (as on a fresh process), and the trigger carries no opts.cwd.
      threadMap.setThreadId(sessionId, 'thread-persisted', '/projects/persisted');

      await drain(runtime.sendMessage(sessionId, 'resume in the right dir'));

      expect(sdkMocks.resumeThread).toHaveBeenCalledWith('thread-persisted', {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/persisted',
      });
    });

    it('resumes a legacy binding without a persisted cwd in the default root (DOR-202)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, 'thread-legacy'); // pre-cwd (legacy) binding

      await drain(runtime.sendMessage(sessionId, 'resume'));

      // The default-root floor replaces the old "omit workingDirectory"
      // degradation: the turn runs in a known directory instead of the
      // server's process.cwd(), and the session gains a real cwd.
      expect(sdkMocks.resumeThread).toHaveBeenCalledWith(
        'thread-legacy',
        expect.objectContaining({ workingDirectory: DEFAULT_ROOT })
      );
      const sessions = await runtime.listSessions(DEFAULT_ROOT);
      expect(sessions.map((s) => s.id)).toContain(sessionId);
    });

    it('a resumed legacy binding backfills its cwd durably — the session survives a restart on the list (DOR-202)', async () => {
      const { runtime, threadMap, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, 'thread-legacy'); // pre-cwd (legacy) binding

      await drain(runtime.sendMessage(sessionId, 'resume'));
      expect(threadMap.get(sessionId)?.cwd).toBe(DEFAULT_ROOT);

      // Without the durable backfill this re-hydrated cwd-less and vanished
      // from every project list again after each restart.
      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();
      const sessions = await restarted.listSessions(DEFAULT_ROOT);
      expect(sessions.map((s) => s.id)).toContain(sessionId);
    });

    it('a turn with no cwd from any source binds and persists the default root — a row is never minted cwd-less (DOR-202)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'no cwd anywhere'));

      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ workingDirectory: DEFAULT_ROOT })
      );
      expect(threadMap.get(sessionId)?.cwd).toBe(DEFAULT_ROOT);
      const sessions = await runtime.listSessions(DEFAULT_ROOT);
      expect(sessions.map((s) => s.id)).toContain(sessionId);
    });
  });

  describe('interrupt semantics', () => {
    it('interruptQuery aborts the in-flight turn; the stream ends with a quiet done', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      let capturedSignal: AbortSignal | undefined;
      sdkMocks.startThread.mockReturnValue({
        id: null,
        runStreamed: vi.fn((_input: unknown, turnOptions?: { signal?: AbortSignal }) => {
          capturedSignal = turnOptions?.signal;
          return Promise.resolve({ events: abortableStream(() => capturedSignal!) });
        }),
        run: vi.fn(),
      });

      const gen = runtime.sendMessage(sessionId, 'long task');
      const first = await gen.next();
      expect(first.value).toEqual({ type: 'text_delta', data: { text: 'partial answer' } });

      // `closed`, never `acked` (spec `runtime-interrupt-receipts` D7): codex's
      // only interrupt primitive SIGTERMs the per-turn subprocess, and nothing
      // in codex acknowledges a stop. Reporting `acked` would tell the person
      // the agent wound down when it did not. No `reason`, because every reason
      // names why a graceful attempt was abandoned and there is none to abandon.
      await expect(runtime.interruptQuery(sessionId)).resolves.toEqual({
        outcome: 'closed',
        runtime: 'codex',
      });
      expect(capturedSignal?.aborted).toBe(true);

      const rest: StreamEvent[] = [];
      for await (const event of gen) rest.push(event);
      // Abort is user-initiated: exactly one quiet done, no error event.
      expect(rest).toEqual([{ type: 'done', data: { sessionId } }]);

      // The thread binding still landed (thread.started arrived before the abort).
      expect(threadMap.getThreadId(sessionId)).toBe(THREAD_ID);
      // The turn is settled — a second interrupt has nothing to abort.
      await expect(runtime.interruptQuery(sessionId)).resolves.toEqual({
        outcome: 'not-running',
        reason: 'no-open-turn',
        runtime: 'codex',
      });
    });

    it('resolves not-running when no turn is in flight', async () => {
      const { runtime } = makeRuntime();
      await expect(runtime.interruptQuery(crypto.randomUUID())).resolves.toEqual({
        outcome: 'not-running',
        reason: 'no-open-turn',
        runtime: 'codex',
      });
    });
  });

  describe('history and live state (projector-backed)', () => {
    it('reconstructs message history from the DorkOS EventLog after a fed turn', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const projector = getOrCreateProjector(sessionId, '/projects/demo');

      await feedProjector(projector, runtime.sendMessage(sessionId, 'hello'), {
        userMessage: 'hello',
      });

      const history = await runtime.getMessageHistory('/projects/demo', sessionId);
      expect(history.length).toBeGreaterThan(0);
      expect(history.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
      expect(history.some((m) => m.role === 'assistant')).toBe(true);
    });

    // Codex has no vendor-error-as-agent-speech gap, and this is the proof
    // (DOR-1666). Every Codex failure has a typed home in the SDK stream
    // (`turn.failed`, `ErrorItem`, `ThreadErrorEvent` — there is no shape that
    // delivers one as an `AgentMessageItem`), the mapper classifies it once,
    // and the durable EventLog fold replays that classification verbatim. So
    // the category a person saw live is the category a reload shows, and this
    // asserts the whole chain rather than any one link.
    it('reconstructs an auth-failed turn as a typed auth_error part, not agent speech', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      sdkMocks.startThread.mockReturnValue(
        makeMockThread(codexFailedTurn('401 Unauthorized: OAuth token revoked'))
      );
      const projector = getOrCreateProjector(sessionId, '/projects/demo');

      await feedProjector(projector, runtime.sendMessage(sessionId, 'hello'), {
        userMessage: 'hello',
      });

      const history = await runtime.getMessageHistory('/projects/demo', sessionId);
      const assistant = history.find((m) => m.role === 'assistant');
      expect(assistant).toBeDefined();
      // The failure is an error PART, so it renders as an error card with the
      // sign-in affordance — never as something the agent said.
      expect(assistant!.content).toBe('');
      // The WORDS are DorkOS's, and the CLI's are kept beside them (DOR-1656):
      // a reload shows the same sentence the live turn did, naming Codex rather
      // than reprinting the vendor's 401. What this case is actually about —
      // typed part, auth_error category, nothing attributed to the agent — is
      // unchanged; only the copy moved.
      expect(assistant!.parts).toEqual([
        {
          type: 'error',
          message: 'Your Codex sign-in stopped working. Sign in again to keep going.',
          category: 'auth_error',
          details: '[turn_failed] 401 Unauthorized: OAuth token revoked',
        },
      ]);
    });

    it('returns empty history for a session that never streamed', async () => {
      const { runtime } = makeRuntime();
      await expect(
        runtime.getMessageHistory('/projects/demo', crypto.randomUUID())
      ).resolves.toEqual([]);
    });

    // Cross-runtime kickoff-suppression evidence (agent-creation-redesign M4).
    // The client fires the auto-first-turn kickoff runtime-blind, so a codex
    // session gets one too. FINDING (verified by these tests): codex delivers
    // the additional-context bag OUT OF BAND — `buildCodexPrompt` prepends the
    // context blocks to the model prompt, but the EventLog records the PRISTINE
    // trigger content via `turn_start.userMessage`. So the first user record codex
    // reconstructs is the bare `<dork-kickoff>…</dork-kickoff>` envelope with NO
    // wrapper — the exact shape `filterKickoffHistory` suppresses. No leak, and
    // no per-runtime stripping is needed; these tests are the regression armor.
    it('reconstructs the kickoff as a bare envelope that filterKickoffHistory suppresses', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const projector = getOrCreateProjector(sessionId, '/projects/demo');
      const envelope = wrapKickoff(
        'Read your SOUL.md and introduce yourself. Offer a first action.'
      );

      // Drive the trigger path with the pristine envelope on turn_start. The
      // REAL production guarantee lives at `trigger-turn.ts:263`, which feeds the
      // projector `{ userMessage: content }` (raw trigger content; context goes
      // out of band) — so this is a faithful stand-in, not an end-to-end proof.
      await feedProjector(projector, runtime.sendMessage(sessionId, envelope), {
        userMessage: envelope,
      });

      const history = await runtime.getMessageHistory('/projects/demo', sessionId);
      // The first user record is the bare envelope — codex never wraps it.
      const firstUser = history.find((m) => m.role === 'user');
      expect(firstUser?.content).toBe(envelope);

      // The shared seam drops exactly that record; the greeting survives.
      const filtered = filterKickoffHistory(history);
      expect(filtered.some((m) => m.role === 'user')).toBe(false);
      expect(filtered.some((m) => m.role === 'assistant')).toBe(true);
      expect(JSON.stringify(filtered)).not.toContain('dork-kickoff');
    });

    it('keeps a genuine first message that merely mentions the kickoff tag (no over-suppression)', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const projector = getOrCreateProjector(sessionId, '/projects/demo');
      const genuine = 'what does <dork-kickoff> mean?';

      await feedProjector(projector, runtime.sendMessage(sessionId, genuine), {
        userMessage: genuine,
      });

      const history = await runtime.getMessageHistory('/projects/demo', sessionId);
      // A partial-tag mention is genuine content and passes through untouched.
      expect(filterKickoffHistory(history)).toEqual(history);
      expect(history.some((m) => m.role === 'user' && m.content === genuine)).toBe(true);
    });

    it('getSessionSnapshot serves the projector snapshot (cold session: empty, cursor 0)', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      const snapshot = await runtime.getSessionSnapshot(
        { permissionMode: 'default', cwd: '/projects/demo' },
        sessionId
      );

      expect(snapshot.messages).toEqual([]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.cursor).toBe(0);
    });

    it('subscribeSessionList yields the tracked inventory as session_upserted events', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      const iterator = runtime
        .subscribeSessionList({ permissionMode: 'default' })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      await iterator.return?.(undefined);

      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        type: 'session_upserted',
        session: { id: sessionId, runtime: 'codex' },
      });
    });
  });

  describe('approval-free interactive surface (NOTES.md Verdict 1)', () => {
    it('approveTool, submitAnswers, submitElicitation, and stopTask all report unsupported', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default' });

      expect(runtime.approveTool(sessionId, 'tool-1', true)).toBe(false);
      expect(runtime.submitAnswers(sessionId, 'tool-1', { '0': 'yes' })).toBe(false);
      expect(runtime.submitElicitation(sessionId, 'int-1', 'accept')).toBe(false);
      // Codex has no addressable background tasks: `not-running` is the honest
      // report and is NOT a failure — nothing broke, there was nothing to stop.
      await expect(runtime.stopTask(sessionId, 'task-1')).resolves.toEqual({
        outcome: 'not-running',
        reason: 'no-open-turn',
        runtime: 'codex',
      });
    });
  });

  describe('session locking', () => {
    it('grants the lock to one client and refuses a second until released', () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const res = { on: vi.fn() };

      expect(runtime.acquireLock(sessionId, 'client-a', res)).toBe(true);
      expect(runtime.acquireLock(sessionId, 'client-b', res)).toBe(false);
      expect(runtime.isLocked(sessionId, 'client-b')).toBe(true);
      expect(runtime.getLockInfo(sessionId)?.clientId).toBe('client-a');

      runtime.releaseLock(sessionId, 'client-a');
      expect(runtime.acquireLock(sessionId, 'client-b', res)).toBe(true);
    });
  });

  describe('storage stubs', () => {
    it('returns honest empties for surfaces Codex has no native store for', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await expect(runtime.getSessionTasks('/p', sessionId)).resolves.toEqual([]);
      await expect(runtime.getSessionETag('/p', sessionId)).resolves.toBeNull();
      await expect(runtime.getLastMessageIds(sessionId)).resolves.toBeNull();
      await expect(runtime.readFromOffset('/p', sessionId, 0)).resolves.toEqual({
        content: '',
        newOffset: 0,
      });
      await expect(runtime.getSupportedSubagents()).resolves.toEqual([]);
    });
  });

  describe('commands (project-skill palette)', () => {
    it('surfaces the project skills under the session cwd as slash commands', async () => {
      const { runtime } = makeRuntime();
      const commands = [{ command: 'deploy', fullCommand: '/deploy', description: 'Ship it' }];
      vi.mocked(scanSkillCommands).mockReturnValue(commands);

      const registry = await runtime.getCommands(false, '/projects/demo');

      expect(scanSkillCommands).toHaveBeenCalledWith('/projects/demo');
      expect(registry.commands).toEqual(commands);
      expect(typeof registry.lastScanned).toBe('string');
    });

    it('returns an empty palette with no cwd (cold discovery, no project to scan)', async () => {
      const { runtime } = makeRuntime();

      const registry = await runtime.getCommands();

      expect(registry.commands).toEqual([]);
      expect(scanSkillCommands).not.toHaveBeenCalled();
    });
  });

  describe('mcp status (Codex config surfacing)', () => {
    it('warms lazily then serves the configured servers synchronously from cache', async () => {
      const { runtime } = makeRuntime();
      const servers = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(servers);

      // The synchronous interface returns null on the cold call while the async
      // `codex mcp list` probe warms the cache out-of-band.
      expect(runtime.getMcpStatus('/projects/demo')).toBeNull();

      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/projects/demo')).toEqual(servers);
      });
      // Subsequent calls hit the warm cache — no re-enumeration.
      runtime.getMcpStatus('/projects/demo');
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('caches an empty result (no servers configured) without re-enumerating', async () => {
      const { runtime } = makeRuntime();
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue([]);

      expect(runtime.getMcpStatus('/p')).toBeNull();
      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/p')).toEqual([]);
      });
      runtime.getMcpStatus('/p');
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('stays null when enumeration genuinely fails', async () => {
      const { runtime } = makeRuntime();
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(null);

      expect(runtime.getMcpStatus('/p')).toBeNull();
      await vi.waitFor(() => {
        expect(enumerateCodexMcpServers).toHaveBeenCalled();
      });
      expect(runtime.getMcpStatus('/p')).toBeNull();
    });

    it('pre-warms the cache on ensureSession so the first getMcpStatus is populated', async () => {
      const { runtime } = makeRuntime();
      const servers = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(servers);

      // ensureSession kicks the warm before any getMcpStatus call.
      runtime.ensureSession(crypto.randomUUID(), {
        permissionMode: 'default',
        cwd: '/projects/demo',
      });
      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/projects/demo')).toEqual(servers);
      });
      // The pre-warm satisfied the first ask — no extra probe from getMcpStatus.
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('re-warms after the TTL window but serves the cached value within it', async () => {
      const { runtime } = makeRuntime();
      const first = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      const second = [{ name: 'github', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(first);

      const t0 = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

      runtime.getMcpStatus('/p'); // kicks the initial warm
      await vi.waitFor(() => expect(runtime.getMcpStatus('/p')).toEqual(first));
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);

      // Within the TTL: no re-warm, still serves the cached value.
      nowSpy.mockReturnValue(t0 + 30_000);
      expect(runtime.getMcpStatus('/p')).toEqual(first);
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);

      // Past the TTL: background re-warm, but the stale value is returned
      // immediately (the getter stays synchronous).
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(second);
      nowSpy.mockReturnValue(t0 + 61_000);
      expect(runtime.getMcpStatus('/p')).toEqual(first);
      await vi.waitFor(() => expect(runtime.getMcpStatus('/p')).toEqual(second));
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });
  });
});

describe('resolveCodexTransport (spec §15)', () => {
  it('runs app-server by default since phase 3, and still honours an explicit exec', () => {
    expect(resolveCodexTransport(undefined)).toBe('app-server');
    expect(resolveCodexTransport('auto')).toBe('app-server');
    expect(resolveCodexTransport('app-server')).toBe('app-server');
    expect(resolveCodexTransport('exec')).toBe('exec');
  });
});

describe('CodexRuntime — the transport seam (ADR 261005-113107)', () => {
  /** A transport that records what it was asked and plays a scripted turn. */
  function recordingTransport(
    options: { persistent?: boolean; bindAs?: string; replaces?: string } = {}
  ) {
    const requests: Array<Parameters<CodexTransport['runTurn']>[0]> = [];
    const transport: CodexTransport = {
      kind: 'app-server',
      capabilities: options.persistent ? { supportsPersistentSession: true } : {},
      async *runTurn(request) {
        requests.push(request);
        request.onThreadBound(options.bindAs ?? 'thread-from-transport', options.replaces);
        yield { type: 'text_delta', data: { text: 'hi' } };
        yield {
          type: 'session_status',
          data: { sessionId: request.sessionId, terminalReason: 'completed' },
        };
        yield { type: 'done', data: { sessionId: request.sessionId } };
      },
      interrupt: vi.fn(async () => ({ outcome: 'acked' as const, runtime: 'codex' as const })),
      ...(options.persistent
        ? {
            getSessionWarmth: () => 'warm' as const,
            reapSession: vi.fn(async () => {}),
          }
        : {}),
      shutdown: vi.fn(async () => {}),
    };
    return { transport, requests };
  }

  async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const event of gen) out.push(event);
    return out;
  }

  it('hands the transport one resolved turn and persists the binding it reports', async () => {
    const db = createTestDb();
    const threadMap = new CodexThreadMap(db);
    const { transport, requests } = recordingTransport();
    const runtime = new CodexRuntime({
      threadMap,
      resolveBinary: async () => '/opt/codex',
      transport,
    });
    runtime.ensureSession('s1', { permissionMode: 'acceptEdits', cwd: '/project' });
    const events = await drain(runtime.sendMessage('s1', 'hello there', { cwd: '/project' }));

    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      binary: '/opt/codex',
      sessionId: 's1',
      boundThreadId: undefined,
      cwd: '/project',
      settings: { permissionMode: 'acceptEdits' },
      writableDirectories: [],
      launch: { home: 'person' },
    });
    // The prompt is buildCodexPrompt's output: the person's words last, untouched.
    expect(requests[0]!.prompt.endsWith('hello there')).toBe(true);
    expect(threadMap.get('s1')).toMatchObject({
      threadId: 'thread-from-transport',
      cwd: '/project',
    });
  });

  it('replaces a binding only when the transport names the thread it replaced', async () => {
    const db = createTestDb();
    const threadMap = new CodexThreadMap(db);
    threadMap.setThreadId('s1', 'old-thread', '/project');
    const { transport, requests } = recordingTransport({
      bindAs: 'new-thread',
      replaces: 'old-thread',
    });
    const runtime = new CodexRuntime({
      threadMap,
      resolveBinary: async () => '/opt/codex',
      transport,
    });
    await drain(runtime.sendMessage('s1', 'again', { cwd: '/project' }));
    expect(requests[0]!.boundThreadId).toBe('old-thread');
    expect(threadMap.getThreadId('s1')).toBe('new-thread');
  });

  it('merges the transport’s capabilities over the shared base, and exec changes nothing', () => {
    const db = createTestDb();
    const exec = new CodexRuntime({
      transport: 'exec',
      threadMap: new CodexThreadMap(db),
      resolveBinary: async () => '/opt/codex',
    });
    expect(exec.getCapabilities().supportsPersistentSession).toBe(false);
    expect(exec.getSessionWarmth).toBeUndefined();
    expect(exec.reapSession).toBeUndefined();
    expect(exec.settleOpenTurn).toBeUndefined();

    const { transport } = recordingTransport({ persistent: true });
    const onAppServer = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      resolveBinary: async () => '/opt/codex',
      transport,
    });
    expect(onAppServer.getCapabilities().supportsPersistentSession).toBe(true);
    expect(onAppServer.getCapabilities().supportsToolApproval).toBe(false);
    expect(onAppServer.getSessionWarmth?.('s')).toBe('warm');
    expect(onAppServer.settleOpenTurn).toBeDefined();
  });

  it('returns the transport’s interrupt receipt for an open turn, and not-running otherwise', async () => {
    const db = createTestDb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { transport } = recordingTransport();
    transport.runTurn = async function* (request) {
      yield { type: 'text_delta', data: { text: 'working' } };
      await gate;
      yield { type: 'done', data: { sessionId: request.sessionId } };
    };
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(db),
      resolveBinary: async () => '/opt/codex',
      transport,
    });
    await expect(runtime.interruptQuery('s1')).resolves.toMatchObject({ outcome: 'not-running' });
    const gen = runtime.sendMessage('s1', 'go', { cwd: '/project' });
    await gen.next();
    await expect(runtime.interruptQuery('s1')).resolves.toEqual({
      outcome: 'acked',
      runtime: 'codex',
    });
    expect(transport.interrupt).toHaveBeenCalledWith('s1');
    release();
    await drain(gen);
  });

  it('closes a turn whose transport ended without its done, so the session is never left busy', async () => {
    const { transport } = recordingTransport();
    transport.runTurn = async function* () {
      yield { type: 'text_delta', data: { text: 'partial' } };
    };
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      resolveBinary: async () => '/opt/codex',
      transport,
    });
    const events = await drain(runtime.sendMessage('s1', 'go', { cwd: '/project' }));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });
  describe('background work (spec §12)', () => {
    /** A persistent transport with the background-work members, wake under test control. */
    function backgroundTransport() {
      const recorded = recordingTransport({ persistent: true });
      let wakeListener: ((wake: BackgroundWake) => boolean) | undefined;
      Object.assign(recorded.transport, {
        onWake: (listener: typeof wakeListener) => {
          wakeListener = listener;
        },
        isSegmentPending: () => false,
        onDispatchGateChange: () => () => {},
        holdsBackgroundWork: () => true,
        isHelperWorking: () => false,
        stopTask: vi.fn(async () => ({ outcome: 'acked' as const, runtime: 'codex' as const })),
      });
      return { ...recorded, wake: (wake: BackgroundWake) => wakeListener?.(wake) ?? false };
    }
    function backgroundRuntime() {
      const recorded = backgroundTransport();
      const runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/opt/codex',
        transport: recorded.transport,
      });
      return { ...recorded, runtime };
    }
    /** A finished task carrying the context its turn handed the transport. */
    const finished = (context: unknown, overrides: Partial<BackgroundCompletion> = {}) => ({
      taskId: 'cmd-1',
      kind: 'bash' as const,
      label: 'npm test',
      status: 'completed' as const,
      summary: 'Exit code 0.\nall green',
      wakes: true,
      context,
      ...overrides,
    });
    /**
     * Take each wake the way the server does: hold the reserved runtime lock,
     * then read the turn. `lock: false` reads it without the lock, as a
     * consumer that gave up waiting does.
     */
    function project(runtime: CodexRuntime, lock = true) {
      const turns: Array<Promise<StreamEvent[]>> = [];
      runtime.onRuntimeTurn!((sessionId, events) => {
        turns.push(
          (async () => {
            const token = Symbol('wake');
            if (lock) {
              expect(runtime.acquireRuntimeLock!(sessionId, { on: () => {} }, token)).toBe(true);
            }
            const out: StreamEvent[] = [];
            try {
              for await (const event of events) out.push(event);
            } finally {
              if (lock) runtime.releaseLock(sessionId, `runtime:${sessionId}`, token);
            }
            return out;
          })()
        );
      });
      return turns;
    }

    it('wakes as the same agent, in the same folder, with the same grants', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      const identity = vi.spyOn(
        runtime as unknown as { identityPathFor: (cwd: string, agent?: string) => unknown },
        'identityPathFor'
      );
      const opts = {
        cwd: '/project',
        forAgent: '/agents/bea',
        systemPromptAppend: 'APPENDED-CONTEXT',
        additionalDirectories: [{ path: '/elsewhere/out', access: 'write' as const }],
        permissionMode: 'acceptEdits' as const,
        model: 'gpt-x',
        messageId: 'm-1',
        title: 'not carried',
      };
      await drain(runtime.sendMessage('s1', 'start the tests', opts));
      const turns = project(runtime);
      expect(
        wake({
          sessionId: 's1',
          completions: [finished(requests[0]!.wakeContext)],
          startTurn: true,
          notices: [],
        })
      ).toBe(true);
      const events = await turns[0]!;
      expect(events[0]).toEqual({
        type: 'background_task_done',
        data: { taskId: 'cmd-1', status: 'completed', summary: 'Exit code 0.\nall green' },
      });
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(requests).toHaveLength(2);
      const [first, woken] = requests as [(typeof requests)[0], (typeof requests)[0]];
      expect(woken).toMatchObject({ cwd: first.cwd, writableDirectories: ['/elsewhere/out'] });
      expect(woken.messageId).toBeUndefined();
      expect(woken.prompt).toContain('<background_update>');
      expect(woken.prompt).toContain('APPENDED-CONTEXT');
      // The same agent: identity resolved for the turn's own agent both times.
      expect(identity.mock.calls.map((call) => call[1])).toEqual(['/agents/bea', '/agents/bea']);
      // The woken turn passes the same context on, so a chain stays that agent.
      expect(woken.wakeContext).toEqual(first.wakeContext);
      // The notice is DorkOS's, never the session's preview.
      expect((await runtime.getSession('/project', 's1'))?.lastMessagePreview).toBe(
        'start the tests'
      );
    });

    it('runs a wake at the session’s CURRENT mode and model, never the starting turn’s', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      runtime.ensureSession('s1', { permissionMode: 'default', cwd: '/project' });
      // A scheduled run at Full access leaves a command running…
      await drain(
        runtime.sendMessage('s1', 'go', {
          cwd: '/project',
          permissionMode: 'bypassPermissions',
          model: 'gpt-old',
        })
      );
      expect(requests[0]!.settings).toMatchObject({
        permissionMode: 'bypassPermissions',
        model: 'gpt-old',
      });
      const turns = project(runtime);
      const context = requests[0]!.wakeContext;
      // …and the person sets Ask first and another model before it finishes.
      await runtime.updateSession('s1', { permissionMode: 'default', model: 'gpt-new' });
      wake({ sessionId: 's1', completions: [finished(context)], startTurn: true, notices: [] });
      await turns[0];
      expect(requests[1]!.settings).toMatchObject({ permissionMode: 'default', model: 'gpt-new' });
      // A chain carries nothing of the first turn's mode either.
      wake({
        sessionId: 's1',
        completions: [finished(requests[1]!.wakeContext)],
        startTurn: true,
        notices: [],
      });
      await turns[1];
      expect(requests[2]!.settings.permissionMode).toBe('default');
      // Raised only because the person raised it.
      await runtime.updateSession('s1', { permissionMode: 'acceptEdits' });
      wake({ sessionId: 's1', completions: [finished(context)], startTurn: true, notices: [] });
      await turns[2];
      expect(requests[3]!.settings.permissionMode).toBe('acceptEdits');
    });

    // Power flows downstream (spec `trusted-by-default-flip` §4): background
    // work a stranger's turn started wakes no looser than that turn ran.
    it('wakes a turn held to a ceiling at no looser than the ceiling', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      runtime.ensureSession('s1', { permissionMode: 'bypassPermissions', cwd: '/project' });
      await drain(
        runtime.sendMessage('s1', 'go', { cwd: '/project', permissionCeiling: 'runtime-default' })
      );
      expect(requests[0]!.settings.permissionMode).toBe('default');
      const turns = project(runtime);
      wake({
        sessionId: 's1',
        completions: [finished(requests[0]!.wakeContext)],
        startTurn: true,
        notices: [],
      });
      await turns[0];
      expect(requests[1]!.settings.permissionMode).toBe('default');
    });

    it('lets only the wake that holds the turn start a model turn; a drained one starts none and spends nothing', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      await drain(runtime.sendMessage('s1', 'go', { cwd: '/project' }));
      const context = requests[0]!.wakeContext;
      const streams: Array<AsyncIterable<StreamEvent>> = [];
      runtime.onRuntimeTurn!((_id, events) => streams.push(events));
      wake({ sessionId: 's1', completions: [finished(context)], startTurn: true, notices: [] });
      wake({
        sessionId: 's1',
        completions: [finished(context, { taskId: 'cmd-2' })],
        startTurn: true,
        notices: [],
      });
      // Wake 1 holds the session's runtime lock and has started reading.
      const token = Symbol('wake-1');
      expect(runtime.acquireRuntimeLock!('s1', { on: () => {} }, token)).toBe(true);
      const first = streams[0]![Symbol.asyncIterator]();
      expect((await first.next()).value).toMatchObject({ type: 'background_task_done' });
      // Wake 2 gave up waiting for the lock and is merely drained.
      const drained: StreamEvent[] = [];
      for await (const event of streams[1]!) drained.push(event);
      expect(drained.map((e) => e.type)).toEqual(['background_task_done', 'done']);
      expect(requests).toHaveLength(1);
      // Wake 1 runs its turn.
      for (let next = await first.next(); !next.done; next = await first.next()) void next;
      runtime.releaseLock('s1', 'runtime:s1', token);
      expect(requests).toHaveLength(2);
      // The drained wake spent none of the budget: two more turns still run.
      const turns = project(runtime);
      for (let i = 0; i < MAX_CONSECUTIVE_WAKES; i += 1) {
        wake({ sessionId: 's1', completions: [finished(context)], startTurn: true, notices: [] });
        await turns.at(-1);
      }
      expect(requests).toHaveLength(1 + MAX_CONSECUTIVE_WAKES);
    });

    it('shows a room turn’s finished work but starts no model turn (its tools are the room’s)', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      await drain(
        runtime.sendMessage('s1', 'go', {
          cwd: '/project',
          roomTurn: { roomId: 'r', authorId: 'a', turnId: 't' },
        })
      );
      expect(requests[0]!.wakeContext).toBeUndefined();
      const turns = project(runtime);
      wake({
        sessionId: 's1',
        completions: [finished(requests[0]!.wakeContext)],
        startTurn: true,
        notices: [],
      });
      expect((await turns[0]!).map((e) => e.type)).toEqual(['background_task_done', 'done']);
      expect(requests).toHaveLength(1);
    });

    it('starts no model turn for work from turns run differently', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      await drain(runtime.sendMessage('s1', 'a', { cwd: '/project', forAgent: '/agents/a' }));
      await drain(runtime.sendMessage('s1', 'b', { cwd: '/project', forAgent: '/agents/b' }));
      const turns = project(runtime);
      wake({
        sessionId: 's1',
        completions: [
          finished(requests[0]!.wakeContext),
          finished(requests[1]!.wakeContext, { taskId: 'cmd-2' }),
        ],
        startTurn: true,
        notices: [],
      });
      expect((await turns[0]!).filter((e) => e.type === 'background_task_done')).toHaveLength(2);
      expect(requests).toHaveLength(2);
    });

    it('never starts a model turn when read without the session’s runtime lock', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      await drain(runtime.sendMessage('s1', 'go', { cwd: '/project' }));
      const turns = project(runtime, false);
      wake({
        sessionId: 's1',
        completions: [finished(requests[0]!.wakeContext)],
        startTurn: true,
        notices: [],
      });
      expect((await turns[0]!).map((e) => e.type)).toEqual(['background_task_done', 'done']);
      expect(requests).toHaveLength(1);
    });

    it(`wakes at most ${MAX_CONSECUTIVE_WAKES} times in a row, until somebody sends a message`, async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      await drain(runtime.sendMessage('s1', 'go', { cwd: '/project' }));
      const context = requests[0]!.wakeContext;
      const turns = project(runtime);
      const once = async () => {
        wake({ sessionId: 's1', completions: [finished(context)], startTurn: true, notices: [] });
        return turns.at(-1)!;
      };
      for (let i = 0; i < MAX_CONSECUTIVE_WAKES; i += 1) await once();
      expect(requests).toHaveLength(1 + MAX_CONSECUTIVE_WAKES);
      const spent = await once();
      expect(spent.find((e) => e.type === 'system_status')).toEqual({
        type: 'system_status',
        data: { message: WAKE_BUDGET_SPENT_COPY },
      });
      expect(requests).toHaveLength(1 + MAX_CONSECUTIVE_WAKES);
      // A person's message resets the budget.
      await drain(runtime.sendMessage('s1', 'carry on', { cwd: '/project' }));
      await once();
      expect(requests).toHaveLength(3 + MAX_CONSECUTIVE_WAKES);
    });

    it('shows a finish that may not wake the model, and starts no turn', async () => {
      const { runtime, requests, wake } = backgroundRuntime();
      const turns = project(runtime);
      wake({
        sessionId: 's1',
        completions: [finished(undefined, { status: 'stopped', wakes: false })],
        startTurn: false,
        notices: ['lost it'],
      });
      expect((await turns[0]!).map((e) => e.type)).toEqual([
        'system_status',
        'background_task_done',
        'done',
      ]);
      expect(requests).toHaveLength(0);
    });

    it('tells listeners when a dispatched turn opens, and stops tasks through the transport', async () => {
      const { runtime } = backgroundRuntime();
      const dispatched: string[] = [];
      const off = runtime.onDispatchedTurn!((sessionId) => dispatched.push(sessionId));
      await drain(runtime.sendMessage('s1', 'go', { cwd: '/project' }));
      off();
      await drain(runtime.sendMessage('s1', 'again', { cwd: '/project' }));
      expect(dispatched).toEqual(['s1']);
      expect(runtime.holdsBackgroundWork!('s1')).toBe(true);
      expect(await runtime.stopTask('s1', 'cmd-1')).toEqual({ outcome: 'acked', runtime: 'codex' });
    });

    it('declares none of it on exec, where nothing outlives the turn', async () => {
      const runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/opt/codex',
        transport: 'exec',
      });
      expect(runtime.onRuntimeTurn).toBeUndefined();
      expect(runtime.isSegmentPending).toBeUndefined();
      expect(runtime.holdsBackgroundWork).toBeUndefined();
      expect(runtime.acquireRuntimeLock).toBeUndefined();
      expect((await runtime.stopTask('s1', 'x')).outcome).toBe('not-running');
    });
  });
});
