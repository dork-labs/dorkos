/**
 * What a Codex turn carries once `runtimes.dorkosTools` is on: the `dorkos` MCP
 * server in `CodexOptions.config.mcp_servers`, and the room verbs in its prompt
 * under Codex's own tool prefix (spec `tool-only-room-replies` §D4/§D11,
 * DOR-1613).
 *
 * These read the REAL options handed to the `Codex` constructor and the REAL
 * prompt handed to `runStreamed`, so an entry that is built but never passed to
 * the SDK fails here.
 *
 * ## The flag-OFF case is the important one
 *
 * This is a wiring change on the default path of every Codex turn in the
 * product, shipped behind a flag that is off. So "off changes nothing" is not a
 * nicety, it is the claim the flag makes — and it is asserted as a whole-object
 * comparison against the same turn with the module absent, not as an absence
 * check on one key, because an absence check passes while an unrelated field
 * quietly changes shape.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRegistryPort, ManagedMcpServerResolver } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/index.js';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { codexSimpleTurn, makeMockThread } from './codex-scenarios.js';

vi.mock('../check-dependencies.js', () => ({ checkCodexDependencies: vi.fn(() => []) }));
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(async () => null),
}));
vi.mock('../scan-skill-commands.js', () => ({ scanSkillCommands: vi.fn(() => []) }));

const envState = vi.hoisted(() => ({
  DORKOS_HOST: 'localhost',
  DORKOS_PORT: 4242,
  MCP_API_KEY: undefined as string | undefined,
}));

vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return { ...actual, env: envState };
});

const configState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config-manager.js')>();
  return {
    ...actual,
    configManager: {
      get: (key: string) => configState.value[key],
      getAll: () => configState.value,
    },
  };
});

vi.mock('../../../core/auth/mcp-local-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/auth/mcp-local-token.js')>();
  return { ...actual, getMcpLocalToken: () => 'dork_mcp_local_abc123' };
});

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }));

vi.mock('../../../../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/logger.js')>();
  return { ...actual, logger: { ...actual.logger, ...loggerMocks } };
});

/** Records every `Codex` construction and every prompt `runStreamed` receives. */
const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as (Record<string, unknown> | undefined)[],
  prompts: [] as string[],
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: Record<string, unknown>) {
      sdkMocks.constructorOptions.push(options);
    }
    startThread(): unknown {
      return {
        id: 'codex-thread-0001',
        runStreamed: async (prompt: string) => {
          sdkMocks.prompts.push(prompt);
          return { events: makeMockThread(codexSimpleTurn('ok')).runStreamed() };
        },
      };
    }
    resumeThread(): unknown {
      return this.startThread();
    }
  },
}));

/** A mesh registry reporting exactly one agent, rooted at `agentPath`. */
function meshWithAgent(agentPath: string): AgentRegistryPort {
  return {
    getByPath: (cwd: string) =>
      cwd === agentPath
        ? { id: '01JAGENT0000000000000000', name: 'researcher', displayName: 'Researcher' }
        : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  } as unknown as AgentRegistryPort;
}

/** Drain a sendMessage generator, discarding the events. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of gen) {
    // The constructor options and the prompt are what these tests read.
  }
}

/** The `mcp_servers` record the SDK was constructed with on the last turn. */
function lastMcpServers(): Record<string, Record<string, unknown>> {
  const options = sdkMocks.constructorOptions.at(-1) ?? {};
  const config = (options as { config?: { mcp_servers?: Record<string, never> } }).config;
  return (config?.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
}

describe('the dorkos tool server on a Codex turn', () => {
  let agentDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    sdkMocks.constructorOptions.length = 0;
    sdkMocks.prompts.length = 0;
    loggerMocks.warn.mockClear();
    envState.DORKOS_HOST = 'localhost';
    envState.DORKOS_PORT = 4242;
    envState.MCP_API_KEY = undefined;
    configState.value = { runtimes: { dorkosTools: true }, mcp: { enabled: true } };
    agentDir = await mkdtemp(path.join(tmpdir(), 'codex-dorkos-tools-'));
    await mkdir(path.join(agentDir, '.dork'), { recursive: true });
    await writeFile(
      path.join(agentDir, '.dork', 'agent.json'),
      JSON.stringify({
        id: '01JAGENT0000000000000000',
        name: 'researcher',
        description: 'Reads things carefully.',
        runtime: 'codex',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-01-01T00:00:00.000Z',
        registeredBy: 'test',
      }),
      'utf-8'
    );
    db = createTestDb();
    initAgentIdentityService(db);
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(agentDir, { recursive: true, force: true });
  });

  function makeRuntime(opts: { managed?: ManagedMcpServerResolver } = {}): CodexRuntime {
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(db),
      resolveBinary: async () => '/bin/codex',
      defaultCwd: agentDir,
      mcpUiUrl: 'http://localhost:4242/codex-ui-mcp',
    });
    runtime.setMeshCore(meshWithAgent(agentDir));
    if (opts.managed) runtime.setManagedMcpServers(opts.managed);
    return runtime;
  }

  describe('flag ON', () => {
    it('injects a streamable-HTTP dorkos server naming both headers by env var', async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));

      const dorkos = lastMcpServers()['dorkos'];
      expect(dorkos).toBeDefined();
      expect(dorkos?.['url']).toBe('http://localhost:4242/mcp');
      // `env_http_headers`, never `http_headers` — see the argv case below.
      expect(dorkos?.['http_headers']).toBeUndefined();
      expect(dorkos?.['env_http_headers']).toEqual({
        Authorization: 'DORKOS_MCP_HEADER_AUTHORIZATION',
        // Without this one `callerAuthor` falls through to the install owner and
        // the agent posts in the operator's name.
        'x-dorkos-agent': 'DORKOS_MCP_HEADER_AGENT_TOKEN',
      });
    });

    it('keeps both credential VALUES out of the config, and puts them in the env', async () => {
      // The vulnerability this shape exists for. `CodexOptions.config` is
      // flattened by the SDK into `--config key=value` arguments on the
      // `codex exec` command line, so anything written there is in the spawned
      // process's argv — readable by any process running as this user, with a
      // bare `ps`. Both values are credentials: one is the MCP bearer for this
      // whole instance, the other is an identity that can post in rooms AS this
      // agent.
      //
      // Asserted by serialising the WHOLE options object and searching it,
      // rather than by checking the one key they used to live under: the SDK
      // flattens nested config, so a value could reappear under any path, and a
      // key-specific check would not notice.
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));

      const options = sdkMocks.constructorOptions.at(-1) as {
        config?: unknown;
        env?: Record<string, string>;
      };
      const bearer = 'dork_mcp_local_abc123';
      const agentToken = options.env?.['DORKOS_MCP_HEADER_AGENT_TOKEN'];

      // The env carries them — that is the whole point of the redirection.
      expect(options.env?.['DORKOS_MCP_HEADER_AUTHORIZATION']).toBe(`Bearer ${bearer}`);
      expect(agentToken).toEqual(expect.any(String));
      expect(agentToken).not.toBe('');

      // And the config carries neither, anywhere in it.
      const serializedConfig = JSON.stringify(options.config ?? {});
      expect(serializedConfig).not.toContain(bearer);
      expect(serializedConfig).not.toContain(agentToken);
      expect(serializedConfig).not.toContain('Bearer ');
    });

    it('still inherits the parent environment when it adds the header vars', async () => {
      // Setting `CodexOptions.env` at all stops the SDK inheriting `process.env`
      // wholesale, so the header vars must not cost the subprocess its PATH.
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const env = (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env;
      expect(env?.['PATH']).toBe(process.env['PATH']);
      // The agent's own identity var still rides alongside them.
      expect(env?.['DORKOS_AGENT_TOKEN']).toEqual(expect.any(String));
    });

    it('never mints a URL containing 127.0.0.1, including the UI bridge (DOR-723)', async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const urls = Object.values(lastMcpServers()).map((entry) => String(entry['url']));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).not.toContain('127.0.0.1');
    });

    it('leaves the dorkos_ui bridge alongside it, not replaced by it', async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      expect(Object.keys(lastMcpServers()).sort()).toEqual(['dorkos', 'dorkos_ui']);
    });

    it('mints a fresh identity token per TURN, so a long session cannot go stale', async () => {
      // The 30-day absolute fuse is why this is per turn rather than per
      // session: a cached credential would eventually 401 on every room write.
      // Read off the ENV now, which is where the value lives.
      const agentTokenOf = (): string | undefined =>
        (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env?.[
          'DORKOS_MCP_HEADER_AGENT_TOKEN'
        ];
      const runtime = makeRuntime();
      await drain(runtime.sendMessage('s1', 'one', { cwd: agentDir }));
      const first = agentTokenOf();
      await drain(runtime.sendMessage('s1', 'two', { cwd: agentDir }));
      const second = agentTokenOf();
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
    });

    it("teaches the room verbs under codex's prefix, never claude-code's bare names", async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const prompt = sdkMocks.prompts.at(-1) ?? '';
      expect(prompt).toContain('<room_tools>');
      expect(prompt).toContain('mcp__dorkos__post_to_room');
      expect(prompt).toContain('mcp__dorkos__react_to_room_entry');
    });

    it('DROPS a user server named dorkos and says so, rather than silently', async () => {
      // The DOR-1613 complaint about this branch: the drop is correct — DorkOS
      // must own the name — but a person watching their own tools vanish with
      // no diagnostic anywhere has nothing to go on.
      const managed: ManagedMcpServerResolver = {
        injectableServersForCwd: () => ({
          dorkos: { transport: 'stdio', command: '/bin/their-server' },
        }),
      } as unknown as ManagedMcpServerResolver;
      await drain(makeRuntime({ managed }).sendMessage('s1', 'hello', { cwd: agentDir }));

      // Ours survived; theirs did not overwrite it.
      const dorkos = lastMcpServers()['dorkos'];
      expect(dorkos?.['url']).toBe('http://localhost:4242/mcp');
      expect(dorkos?.['command']).toBeUndefined();

      const warned = loggerMocks.warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((line) => line.includes('"dorkos"') && line.includes('reserve'))).toBe(
        true
      );
    });
  });

  describe('flag OFF', () => {
    it('produces byte-identical SDK options to a turn built without the feature', async () => {
      // The claim the flag makes, asserted as a whole-object comparison: an
      // absence check on the `dorkos` key would pass while some neighbouring
      // field changed shape.
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: true } };
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const withFlagOff = sdkMocks.constructorOptions.at(-1);

      expect(withFlagOff).toEqual({
        codexPathOverride: '/bin/codex',
        config: { mcp_servers: { dorkos_ui: { url: 'http://localhost:4242/codex-ui-mcp' } } },
        env: expect.any(Object),
      });
      expect(lastMcpServers()['dorkos']).toBeUndefined();
    });

    it('names no room tool in the prompt, because the session has none', async () => {
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: true } };
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const prompt = sdkMocks.prompts.at(-1) ?? '';
      expect(prompt).not.toContain('<room_tools>');
      expect(prompt).not.toContain('post_to_room');
    });

    it('lets a user server called dorkos through untouched, and warns about nothing', async () => {
      // The name is reserved only on the turns DorkOS actually injects it. Off,
      // DorkOS wants nothing called `dorkos`, so dropping this person's own
      // server of that name would take something and give nothing back — and it
      // would make the flag-OFF path stop being byte-identical to what shipped
      // before the feature, which is the one promise the flag makes.
      //
      // OpenCode already behaved this way (its desired set simply has no
      // `dorkos` entry when the experiment is off), so this is also what keeps
      // the two runtimes answering the same question the same way.
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: true } };
      const managed: ManagedMcpServerResolver = {
        injectableServersForCwd: () => ({
          dorkos: { transport: 'stdio', command: '/bin/their-server' },
        }),
      } as unknown as ManagedMcpServerResolver;
      await drain(makeRuntime({ managed }).sendMessage('s1', 'hello', { cwd: agentDir }));

      // Theirs, verbatim — same name, their command, and no URL of ours.
      expect(lastMcpServers()['dorkos']).toEqual({ command: '/bin/their-server' });
      const warned = loggerMocks.warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((line) => line.includes('reserve'))).toBe(false);
    });
  });
});
