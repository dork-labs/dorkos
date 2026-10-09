import { once } from 'node:events';
import { retireOriginalRoomResponderStream } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import {
  getOrCreateProjector,
  disposeProjector,
  SessionStateProjector,
} from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
async function actualCodexProducerPrincipal(
  principals: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>['principals'],
  expectedCanonicalCwd: string
) {
  const env = sdkMocks.constructorOptions.at(-1)?.env;
  if (
    !env ||
    typeof env !== 'object' ||
    !('DORKOS_CONNECTOR_MCP_AUTHORIZATION' in env) ||
    typeof env.DORKOS_CONNECTOR_MCP_AUTHORIZATION !== 'string' ||
    !env.DORKOS_CONNECTOR_MCP_AUTHORIZATION.startsWith('Bearer ')
  )
    throw new Error('Actual original native SDK bearer is missing.');
  const resolved = await principals.resolve({
    bearer: env.DORKOS_CONNECTOR_MCP_AUTHORIZATION.slice('Bearer '.length),
    expectedRuntime: 'codex',
    expectedCanonicalCwd,
  });
  if (resolved.status !== 'resolved')
    throw new Error('Actual original native SDK principal is unavailable.');
  return resolved.principal;
}
import {
  captureOriginalPreparedNativeTime,
  readOriginalPreparedNativePrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';
import { nativeRoomAuthorityFixture } from '../../../canvas/doc-channel/writes/__tests__/authority-fixtures.js';
import {
  submitCurrentDocEvent,
  prepareServiceOriginalRoomResponder,
  commitServiceOriginalRoomResponder,
  replayServiceCurrentDoc,
} from '../../../canvas/doc-channel/service.js';
import { retainDocHistory } from '../../../canvas/doc-channel/retention.js';
import { wakeAuthorizedRoomDue } from '../../../canvas/doc-channel/authorization.js';
import { docDocumentGeneration } from '../../../canvas/doc-channel/identity/incarnation.js';
import { randomUUID } from 'node:crypto';
import { configManager } from '../../../core/config-manager.js';
import { CreditsUnavailableError } from '../../../core/cloud/credits-protocols.js';
import { canvasDocuments, connectorRuntimeBindings, eq, sql } from '@dorkos/db';
import {
  retireCodexPreparedRoomResponder,
  readCodexPreparedRoomResponder,
} from '../codex-runtime.js';
import { createDb, runMigrations } from '@dorkos/db';
import {
  ConnectorRuntimePrincipalService,
  readCurrentNativePrincipal,
  captureNativePrincipalTime,
} from '../../../connectors/principal/runtime-principal-service.js';
import {
  readCodexNativeOperation,
  sendCodexOriginalLockedMessage,
  startCodexCommittedRoomResponder,
} from '../codex-runtime.js';
/**
 * What every agent-bound Codex turn carries: the `dorkos` MCP server in
 * `CodexOptions.config.mcp_servers`, and the room verbs in its prompt under
 * Codex's own tool prefix (spec `tool-only-room-replies` §D4/§D11).
 *
 * These read the REAL options handed to the `Codex` constructor and the REAL
 * prompt handed to `runStreamed`, so an entry that is built but never passed to
 * the SDK fails here.
 *
 * ## There is no setting any more
 *
 * The experiment that used to gate this graduated and was removed (DOR-2099).
 * What remains are the two postures that are facts about the turn rather than
 * choices: a directory hosting no registered agent, and a runtime that boot
 * never handed a loopback boundary. Both are exercised below, because both
 * still decide whether an agent can speak in a room.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
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
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { ConnectorTurnLeaseSupervisorFactory } from '../../connectors/connector-turn-lease-supervisor.js';
import { createRuntimeTurnRenewalConformanceFixture } from '../../connectors/__tests__/turn-renewal-conformance-fixture.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS } from '../../connector-tools.js';
import { CONNECTOR_REQUEST_LIVE_HOLD_MS } from '../../../connectors/runtime-capability-scope.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

vi.mock('../check-dependencies.js', () => ({ checkCodexDependencies: vi.fn(() => []) }));
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(async () => null),
}));
vi.mock('../scan-skill-commands.js', () => ({ scanSkillCommands: vi.fn(() => []) }));

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

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }));

vi.mock('../../../../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/logger.js')>();
  return { ...actual, logger: { ...actual.logger, ...loggerMocks } };
});

/** Records every `Codex` construction and every prompt `runStreamed` receives. */
const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as (Record<string, unknown> | undefined)[],
  prompts: [] as string[],
  behavior: 'complete' as
    | 'complete'
    | 'fail'
    | 'lazy-fail'
    | 'wait-for-abort'
    | 'park-past-abort'
    | 'room-wait-abort-close',
  releaseParked: undefined as (() => void) | undefined,
  waitingSignal: undefined as AbortSignal | undefined,
  releaseWaiting: undefined as (() => void) | undefined,
  waitingChild: undefined as
    import('node:child_process').ChildProcessWithoutNullStreams | undefined,
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: Record<string, unknown>) {
      sdkMocks.constructorOptions.push(options);
    }
    startThread(): unknown {
      return {
        id: 'codex-thread-0001',
        runStreamed: async (prompt: string, options?: { signal?: AbortSignal }) => {
          sdkMocks.prompts.push(prompt);
          if (sdkMocks.behavior === 'fail') throw new Error('codex runtime failed');
          if (sdkMocks.behavior === 'lazy-fail')
            return {
              events: (async function* () {
                throw new Error('lazy dispatch failed');
                yield;
              })(),
            };
          if (sdkMocks.behavior === 'wait-for-abort') {
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => {
                  const error = new Error('aborted');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true }
              );
            });
          }
          if (sdkMocks.behavior === 'room-wait-abort-close') {
            const signal = options?.signal;
            if (!signal) throw new Error('Original SDK cancellation signal missing');
            const { spawn } = await import('node:child_process');
            const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
              stdio: 'pipe',
            });
            const closed = once(child, 'close');
            sdkMocks.waitingChild = child;
            sdkMocks.waitingSignal = signal;
            await new Promise<void>((resolve) => {
              sdkMocks.releaseWaiting = resolve;
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
            child.kill('SIGTERM');
            await closed;
            const error = new Error('Original native pending read aborted after physical close');
            error.name = 'AbortError';
            throw error;
          }
          if (sdkMocks.behavior === 'park-past-abort') {
            await new Promise<void>((resolve) => {
              sdkMocks.releaseParked = resolve;
            });
          }
          return await makeMockThread(codexSimpleTurn('ok')).runStreamed();
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

  type NativeFixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
  const selectedNativeCase = 'same-target two batches retain busy second original';
  let selectedNativeOwner:
    | {
        fixture: Promise<NativeFixture>;
        run(work: () => Promise<void>): Promise<void>;
        drain(): Promise<void>;
      }
    | undefined;

  beforeEach(async () => {
    sdkMocks.constructorOptions.length = 0;
    sdkMocks.prompts.length = 0;
    sdkMocks.behavior = 'complete';
    sdkMocks.releaseParked = undefined;
    sdkMocks.waitingSignal = undefined;
    sdkMocks.releaseWaiting = undefined;
    sdkMocks.waitingChild = undefined;
    loggerMocks.warn.mockClear();
    configState.value = { mcp: { enabled: true } };
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

  beforeEach(async (context) => {
    selectedNativeOwner = undefined;
    if (
      context.task.name !==
      `consumes genuine native COMMIT/private FIRST at Codex SDK boundary: ${selectedNativeCase}`
    )
      return;
    let active = true;
    let bodyPending: Promise<void> | undefined;
    let fixtureCleanup: (() => Promise<void>) | undefined;
    let draining: Promise<void> | undefined;
    const assertActive = () => {
      if (!active) throw new Error('Selected native case ended before admission.');
    };
    const pending = nativeRoomAuthorityFixture(
      agentDir,
      'codex',
      'native-source',
      '01JAGENT0000000000000000'
    ).then((h) => {
      const originalCleanup = h.cleanup;
      let cleanupPending: Promise<void> | undefined;
      fixtureCleanup = () => (cleanupPending ??= Promise.resolve().then(() => originalCleanup()));
      h.cleanup = fixtureCleanup;
      assertActive();
      return h;
    });
    void pending.catch(() => {});
    selectedNativeOwner = {
      fixture: pending,
      run(work) {
        assertActive();
        bodyPending = work();
        void bodyPending.catch(() => {});
        return bodyPending;
      },
      drain() {
        active = false;
        draining ??= (async () => {
          await Promise.allSettled([pending]);
          // The body retains its original prepared-owner/producer stop-before-join cleanup.
          // Keep its DB and agent directory alive until that entire body has settled.
          if (bodyPending) await Promise.allSettled([bodyPending]);
          // Also owns a late fixture when setup timed out and the body was skipped.
          if (fixtureCleanup) await fixtureCleanup();
        })();
        return draining;
      },
    };
    await pending;
  });

  afterEach(async () => {
    await selectedNativeOwner?.drain();
    selectedNativeOwner = undefined;
    resetAgentIdentityService();
    await rm(agentDir, { recursive: true, force: true });
  });

  function connectorPort(
    bearers: readonly string[] = ['connector-turn-secret']
  ): ConnectorRuntimePrincipalPort {
    let turn = 0;
    return {
      openTurn: vi.fn().mockImplementation(async () => {
        const index = Math.min(turn, bearers.length - 1);
        const bearer = bearers[index] ?? 'connector-turn-secret';
        turn += 1;
        return {
          bindingId: `binding-${turn}`,
          bearer,
          expiresAt: '2099-01-01T00:00:00.000Z',
          renewalPermit: Object.freeze({}) as never,
        };
      }),
      renew: vi.fn(),
      resolve: vi.fn(),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeRuntime(
    opts: {
      managed?: ManagedMcpServerResolver;
      runtimeTools?: ConnectorRuntimePrincipalPort | false;
      accessSnapshot?: () => Promise<{ accountCount: number; revision: string }>;
    } = {}
  ): CodexRuntime {
    const runtime = new CodexRuntime({
      transport: 'exec',
      threadMap: new CodexThreadMap(db),
      resolveBinary: async () => '/bin/codex',
      defaultCwd: agentDir,
    });
    runtime.setMeshCore(meshWithAgent(agentDir));
    if (opts.runtimeTools !== false) {
      runtime.setConnectorRuntimeTools({
        principals: opts.runtimeTools ?? connectorPort(),
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
        ...(opts.accessSnapshot ? { accessSnapshot: opts.accessSnapshot } : {}),
      });
    }
    if (opts.managed) runtime.setManagedMcpServers(opts.managed);
    return runtime;
  }

  describe('an agent-bound turn', () => {
    it('injects the agent route with the complete turn binding via env vars', async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));

      const dorkos = lastMcpServers()['dorkos'];
      expect(dorkos).toBeDefined();
      expect(dorkos?.['url']).toBe('http://127.0.0.1:4341/agent-mcp');
      // `env_http_headers`, never `http_headers` — see the argv case below.
      expect(dorkos?.['http_headers']).toBeUndefined();
      expect(dorkos?.['env_http_headers']).toEqual({
        Authorization: 'DORKOS_CONNECTOR_MCP_AUTHORIZATION',
        'X-DorkOS-Connector-Runtime': 'DORKOS_CONNECTOR_MCP_RUNTIME',
        'X-DorkOS-Connector-Cwd': 'DORKOS_CONNECTOR_MCP_CWD',
      });
    });

    it('keeps the turn credential out of argv-visible config', async () => {
      // The vulnerability this shape exists for. `CodexOptions.config` is
      // flattened by the SDK into `--config key=value` arguments on the
      // `codex exec` command line, so anything written there is in the spawned
      // process's argv — readable by any process running as this user, with a
      // bare `ps`.
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
      const bearer = 'connector-turn-secret';

      // The env carries them — that is the whole point of the redirection.
      expect(options.env?.['DORKOS_CONNECTOR_MCP_AUTHORIZATION']).toBe(`Bearer ${bearer}`);
      expect(options.env?.['DORKOS_CONNECTOR_MCP_RUNTIME']).toBe('codex');
      expect(options.env?.['DORKOS_CONNECTOR_MCP_CWD']).toBe(encodeURIComponent(agentDir));

      // And the config carries no credential, anywhere in it.
      const serializedConfig = JSON.stringify(options.config ?? {});
      expect(serializedConfig).not.toContain(bearer);
      expect(serializedConfig).not.toContain('Bearer ');
    });

    it('keeps the projected runtime baseline when it adds the header vars', async () => {
      // Setting `CodexOptions.env` replaces SDK inheritance, so the projected
      // baseline and the private turn identity must be passed together.
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      const env = (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env;
      expect(env?.['PATH']).toBe(process.env['PATH']);
      // The agent's own identity var still rides alongside them.
      expect(env?.['DORKOS_AGENT_TOKEN']).toEqual(expect.any(String));
    });

    it('dials the dedicated IPv4-loopback route returned by the listener', async () => {
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      expect(lastMcpServers()['dorkos']?.['url']).toBe('http://127.0.0.1:4341/agent-mcp');
    });

    it('sits beside the connections server and nothing else', async () => {
      // There used to be a third, `dorkos_ui`, injected on every turn to carry
      // one stubbed copy of `control_ui`. It is retired (spec
      // `canvas-agent-seat` §5): `control_ui` is a `ui` capability on the
      // `dorkos` server now, with a real session behind it.
      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));
      expect(Object.keys(lastMcpServers()).sort()).toEqual(['dorkos', 'dorkos_connections']);
    });

    it('uses a fresh turn-bound bearer on every turn', async () => {
      const bearerOf = (): string | undefined =>
        (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env?.[
          'DORKOS_CONNECTOR_MCP_AUTHORIZATION'
        ];
      const runtime = makeRuntime({ runtimeTools: connectorPort(['turn-one', 'turn-two']) });
      await drain(runtime.sendMessage('s1', 'one', { cwd: agentDir }));
      const first = bearerOf();
      await drain(runtime.sendMessage('s1', 'two', { cwd: agentDir }));
      const second = bearerOf();
      expect(first).toBe('Bearer turn-one');
      expect(second).toBe('Bearer turn-two');
    });

    it('keeps agent tools available when login is on and public MCP is off', async () => {
      configState.value = { mcp: { enabled: false }, auth: { enabled: true } };

      await drain(makeRuntime().sendMessage('s1', 'hello', { cwd: agentDir }));

      expect(lastMcpServers()['dorkos']?.['url']).toBe('http://127.0.0.1:4341/agent-mcp');
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
      expect(dorkos?.['url']).toBe('http://127.0.0.1:4341/agent-mcp');
      expect(dorkos?.['command']).toBeUndefined();

      const warned = loggerMocks.warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((line) => line.includes('"dorkos"') && line.includes('reserve'))).toBe(
        true
      );
    });
  });

  describe('connector runtime binding', () => {
    it('sends fresh account awareness on a resumed thread', async () => {
      let revision = 'grant-one';
      const runtime = makeRuntime({ accessSnapshot: async () => ({ accountCount: 1, revision }) });
      await drain(
        runtime.sendMessage('s-awareness', 'what connections do you have?', { cwd: agentDir })
      );
      expect(sdkMocks.prompts.at(-1)).toContain(
        'mcp__dorkos_connections__connectors.list_granted_connections'
      );
      expect(sdkMocks.prompts.at(-1)).not.toContain('Access changed');
      revision = 'different-operation-same-count';
      await drain(runtime.sendMessage('s-awareness', 'what changed?', { cwd: agentDir }));
      expect(sdkMocks.prompts.at(-1)).toContain('Access changed');
      expect(sdkMocks.prompts.at(-1)).toContain('Accounts this agent session can use right now: 1');
      expect(JSON.stringify(sdkMocks.constructorOptions.at(-1))).toContain('dorkos_connections');
      expect(sdkMocks.prompts.at(-1)).not.toContain(revision);
    });

    it('keeps a changed-access notice owed when lazy SDK iteration fails before delivery', async () => {
      let revision = 'one';
      const runtime = makeRuntime({ accessSnapshot: async () => ({ accountCount: 1, revision }) });
      await drain(runtime.sendMessage('lazy-awareness', 'first', { cwd: agentDir }));
      revision = 'two';
      const manifestPath = path.join(agentDir, '.dork', 'agent.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, description: 'Fresh identity after edit' })
      );
      sdkMocks.behavior = 'lazy-fail';
      await drain(runtime.sendMessage('lazy-awareness', 'failed', { cwd: agentDir }));
      sdkMocks.behavior = 'complete';
      await drain(runtime.sendMessage('lazy-awareness', 'retry', { cwd: agentDir }));
      expect(sdkMocks.prompts.at(-1)).toContain('Access changed');
      expect(sdkMocks.prompts.at(-1)).toContain('Fresh identity after edit');
      await drain(runtime.sendMessage('lazy-awareness', 'delivered', { cwd: agentDir }));
      expect(sdkMocks.prompts.at(-1)).not.toContain('Access changed');
      expect(sdkMocks.prompts.at(-1)).not.toContain('Fresh identity after edit');
    });

    it('does not claim account tools when the connector injection is absent', async () => {
      await drain(
        makeRuntime({ runtimeTools: false }).sendMessage('no-accounts', 'hello', { cwd: agentDir })
      );
      expect(sdkMocks.prompts.at(-1)).not.toContain('<accounts_access>');
    });

    it('injects independently of external MCP posture and revokes on terminal completion', async () => {
      configState.value = { mcp: { enabled: false } };
      const principals = connectorPort();
      const stop = vi.fn();
      vi.mocked(principals.revoke).mockImplementation(async () => {
        const token = vi.mocked(principals.openTurn).mock.calls[0]![1].nativeOperation!;
        expect(readCodexNativeOperation(token)).toBeUndefined();
      });
      vi.mocked(principals.openTurn).mockImplementationOnce(async (_input, ownership) => {
        expect(ownership.isCurrent()).toBe(true);
        expect(ownership.nativeOperation).toBeDefined();
        expect(readCodexNativeOperation(ownership.nativeOperation!)).toMatchObject({
          runtime: 'codex',
          canonicalSessionId: _input.canonicalSessionId,
          agentPath: _input.agentPath,
          canonicalCwd: _input.canonicalCwd,
          signal: _input.signal,
        });
        expect(readCodexNativeOperation(Object.freeze({}))).toBeUndefined();
        return {
          bindingId: 'binding-1',
          bearer: 'connector-turn-secret',
          expiresAt: '2099-01-01T00:00:00.000Z',
          renewalPermit: {} as never,
        };
      });
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          new Set([
            'connectors.execute_read',
            'connectors.execute_write',
            'connectors.execute_destructive',
          ]).has(id),
        createLeaseSupervisor: vi.fn(() => ({
          state: 'active' as const,
          stop,
          assertUsable: vi.fn(),
        })),
      });

      await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

      expect(principals.openTurn).toHaveBeenCalledWith(
        {
          runtime: 'codex',
          canonicalSessionId: 's1',
          agentPath: agentDir,
          canonicalCwd: agentDir,
          signal: expect.any(AbortSignal),
        },
        { isCurrent: expect.any(Function), nativeOperation: expect.any(Object) }
      );
      expect(lastMcpServers()['dorkos_connections']?.['url']).toBe('http://127.0.0.1:4341/mcp');
      // Codex's own default (five minutes) is shorter than an access request
      // holds for the person's answer, so the server states a ceiling past it.
      expect(lastMcpServers()['dorkos_connections']?.['tool_timeout_sec']).toBe(
        CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS / 1000
      );
      expect(CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS).toBeGreaterThan(CONNECTOR_REQUEST_LIVE_HOLD_MS);
      const options = sdkMocks.constructorOptions.at(-1) as {
        config?: unknown;
        env?: Record<string, string>;
      };
      expect(JSON.stringify(options.config)).not.toContain('connector-turn-secret');
      expect(options.env?.['DORKOS_CONNECTOR_MCP_AUTHORIZATION']).toBe(
        'Bearer connector-turn-secret'
      );
      expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_terminal');
      const token = vi.mocked(principals.openTurn).mock.calls[0]![1].nativeOperation!;
      expect(readCodexNativeOperation(token)).toBeUndefined();
      expect(stop).toHaveBeenCalledBefore(vi.mocked(principals.revoke));
      expect(vi.mocked(principals.openTurn).mock.calls[0]?.[1].isCurrent()).toBe(false);
    });

    it('binds the native turn to a FILE row and retires before a held direct return settles', async () => {
      let fileDb: ReturnType<typeof createDb> | undefined;
      let runtime: ReturnType<typeof makeRuntime> | undefined;
      let stream: ReturnType<typeof sendCodexOriginalLockedMessage>;
      let finished: Promise<unknown> | undefined;
      let restoreOpen: (() => void) | undefined;
      let restorePublicSend: (() => void) | undefined;
      let failed = false;
      let primary: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          primary = cause;
        }
      };
      try {
        fileDb = createDb(path.join(agentDir, 'native.sqlite'));
        const owningDb = fileDb;
        runMigrations(owningDb);
        const principals = new ConnectorRuntimePrincipalService({
          db: owningDb,
          authority: {
            authorizeTurn: async () => ({
              owner: { kind: 'local_install', installationId: 'native-install' },
              agentId: '01JAGENT0000000000000000',
            }),
            revalidateTurn: async () => true,
          },
        });
        await principals.initializeBoot();
        let token: object | undefined;
        let principal:
          | import('../../../connectors/principal/server-principal.js').ServerPrincipalProof
          | undefined;
        const open = principals.openTurn.bind(principals);
        const openSpy = vi
          .spyOn(principals, 'openTurn')
          .mockImplementation(async (input, ownership) => {
            token = ownership.nativeOperation;
            expect(readCodexNativeOperation(token!)).toMatchObject({
              canonicalSessionId: input.canonicalSessionId,
              signal: input.signal,
            });
            const binding = await open(input, ownership);
            const resolved = await principals.resolve({
              bearer: binding.bearer,
              expectedRuntime: input.runtime,
              expectedCanonicalCwd: input.canonicalCwd,
            });
            if (resolved.status !== 'resolved')
              throw new Error('Genuine runtime binding did not resolve');
            principal = resolved.principal;
            const peer = await open({ ...input, canonicalSessionId: 'wrong-live-peer' }, ownership);
            const peerResolved = await principals.resolve({
              bearer: peer.bearer,
              expectedRuntime: input.runtime,
              expectedCanonicalCwd: input.canonicalCwd,
            });
            if (peerResolved.status !== 'resolved')
              throw new Error('Genuine legacy peer binding did not resolve');
            owningDb!.transaction((tx) => {
              expect(
                readCurrentNativePrincipal(
                  principals,
                  owningDb,
                  peerResolved.principal,
                  tx,
                  captureNativePrincipalTime(principals, owningDb, peerResolved.principal)
                )
              ).toBeUndefined();
            });
            owningDb!.transaction((tx) => {
              expect(
                readCurrentNativePrincipal(
                  principals,
                  owningDb,
                  principal!,
                  tx,
                  captureNativePrincipalTime(principals, owningDb, principal!)
                )?.id
              ).toBe(binding.bindingId);
            });
            return binding;
          });
        restoreOpen = () => openSpy.mockRestore();
        sdkMocks.behavior = 'park-past-abort';
        runtime = makeRuntime({ runtimeTools: principals });
        const holder = { on: vi.fn() };
        expect(runtime.acquireLock('native-original', 'native-client', holder)).toBe(true);
        const publicSend = vi.spyOn(runtime, 'sendMessage').mockImplementation(() => {
          throw new Error('Public runner is not authority');
        });
        stream = sendCodexOriginalLockedMessage(
          runtime,
          'native-original',
          'hello',
          { cwd: agentDir },
          holder,
          'native-original'
        )!;
        expect(publicSend).not.toHaveBeenCalled();
        restorePublicSend = () => publicSend.mockRestore();
        finished = drain(stream);
        await vi.waitFor(() => expect(sdkMocks.releaseParked).toEqual(expect.any(Function)));
        expect(readCodexNativeOperation(token!)).toBeDefined();
        const returned = stream.return(undefined);
        expect(readCodexNativeOperation(token!)).toBeUndefined();
        owningDb!.transaction((tx) => {
          expect(
            readCurrentNativePrincipal(
              principals,
              owningDb,
              principal!,
              tx,
              captureNativePrincipalTime(principals, owningDb, principal!)
            )
          ).toBeUndefined();
        });
        sdkMocks.releaseParked!();
        await returned;
        await finished;
      } catch (cause) {
        remember(cause);
      } finally {
        // Every duty is attempted, even when setup or a prior cleanup throws undefined.
        try {
          sdkMocks.releaseParked?.();
        } catch (cause) {
          remember(cause);
        }
        try {
          if (stream) await stream.return(undefined);
        } catch (cause) {
          remember(cause);
        }
        try {
          if (finished) await finished;
        } catch (cause) {
          remember(cause);
        }
        try {
          runtime?.releaseLock('native-original', 'native-client');
        } catch (cause) {
          remember(cause);
        }
        try {
          restorePublicSend?.();
        } catch (cause) {
          remember(cause);
        }
        try {
          restoreOpen?.();
        } catch (cause) {
          remember(cause);
        }
        try {
          fileDb?.$client.close();
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw primary;
    });

    it.each([
      'post-open Error',
      'post-open undefined',
      'post-migration Error',
      'post-migration undefined',
      'post-boot Error',
      'post-boot undefined',
    ] as const)('closes the actual Codex FILE after setup failure: %s', async (stage) => {
      const primary = stage.endsWith('undefined') ? undefined : new Error(stage);
      const secondary = new Error('secondary close failure after actual close');
      let owningDb: ReturnType<typeof createDb> | undefined;
      let failed = false;
      let first: unknown;
      let closes = 0;
      let afterCloseDuty = false;
      let restorePrepare: (() => void) | undefined;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      // Join this scope to its captured cleanup before returning or reporting failure.
      const drainOriginalCleanup = async () => {
        try {
          if (owningDb) {
            closes++;
            owningDb.$client.close();
          }
          throw secondary;
        } catch (cause) {
          remember(cause);
        }
        // A prior secondary failure must not skip the next independently owned duty.
        try {
          restorePrepare?.();
          afterCloseDuty = true;
        } catch (cause) {
          remember(cause);
        }
      };
      try {
        owningDb = createDb(path.join(agentDir, `setup-${stage.replaceAll(' ', '-')}.sqlite`));
        const prepare = vi.spyOn(owningDb.$client, 'prepare');
        restorePrepare = () => prepare.mockRestore();
        if (stage.startsWith('post-open')) throw primary;
        runMigrations(owningDb);
        if (stage.startsWith('post-migration')) throw primary;
        const principals = new ConnectorRuntimePrincipalService({
          db: owningDb,
          authority: {
            authorizeTurn: async () => {
              throw new Error('No native entry was opened by this setup control.');
            },
            revalidateTurn: async () => false,
          },
        });
        await principals.initializeBoot();
        throw primary;
      } catch (cause) {
        remember(cause);
      } finally {
        await drainOriginalCleanup();
      }
      expect({ failed, cause: first }).toEqual({ failed: true, cause: primary });
      expect(closes).toBe(1);
      expect(owningDb?.$client.open).toBe(false);
      expect(afterCloseDuty).toBe(true);
      expect(sdkMocks.constructorOptions).toHaveLength(0);
      expect(sdkMocks.prompts).toHaveLength(0);
    });

    it('opens fresh authority for a later message on the same Codex thread', async () => {
      const principals = connectorPort();
      const createLeaseSupervisor = vi.fn<ConnectorTurnLeaseSupervisorFactory>(() => ({
        state: 'active' as const,
        stop: vi.fn(),
        assertUsable: vi.fn(),
      }));
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: () => true,
        createLeaseSupervisor,
      });

      await drain(runtime.sendMessage('s1', 'first', { cwd: agentDir }));
      await drain(runtime.sendMessage('s1', 'second', { cwd: agentDir }));

      expect(principals.openTurn).toHaveBeenCalledTimes(2);
      expect(principals.revoke).toHaveBeenNthCalledWith(1, 'binding-1', 'turn_terminal');
      expect(principals.revoke).toHaveBeenNthCalledWith(2, 'binding-2', 'turn_terminal');
      const firstPermit = createLeaseSupervisor.mock.calls[0]?.[0].permit;
      const secondPermit = createLeaseSupervisor.mock.calls[1]?.[0].permit;
      expect(firstPermit).not.toBe(secondPermit);
    });

    it('revokes a binding when setup fails after minting', async () => {
      const principals = connectorPort();
      const stop = vi.fn();
      const runtime = new CodexRuntime({
        transport: 'exec',
        threadMap: new CodexThreadMap(db),
        resolveBinary: async () => {
          throw new Error('binary setup failed');
        },
        defaultCwd: agentDir,
      });
      runtime.setMeshCore(meshWithAgent(agentDir));
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          new Set([
            'connectors.execute_read',
            'connectors.execute_write',
            'connectors.execute_destructive',
          ]).has(id),
        createLeaseSupervisor: () => ({ state: 'active', stop, assertUsable: vi.fn() }),
      });

      await expect(drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }))).rejects.toThrow(
        'binary setup failed'
      );
      expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'setup_failed');
      expect(stop).toHaveBeenCalledBefore(vi.mocked(principals.revoke));
    });

    it('revokes runtime failures after dispatch', async () => {
      const principals = connectorPort();
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          new Set([
            'connectors.execute_read',
            'connectors.execute_write',
            'connectors.execute_destructive',
          ]).has(id),
      });
      sdkMocks.behavior = 'fail';

      await expect(drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }))).rejects.toThrow(
        'codex runtime failed'
      );
      expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'runtime_failed');
    });

    it('uses the turn controller to revoke an interrupted turn', async () => {
      const principals = connectorPort();
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          new Set([
            'connectors.execute_read',
            'connectors.execute_write',
            'connectors.execute_destructive',
          ]).has(id),
      });
      sdkMocks.behavior = 'wait-for-abort';

      const turn = drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));
      await vi.waitFor(() => expect(sdkMocks.prompts).toHaveLength(1));
      expect(await runtime.interruptQuery('s1')).toEqual({ outcome: 'closed', runtime: 'codex' });
      await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
      expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_cancelled');
    });

    it('revokes immediately when the SDK iterator remains parked after interruption', async () => {
      const principals = connectorPort();
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          ['connectors.list_granted_connections', 'connectors.execute_read'].includes(id),
      });
      sdkMocks.behavior = 'park-past-abort';

      const turn = drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));
      await vi.waitFor(() => expect(sdkMocks.prompts).toHaveLength(1));
      await expect(runtime.interruptQuery('s1')).resolves.toEqual({
        outcome: 'closed',
        runtime: 'codex',
      });
      expect(principals.revoke).toHaveBeenCalledTimes(1);
      expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_cancelled');

      sdkMocks.releaseParked?.();
      await turn;
      expect(principals.revoke).toHaveBeenCalledTimes(1);
    });

    it('still closes the Codex process when durable connector revoke reports failure', async () => {
      const principals = connectorPort();
      vi.mocked(principals.revoke).mockRejectedValueOnce(new Error('durable revoke failed'));
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) =>
          ['connectors.list_granted_connections', 'connectors.execute_read'].includes(id),
      });
      sdkMocks.behavior = 'park-past-abort';

      const turn = drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));
      await vi.waitFor(() => expect(sdkMocks.prompts).toHaveLength(1));
      await expect(runtime.interruptQuery('s1')).resolves.toEqual({
        outcome: 'closed',
        runtime: 'codex',
      });
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        '[CodexRuntime] failed to persist interrupted connector binding revoke',
        expect.objectContaining({ sessionId: 's1' })
      );

      sdkMocks.releaseParked?.();
      await turn;
    });

    it('keeps the real turn principal renewable for 72 hours and closes it on cancellation', async () => {
      const fixture = await createRuntimeTurnRenewalConformanceFixture('codex');
      const runtime = makeRuntime();
      runtime.setConnectorRuntimeTools({
        principals: fixture.principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: () => true,
        createLeaseSupervisor: fixture.createLeaseSupervisor,
      });
      sdkMocks.behavior = 'park-past-abort';
      const turn = drain(runtime.sendMessage('codex-renewal-session', 'hello', { cwd: agentDir }));

      try {
        await vi.waitFor(() => expect(sdkMocks.prompts).toHaveLength(1));
        const options = sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> };
        expect(options.env?.['DORKOS_CONNECTOR_MCP_AUTHORIZATION']).toBe('Bearer bearer-codex');
        await fixture.advanceHours(72);
        expect(options.env?.['DORKOS_CONNECTOR_MCP_AUTHORIZATION']).toBe('Bearer bearer-codex');
        await expect(runtime.interruptQuery('codex-renewal-session')).resolves.toEqual({
          outcome: 'closed',
          runtime: 'codex',
        });
        await fixture.expectTerminalDenial();
      } finally {
        sdkMocks.releaseParked?.();
        await turn.catch(() => undefined);
        fixture.close();
      }
    });
  });

  describe('a runtime boot never handed a loopback boundary', () => {
    it('injects nothing at all, asserted against the whole options object', async () => {
      // An absence check on the `dorkos` key would pass while some neighbouring
      // field changed shape, so this compares the whole object.
      await drain(
        makeRuntime({ runtimeTools: false }).sendMessage('s1', 'hello', { cwd: agentDir })
      );

      expect(sdkMocks.constructorOptions.at(-1)).toEqual({
        codexPathOverride: '/bin/codex',
        // No `config` at all: with no boundary and no managed servers, DorkOS
        // injects nothing. It used to inject the `dorkos_ui` bridge here on every
        // turn regardless; that is retired (spec `canvas-agent-seat` §5).
        env: expect.any(Object),
      });
      expect(lastMcpServers()['dorkos']).toBeUndefined();
    });

    it('names no room tool in the prompt, because the session has none', async () => {
      await drain(
        makeRuntime({ runtimeTools: false }).sendMessage('s1', 'hello', { cwd: agentDir })
      );
      const prompt = sdkMocks.prompts.at(-1) ?? '';
      expect(prompt).not.toContain('<room_tools>');
      expect(prompt).not.toContain('post_to_room');
    });

    it('lets a user server called dorkos through untouched, and warns about nothing', async () => {
      // The name is reserved only on the turns DorkOS actually injects it. With
      // nothing of ours to protect, dropping this person's own server of that
      // name would take something and give nothing back.
      //
      // OpenCode already behaved this way (its desired set simply has no
      // `dorkos` entry when nothing was resolved), so this is also what keeps
      // the two runtimes answering the same question the same way.
      const managed: ManagedMcpServerResolver = {
        injectableServersForCwd: () => ({
          dorkos: { transport: 'stdio', command: '/bin/their-server' },
        }),
      } as unknown as ManagedMcpServerResolver;
      await drain(
        makeRuntime({ managed, runtimeTools: false }).sendMessage('s1', 'hello', { cwd: agentDir })
      );

      // Theirs, verbatim — same name, their command, and no URL of ours.
      expect(lastMcpServers()['dorkos']).toEqual({ command: '/bin/their-server' });
      const warned = loggerMocks.warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((line) => line.includes('reserve'))).toBe(false);
    });
  });

  describe('what the ROOM is told, and whether it matches what was injected', () => {
    it('answers true exactly when the entry was injected', async () => {
      const runtime = makeRuntime();
      await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

      expect(lastMcpServers()['dorkos']).toBeDefined();
      expect(await runtime.carriesRoomTools({ cwd: agentDir })).toBe(true);
    });

    it('answers FALSE for a directory hosting no registered agent — the mute this closes', async () => {
      // **The divergence, and it was a silent mute rather than an untidy room.**
      // `sendMessage` gates the injection on `meshAgent ? agentPath : undefined`, so a
      // `getByPath` miss withholds the entry. `carriesRoomTools` was handing the
      // posture a bare `cwd` string, which made the `'no-agent'` answer
      // structurally unreachable from that caller — so it said `true` for a
      // session the runtime was about to leave with no tools at all. The room
      // read that as tool-capable, suppressed the turn's text, and the agent
      // said nothing, anywhere, with nothing on the log to explain it.
      const runtime = makeRuntime();
      const stranger = path.join(agentDir, 'not-an-agent');
      await drain(runtime.sendMessage('s1', 'hello', { cwd: stranger }));

      expect(lastMcpServers()['dorkos']).toBeUndefined();
      expect(await runtime.carriesRoomTools({ cwd: stranger })).toBe(false);
    });

    it('answers FALSE with no registry wired at all', async () => {
      // The other half of the same gate: `meshCore` is injected by the
      // composition root, so a runtime built without one has no way to identify
      // anybody and injects nothing.
      const runtime = new CodexRuntime({
        transport: 'exec',
        threadMap: new CodexThreadMap(db),
        resolveBinary: async () => '/bin/codex',
        defaultCwd: agentDir,
      });
      await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

      expect(lastMcpServers()['dorkos']).toBeUndefined();
      expect(await runtime.carriesRoomTools({ cwd: agentDir })).toBe(false);
    });

    it('agrees with what was injected whatever the external MCP posture says', async () => {
      // The property rather than three separate cases: what the ROOM is told and
      // what the RUNTIME did must agree. Two readings of one gate is how a room
      // comes to suppress a turn's words for a session that never got the tool.
      // The external MCP settings are in the loop because they are the ones a
      // reader keeps expecting to matter here, and they must not.
      const runtime = makeRuntime();
      let asserted = 0;
      for (const config of [
        { mcp: { enabled: true } },
        { mcp: { enabled: false }, auth: { enabled: true } },
        {},
      ]) {
        configState.value = config;
        // `lastMcpServers` reads the newest constructed client, so each case
        // needs its own turn on its own session rather than a cleared mock.
        await drain(runtime.sendMessage(`s-${asserted}`, 'hello', { cwd: agentDir }));
        expect(lastMcpServers()['dorkos'], JSON.stringify(config)).toBeDefined();
        expect(await runtime.carriesRoomTools({ cwd: agentDir }), JSON.stringify(config)).toBe(
          true
        );
        asserted += 1;
      }
      expect(asserted).toBe(3);
    });
  });

  describe('a room turn (DOR-2091, spec `agent-home-desk` §5.1)', () => {
    // A room turn stands in its agent's HOME and names that agent. It gets the
    // agent's `dorkos` server and token; a turn naming ANOTHER agent gets
    // nothing, wherever it stands. Seeded: dropping the room-turn cross-check
    // reddens the second case.
    /** A room turn for `agentPath`, standing in `cwd`. */
    function roomTurn(cwd: string, agentPath: string) {
      return {
        cwd,
        roomTurn: { roomId: '01ROOM', authorId: 'author-1', turnId: 'turn-1', cwd, agentPath },
      };
    }

    it("gives the agent its dorkos server and token, bound to the AGENT's identity", async () => {
      const principals = connectorPort();
      const runtime = makeRuntime({ runtimeTools: principals });

      await drain(runtime.sendMessage('s1', 'hello', roomTurn(agentDir, agentDir)));

      expect(lastMcpServers()['dorkos']?.['url']).toBe('http://127.0.0.1:4341/agent-mcp');
      const env = (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env;
      expect(env?.['DORKOS_AGENT_TOKEN']).toEqual(expect.any(String));
      expect(principals.openTurn).toHaveBeenCalledWith(
        expect.objectContaining({ agentPath: agentDir, canonicalCwd: agentDir }),
        expect.anything()
      );
      expect(await runtime.carriesRoomTools({ cwd: agentDir, agentPath: agentDir })).toBe(true);
    });

    it("gives a turn for ANOTHER agent nothing in this agent's home", async () => {
      const principals = connectorPort();
      const runtime = makeRuntime({ runtimeTools: principals });
      const someoneElse = path.join(agentDir, '..', 'someone-else');

      await drain(runtime.sendMessage('s1', 'hello', roomTurn(agentDir, someoneElse)));

      expect(lastMcpServers()['dorkos']).toBeUndefined();
      const env = (sdkMocks.constructorOptions.at(-1) as { env?: Record<string, string> }).env;
      expect(env?.['DORKOS_AGENT_TOKEN']).toBeUndefined();
      expect(principals.openTurn).not.toHaveBeenCalled();
      expect(await runtime.carriesRoomTools({ cwd: agentDir, agentPath: someoneElse })).toBe(false);
    });

    it("gives a refused turn none of the folder's own managed servers", async () => {
      // A turn for another agent standing in THIS agent's own folder anchors to
      // nobody; the managed servers it would get by falling back to the
      // directory are this agent's, so it gets none. Seeded: falling back to
      // `agentPath ?? cwd` reddens it.
      const managed: ManagedMcpServerResolver = {
        injectableServersForCwd: (dir: string) =>
          dir === agentDir ? { private_db: { transport: 'stdio', command: '/bin/db' } } : {},
      } as unknown as ManagedMcpServerResolver;
      const runtime = makeRuntime({ managed });

      await drain(
        runtime.sendMessage('s1', 'hello', roomTurn(agentDir, path.join(agentDir, '..', 'ben')))
      );

      expect(lastMcpServers()['private_db']).toBeUndefined();
    });
  });

  describe('fixed Codex committed Room start', () => {
    it('refuses a copied preparation before any SDK construction', () => {
      const runtime = makeRuntime();
      const before = sdkMocks.constructorOptions.length;
      expect(() =>
        startCodexCommittedRoomResponder(
          runtime,
          Object.freeze({ kind: 'prepared-room-responder' })
        )
      ).toThrow('Room responder preparation is not original.');
      expect(sdkMocks.constructorOptions).toHaveLength(before);
    });
  });
  it('prepares a fresh genuine native responder from the original committed Room source without another model call', async () => {
    const h = await nativeRoomAuthorityFixture(
      agentDir,
      'codex',
      'native-source',
      '01JAGENT0000000000000000'
    );
    let ownedRuntime: CodexRuntime | undefined,
      ownedProducer: AsyncGenerator<StreamEvent> | undefined;
    let producerDone: Promise<void> | undefined;
    let prepared:
      | import('../../../canvas/doc-channel/current/current-operation-types.js').PreparedRoomResponder
      | undefined;
    let failed = false,
      first: unknown;
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      const cleanup = async (work: () => unknown | Promise<unknown>) => {
        try {
          await work();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      if (prepared && ownedRuntime)
        await cleanup(() => retireCodexPreparedRoomResponder(ownedRuntime!, prepared!));
      await cleanup(() => sdkMocks.releaseParked?.());
      if (ownedProducer) await cleanup(() => ownedProducer!.return(undefined));
      if (producerDone) await cleanup(() => producerDone);
      await cleanup(() => h.cleanup());
      if (failed) throw first;
    };
    try {
      const activeRuntime = new CodexRuntime({
        transport: 'exec',
        threadMap: new CodexThreadMap(h.db),
        resolveBinary: async () => '/bin/codex',
        defaultCwd: agentDir,
      });
      ownedRuntime = activeRuntime;
      activeRuntime.setMeshCore(meshWithAgent(agentDir));
      activeRuntime.setConnectorRuntimeTools({
        principals: h.principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
      });
      const holder = { on: vi.fn() };
      expect(activeRuntime.acquireLock('native-source', 'producer-holder', holder)).toBe(true);
      sdkMocks.behavior = 'park-past-abort';
      const activeProducer = sendCodexOriginalLockedMessage(
        activeRuntime,
        'native-source',
        'actual producer',
        { cwd: agentDir },
        holder,
        'native-source'
      )!;
      ownedRuntime = activeRuntime;
      ownedProducer = activeProducer;
      producerDone = drain(activeProducer);
      const runtime = activeRuntime,
        producer = activeProducer;
      await vi.waitFor(() => expect(sdkMocks.releaseParked).toEqual(expect.any(Function)));
      const originalPrincipal = await actualCodexProducerPrincipal(h.principals, agentDir);
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.documentId)!;
      const event = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'original native acceptance' },
      };
      const accepted = await submitCurrentDocEvent(
        h.http.service,
        h.documentId,
        event,
        { surface: 'capability', principal: originalPrincipal },
        { expectedGeneration: docDocumentGeneration(physical, channel) }
      );
      expect(accepted.receipt.id).toBe(event.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      wakeAuthorizedRoomDue(h.http.authorization);
      const returned = producer.return(undefined);
      sdkMocks.releaseParked!();
      await returned;
      await producerDone;
      const modelsBefore = sdkMocks.prompts.length;
      const bindingsBefore = h.db.select().from(connectorRuntimeBindings).all().length;
      prepared = await prepareServiceOriginalRoomResponder(
        h.http.service,
        runtime,
        holder,
        'native-source'
      );
      if (!prepared) throw new Error('Genuine original responder unexpectedly unavailable.');
      expect(prepared.kind).toBe('prepared-room-responder');
      const originalPrepared = readCodexPreparedRoomResponder(runtime, prepared);
      expect(originalPrepared?.native.canonicalSessionId).toBe('native-source');
      if (!originalPrepared) throw new Error('Original native preparation is not current.');
      const operation = originalPrepared.nativeOperation;
      const time = captureOriginalPreparedNativeTime(h.principals, h.db, operation);
      expect(
        readOriginalPreparedNativePrincipal(h.principals, h.db, operation, time, h.db)
          ?.canonicalSessionId
      ).toBe('native-source');
      // One captured configured-time/activity read cannot be replayed.
      expect(
        readOriginalPreparedNativePrincipal(h.principals, h.db, operation, time, h.db)
      ).toBeUndefined();
      const inTransactionTime = captureOriginalPreparedNativeTime(h.principals, h.db, operation);
      expect(() =>
        h.db.transaction((tx) =>
          readOriginalPreparedNativePrincipal(h.principals, h.db, operation, inTransactionTime, tx)
        )
      ).toThrow('Prepared native currentness requires its inactive owning database.');
      const copiedOperation = { ...operation };
      expect(() => captureOriginalPreparedNativeTime(h.principals, h.db, copiedOperation)).toThrow(
        'Prepared native time requires the original native operation identity.'
      );
      expect(() =>
        captureOriginalPreparedNativeTime(h.principals, h.db, originalPrincipal!)
      ).toThrow('Prepared native time requires the original native operation identity.');
      expect(
        readOriginalPreparedNativePrincipal(h.principals, h.db, originalPrincipal!, time, h.db)
      ).toBeUndefined();
      expect(readCodexPreparedRoomResponder({}, prepared)).toBeUndefined();
      expect(readCodexPreparedRoomResponder(runtime, { ...prepared })).toBeUndefined();
      expect(sdkMocks.prompts).toHaveLength(modelsBefore);
      expect(h.db.select().from(connectorRuntimeBindings).all()).toHaveLength(bindingsBefore + 1);
      expect(() =>
        Reflect.apply(startCodexCommittedRoomResponder, undefined, [runtime, prepared!])
      ).toThrow('Room committed start authority is not available.');
      expect(sdkMocks.prompts).toHaveLength(modelsBefore);
      const beforeRetirement = captureOriginalPreparedNativeTime(h.principals, h.db, operation);
      await retireCodexPreparedRoomResponder(runtime, prepared);
      expect(
        readOriginalPreparedNativePrincipal(h.principals, h.db, operation, beforeRetirement, h.db)
      ).toBeUndefined();
      expect(readCodexPreparedRoomResponder(runtime, prepared)).toBeUndefined();
      prepared = undefined;
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      await drainOriginalCleanup();
    }
  });
  it.each([
    'same-entry once',
    'same budget blocks configured callback peer reserve',
    'early settings Error',
    'early settings undefined',
    'early credits refusal',
    'entered pending next direct return',
    'held settings direct return',
    'held settings durable revoke',
    'known busy retains original source',
    'same-target two batches retain busy second original',
    'early mesh Error with cleanup Error',
    'early mesh undefined with cleanup Error',
    'durable native binding revocation bypasses public select',
    'onTurnStart Error before first pull',
    'onTurnStart undefined with failing child sweep',
    'grant revoked after commit',
    'foreign original runtime',
    'return before first pull',
    'fixed projector and terminal',
    'projection observer revokes grant',
    'foreign same-id projector',
  ] as const)(
    'consumes genuine native COMMIT/private FIRST at Codex SDK boundary: %s',
    async (scenario) => {
      const runOriginalCase = async () => {
        const h =
          scenario === selectedNativeCase
            ? await selectedNativeOwner!.fixture
            : await nativeRoomAuthorityFixture(
                agentDir,
                'codex',
                'native-source',
                '01JAGENT0000000000000000'
              );
        let ownedRuntime: CodexRuntime | undefined;
        let ownedProducer: AsyncGenerator<StreamEvent> | undefined;
        let producerDone: Promise<void> | undefined;
        let prepared:
          | import('../../../canvas/doc-channel/current/current-operation-types.js').PreparedRoomResponder
          | undefined;
        let failed = false,
          first: unknown;
        let preparedRetirement: Promise<void> | undefined;
        let verifiedRetirementFailure = false,
          verifiedRetirementCause: unknown;
        // Inner scenario and outer fixture join the same original prepared owner.
        const retirePrepared = (): Promise<void> => {
          if (!prepared || !ownedRuntime) return Promise.resolve();
          return (preparedRetirement ??= Promise.resolve().then(() =>
            retireCodexPreparedRoomResponder(ownedRuntime!, prepared!)
          ));
        };
        // Join this scope to its captured cleanup before returning or reporting failure.
        const drainOriginalCleanup = async () => {
          const cleanup = async (work: () => unknown | Promise<unknown>) => {
            try {
              await work();
            } catch (cause) {
              if (!failed) {
                failed = true;
                first = cause;
              }
            }
          };
          await cleanup(async () => {
            try {
              await retirePrepared();
            } catch (cause) {
              if (!verifiedRetirementFailure) throw cause;
              expect(cause).toBe(verifiedRetirementCause);
            }
          });
          await cleanup(() => sdkMocks.releaseParked?.());
          if (ownedProducer) await cleanup(() => ownedProducer!.return(undefined));
          if (producerDone) await cleanup(() => producerDone);
          await cleanup(() => h.cleanup());
          if (failed) throw first;
        };
        try {
          const activeRuntime = new CodexRuntime({
            transport: 'exec',
            threadMap: new CodexThreadMap(h.db),
            resolveBinary: async () => '/bin/codex',
            defaultCwd: agentDir,
          });
          ownedRuntime = activeRuntime;
          activeRuntime.setMeshCore(meshWithAgent(agentDir));
          activeRuntime.setConnectorRuntimeTools({
            principals: h.principals,
            listenerUrl: 'http://127.0.0.1:4341/mcp',
            agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
            isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
          });
          const holder = { on: vi.fn() };
          expect(activeRuntime.acquireLock('native-source', 'producer-holder', holder)).toBe(true);
          sdkMocks.behavior = 'park-past-abort';
          const activeProducer = sendCodexOriginalLockedMessage(
            activeRuntime,
            'native-source',
            'actual producer',
            { cwd: agentDir },
            holder,
            'native-source'
          )!;
          ownedRuntime = activeRuntime;
          ownedProducer = activeProducer;
          producerDone = drain(activeProducer);
          const runtime = activeRuntime,
            producer = activeProducer;
          await vi.waitFor(() => expect(sdkMocks.releaseParked).toEqual(expect.any(Function)));
          const originalPrincipal = await actualCodexProducerPrincipal(h.principals, agentDir);
          const physical = h.db
            .select()
            .from(canvasDocuments)
            .where(eq(canvasDocuments.id, h.documentId))
            .get()!;
          const channel = h.http.channels.getChannel(h.documentId)!;
          const event = {
            v: 1 as const,
            id: randomUUID(),
            type: 'md.comment',
            payload: { text: 'original native acceptance' },
          };
          const accepted = await submitCurrentDocEvent(
            h.http.service,
            h.documentId,
            event,
            { surface: 'capability', principal: originalPrincipal },
            { expectedGeneration: docDocumentGeneration(physical, channel) }
          );
          expect(accepted.receipt.id).toBe(event.id);
          await new Promise<void>((resolve) => setTimeout(resolve, 110));
          wakeAuthorizedRoomDue(h.http.authorization);
          let secondOriginal: { eventId: string; batchId: string } | undefined;
          if (scenario === 'same-target two batches retain busy second original') {
            const secondEvent = {
              v: 1 as const,
              id: randomUUID(),
              type: 'md.comment',
              payload: { text: 'second genuine same-target batch' },
            };
            const secondAccepted = await submitCurrentDocEvent(
              h.http.service,
              h.documentId,
              secondEvent,
              { surface: 'capability', principal: originalPrincipal },
              { expectedGeneration: docDocumentGeneration(physical, channel) }
            );
            expect(secondAccepted.receipt.id).toBe(secondEvent.id);
            const firstBatch = h.http.channels.listDeliveries(h.documentId, event.id)[0]!.batchId!;
            const secondBatch = h.http.channels.listDeliveries(h.documentId, secondEvent.id)[0]!
              .batchId!;
            expect(secondBatch).not.toBe(firstBatch);
            expect(h.http.channels.getBatch(firstBatch)!.status).toBe('accepted');
            const pendingBatch = h.http.channels.getBatch(secondBatch)!;
            const pendingReceipt = h.http.channels.getEvent(h.documentId, secondEvent.id)!;
            const pendingDeliveries = h.http.channels.listDeliveries(h.documentId, secondEvent.id);
            expect(pendingBatch.status).toMatch(/^(?:pending|waiting)$/);
            retainDocHistory(
              h.http.channels,
              new Date(Date.parse(pendingReceipt.receivedAt) + 86400_000).toISOString(),
              { ageMs: 1, documentBytes: 1, installationBytes: 1 }
            );
            expect(h.http.channels.getBatch(secondBatch)).toEqual(pendingBatch);
            expect(h.http.channels.getEvent(h.documentId, secondEvent.id)).toEqual(pendingReceipt);
            expect(h.http.channels.listDeliveries(h.documentId, secondEvent.id)).toEqual(
              pendingDeliveries
            );
            // Floors describe the contiguous tail, not membership of this protected
            // older input. A real reset must still disclose its retained receipt.
            const retainedReplay = await replayServiceCurrentDoc(
              h.http.service,
              h.documentId,
              { surface: 'capability', principal: originalPrincipal },
              0
            );
            expect(retainedReplay.resetRequired).toBe(true);
            expect(retainedReplay.retentionFloor).toBe(
              h.http.channels.getChannel(h.documentId)!.retentionFloor
            );
            expect(retainedReplay.receiptRetentionFloor).toBe(
              h.http.channels.getChannel(h.documentId)!.receiptRetentionFloor
            );
            expect(retainedReplay.receipts).toContainEqual({
              receipt: { id: secondEvent.id, status: 'recorded', docSeq: pendingReceipt.docSeq },
              deliveries: expect.any(Array),
              payloadAvailable: true,
            });
            // Configured 100 ms window belongs to the real acceptance, not a fake timer/DTO.
            await new Promise<void>((resolve) => setTimeout(resolve, 110));
            wakeAuthorizedRoomDue(h.http.authorization);
            expect(h.http.channels.getBatch(secondBatch)!.status).toBe('accepted');
            secondOriginal = { eventId: secondEvent.id, batchId: secondBatch };
          }
          const returned = producer.return(undefined);
          sdkMocks.releaseParked!();
          await returned;
          await producerDone;
          const modelsBefore = sdkMocks.prompts.length;
          const bindingsBefore = h.db.select().from(connectorRuntimeBindings).all().length;
          if (scenario === 'known busy retains original source') {
            // A real competing acquisition blocks this holder before any native setup or claim.
            runtime.releaseLock('native-source', 'producer-holder');
            const busyHolder = { on: vi.fn() };
            expect(runtime.acquireLock('native-source', 'competing-holder', busyHolder)).toBe(true);
            expect(
              await prepareServiceOriginalRoomResponder(
                h.http.service,
                runtime,
                holder,
                'native-source'
              )
            ).toBeUndefined();
            expect(sdkMocks.prompts).toHaveLength(modelsBefore);
            expect(h.db.select().from(connectorRuntimeBindings).all()).toHaveLength(bindingsBefore);
            expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
              0
            );
            expect(
              h.db.get<{ status: string }>(sql`SELECT status FROM canvas_doc_batches
            WHERE document_id=${h.documentId}`)?.status
            ).toBe('accepted');
            runtime.releaseLock('native-source', 'competing-holder');
            expect(runtime.acquireLock('native-source', 'producer-holder', holder)).toBe(true);
          }
          prepared = await prepareServiceOriginalRoomResponder(
            h.http.service,
            runtime,
            holder,
            'native-source'
          );
          if (!prepared) throw new Error('Genuine original responder unexpectedly unavailable.');
          const originalPrepared = readCodexPreparedRoomResponder(runtime, prepared);
          if (!originalPrepared) throw new Error('Actual original preparation missing.');
          const operation = originalPrepared.nativeOperation;
          const operationTime = captureOriginalPreparedNativeTime(h.principals, h.db, operation);
          const operationBinding = readOriginalPreparedNativePrincipal(
            h.principals,
            h.db,
            operation,
            operationTime,
            h.db
          );
          if (!operationBinding) throw new Error('Actual prepared native binding missing.');
          const operationBindingId = operationBinding.id;
          const commitsBefore = h.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM room_turn_spend`
          )!.n;
          const peerDecisions: ReturnType<typeof h.budget.tryReserve>[] = [];
          const actualConfig = configManager.get.bind(configManager);
          const peerPolicy =
            scenario === 'same budget blocks configured callback peer reserve'
              ? vi.spyOn(configManager, 'get').mockImplementation((...args) => {
                  const value = actualConfig(...args);
                  if (args[0] === 'rooms') peerDecisions.push(h.budget.tryReserve(h.roomId));
                  return value;
                })
              : undefined;
          let committed: ReturnType<typeof commitServiceOriginalRoomResponder>;
          try {
            committed = commitServiceOriginalRoomResponder(h.http.service, runtime, prepared);
          } finally {
            peerPolicy?.mockRestore();
          }
          if (scenario === 'same budget blocks configured callback peer reserve') {
            // Assertions live outside the caught configuration read; a failed assertion cannot default away.
            expect(peerDecisions.length).toBeGreaterThan(0);
            for (const decision of peerDecisions)
              expect(decision).toEqual({ allowed: false, counted: false, prepared: true });
          }
          expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
            commitsBefore + 1
          );
          expect(
            h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
        WHERE document_id=${h.documentId}`)?.status
          ).toBe('claimed');
          const nativeBindingsAfterCommit = h.db
            .select()
            .from(connectorRuntimeBindings)
            .all().length;
          sdkMocks.behavior = 'complete';
          if (scenario === 'same-target two batches retain busy second original') {
            if (!secondOriginal) throw new Error('Second authentic batch was not produced.');
            const firstBatchId = h.http.channels.listDeliveries(h.documentId, event.id)[0]!
              .batchId!;
            expect(
              h.db.get<{ batchId: string }>(sql`SELECT batch_id AS batchId
            FROM room_doc_admissions WHERE document_id=${h.documentId}`)
            ).toEqual({ batchId: firstBatchId });
            const beforeSecond = h.http.channels.getBatch(secondOriginal.batchId)!;
            const beforeReceipt = h.http.channels.getEvent(h.documentId, secondOriginal.eventId)!;
            const beforeDeliveries = h.http.channels.listDeliveries(
              h.documentId,
              secondOriginal.eventId
            );
            // Actual installed first native entry occupies the target, even for the same lock holder.
            expect(
              await prepareServiceOriginalRoomResponder(
                h.http.service,
                runtime,
                holder,
                'native-source'
              )
            ).toBeUndefined();
            expect(h.http.channels.getBatch(secondOriginal.batchId)).toEqual(beforeSecond);
            expect(h.http.channels.getEvent(h.documentId, secondOriginal.eventId)).toEqual(
              beforeReceipt
            );
            expect(h.http.channels.listDeliveries(h.documentId, secondOriginal.eventId)).toEqual(
              beforeDeliveries
            );
            expect(sdkMocks.prompts).toHaveLength(modelsBefore);
            expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
              commitsBefore + 1
            );
            const firstStream = startCodexCommittedRoomResponder(runtime, prepared, committed);
            await feedProjector(getOrCreateProjector('native-source'), firstStream, {
              originalRoomStream: firstStream,
            });
            const next = await prepareServiceOriginalRoomResponder(
              h.http.service,
              runtime,
              holder,
              'native-source'
            );
            if (!next) throw new Error('Known pre-effect busy lost accepted-unclaimed original.');
            prepared = next;
            const nextOwn = readCodexPreparedRoomResponder(runtime, next);
            if (!nextOwn) throw new Error('Second actual native preparation missing.');
            expect(nextOwn.source).not.toBe(originalPrepared.source);
            const nextCommit = commitServiceOriginalRoomResponder(h.http.service, runtime, next);
            const admitted = h.db.all<{ batchId: string; status: string }>(sql`SELECT
            batch_id AS batchId,status FROM room_doc_admissions WHERE document_id=${h.documentId}`);
            expect(admitted).toEqual(
              expect.arrayContaining([
                { batchId: firstBatchId, status: 'settled' },
                { batchId: secondOriginal.batchId, status: 'claimed' },
              ])
            );
            expect(admitted).toHaveLength(2);
            const secondStream = startCodexCommittedRoomResponder(runtime, next, nextCommit);
            await feedProjector(getOrCreateProjector('native-source'), secondStream, {
              originalRoomStream: secondStream,
            });
            expect(sdkMocks.prompts).toHaveLength(modelsBefore + 2);
            expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
              commitsBefore + 2
            );
            expect(() => startCodexCommittedRoomResponder(runtime!, next, nextCommit)).toThrow();
            expect(
              await prepareServiceOriginalRoomResponder(
                h.http.service,
                runtime,
                holder,
                'native-source'
              )
            ).toBeUndefined();
            return;
          }
          if (scenario === 'entered pending next direct return') {
            sdkMocks.behavior = 'room-wait-abort-close';
            const raw = startCodexCommittedRoomResponder(runtime, prepared, committed);
            const pending = raw.next().then(
              (result) => ({ failed: false as const, result }),
              (cause: unknown) => ({ failed: true as const, cause })
            );
            let pendingSettled = false;
            void pending.then(() => {
              pendingSettled = true;
            });
            let scenarioFailed = false,
              scenarioCause: unknown;
            const retainScenarioCause = (cause: unknown) => {
              if (!scenarioFailed) {
                scenarioFailed = true;
                scenarioCause = cause;
              }
            };
            try {
              await vi.waitFor(() => expect(sdkMocks.waitingSignal).toBeDefined());
              const child = sdkMocks.waitingChild;
              if (!child) throw new Error('Actual supplied SDK child was not started');
              expect(child.exitCode).toBeNull();
              expect(child.signalCode).toBeNull();
              expect(sdkMocks.waitingSignal!.aborted).toBe(false);
              const returned = raw.return(undefined).then(
                (result) => ({ failed: false as const, result }),
                (cause: unknown) => ({ failed: true as const, cause })
              );
              // No interruptQuery, supplied release, polling timeout or second turn
              // may make this return progress: its exact native owner must cancel.
              expect(sdkMocks.waitingSignal!.aborted).toBe(true);
              await vi.waitFor(() => expect(pendingSettled).toBe(true));
              const read = await pending;
              expect(read.failed).toBe(true);
              if (!read.failed)
                throw new Error('Original pending read did not retain cancellation');
              expect(read.cause).toMatchObject({ name: 'AbortError' });
              expect(await returned).toEqual({
                failed: false,
                result: { done: true, value: undefined },
              });
              expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
              expect(
                child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed
              ).toBe(true);
              expect(readCodexNativeOperation(operation)).toBeUndefined();
              expect(readCodexPreparedRoomResponder(runtime, prepared)).toBeUndefined();
              expect(
                h.db.get<{ revoked: string | null }>(sql`SELECT revoked_at AS revoked
              FROM connector_runtime_bindings WHERE id=${operationBindingId}`)?.revoked
              ).not.toBeNull();
              expect(
                h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
              WHERE document_id=${h.documentId}`)?.status
              ).toBe('in_doubt');
              expect(sdkMocks.prompts).toHaveLength(modelsBefore + 1);
              expect(
                h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n
              ).toBe(commitsBefore + 1);
            } catch (cause) {
              retainScenarioCause(cause);
            } finally {
              // Failure-only fixture release cannot satisfy the successful native cancellation assertion.
              if (scenarioFailed) sdkMocks.releaseWaiting?.();
              // Attempt all original owners and retain the assertion/operation's first cause.
              for (const cleanup of [retirePrepared, () => raw.return(undefined), () => pending]) {
                try {
                  await cleanup();
                } catch (cause) {
                  retainScenarioCause(cause);
                }
              }
            }
            if (scenarioFailed) throw scenarioCause;
            return;
          }
          if (
            scenario === 'held settings direct return' ||
            scenario === 'held settings durable revoke'
          ) {
            const setupPort = runtime as unknown as {
              resolveTurnSettings(...args: unknown[]): Promise<unknown>;
            };
            const actualSettings = setupPort.resolveTurnSettings.bind(setupPort);
            let release: (() => void) | undefined;
            const hold = new Promise<void>((resolve) => {
              release = resolve;
            });
            let entered = false;
            const settings = vi
              .spyOn(setupPort, 'resolveTurnSettings')
              .mockImplementationOnce(async (...args) => {
                const result = await actualSettings(...args);
                entered = true;
                await hold;
                return result;
              });
            const constructorsBefore = sdkMocks.constructorOptions.length;
            const raw = startCodexCommittedRoomResponder(runtime, prepared, committed);
            let firstPull: Promise<unknown> | undefined;
            let close: Promise<unknown> | undefined;
            let failedHere = false;
            let primaryHere: unknown;
            const remember = (cause: unknown) => {
              if (!failedHere) {
                failedHere = true;
                primaryHere = cause;
              }
            };
            try {
              firstPull = raw.next().then(
                (value) => ({ failed: false as const, value }),
                (cause: unknown) => ({ failed: true as const, cause })
              );
              await vi.waitFor(() => expect(entered).toBe(true));
              expect(readCodexNativeOperation(operation)).toBeDefined();
              if (scenario === 'held settings direct return') {
                close = raw.return(undefined).then(
                  (value) => ({ failed: false as const, value }),
                  (cause: unknown) => ({ failed: true as const, cause })
                );
                // The genuine wrapper retires synchronously; queued generator return alone cannot.
                expect(readCodexNativeOperation(operation)).toBeUndefined();
              } else {
                const at = captureOriginalPreparedNativeTime(h.principals, h.db, operation);
                await h.principals.revoke(operationBindingId, 'turn_cancelled');
                expect(
                  readOriginalPreparedNativePrincipal(h.principals, h.db, operation, at, h.db)
                ).toBeUndefined();
              }
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              release!();
              await firstPull;
              if (close) await close;
              else await raw.return(undefined);
              expect(settings).toHaveBeenCalledTimes(1);
              expect(sdkMocks.constructorOptions).toHaveLength(constructorsBefore);
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(readCodexNativeOperation(operation)).toBeUndefined();
              expect(
                h.db.get<{ revoked: string | null }>(sql`SELECT revoked_at AS revoked
              FROM connector_runtime_bindings WHERE id=${operationBindingId}`)?.revoked
              ).not.toBeNull();
              expect(
                h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
              WHERE document_id=${h.documentId}`)?.status
              ).toBe('in_doubt');
              expect(
                h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n
              ).toBe(commitsBefore + 1);
              expect(() =>
                startCodexCommittedRoomResponder(runtime!, prepared!, committed)
              ).toThrow();
            } catch (cause) {
              remember(cause);
            } finally {
              try {
                release?.();
              } catch (cause) {
                remember(cause);
              }
              try {
                if (firstPull) await firstPull;
              } catch (cause) {
                remember(cause);
              }
              try {
                if (close) await close;
                else await raw.return(undefined);
              } catch (cause) {
                remember(cause);
              }
              try {
                settings.mockRestore();
              } catch (cause) {
                remember(cause);
              }
            }
            if (failedHere) throw primaryHere;
            return;
          }
          if (scenario.startsWith('early settings') || scenario === 'early credits refusal') {
            // Inject failure at the actual installed runtime's setup method only.
            // Genuine source, preparation, private acquisition, native COMMIT and
            // FIRST above are unchanged; this port cannot issue any authority.
            const constructorsBefore = sdkMocks.constructorOptions.length;
            const setupPort = runtime as unknown as {
              resolveTurnSettings(...args: unknown[]): Promise<unknown>;
              creditsLaunchFor(...args: unknown[]): Promise<unknown>;
            };
            const primary =
              scenario === 'early settings undefined'
                ? undefined
                : scenario === 'early credits refusal'
                  ? new CreditsUnavailableError('not-linked', 'Codex')
                  : new Error('actual entered settings read');
            const setupFault =
              scenario === 'early credits refusal'
                ? vi.spyOn(setupPort, 'creditsLaunchFor').mockImplementationOnce(async () => {
                    throw primary;
                  })
                : vi.spyOn(setupPort, 'resolveTurnSettings').mockImplementationOnce(async () => {
                    throw primary;
                  });
            try {
              const raw = startCodexCommittedRoomResponder(runtime, prepared, committed);
              const observed: StreamEvent[] = [];
              const result = await (async () => {
                for await (const event of raw) observed.push(event);
              })().then(
                () => ({ failed: false as const }),
                (cause: unknown) => ({ failed: true as const, cause })
              );
              if (scenario === 'early credits refusal') {
                expect(result).toEqual({ failed: false });
                expect(observed).toEqual([
                  expect.objectContaining({
                    type: 'error',
                    data: expect.objectContaining({ code: 'credits_unavailable' }),
                  }),
                ]);
              } else expect(result).toEqual({ failed: true, cause: primary });
              expect(setupFault).toHaveBeenCalledTimes(1);
              expect(sdkMocks.constructorOptions).toHaveLength(constructorsBefore);
              expect(h.db.select().from(connectorRuntimeBindings).all()).toHaveLength(
                nativeBindingsAfterCommit
              );
              expect(readCodexNativeOperation(operation)).toBeUndefined();
              expect(readCodexPreparedRoomResponder(runtime, prepared)).toBeUndefined();
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(
                h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
              WHERE document_id=${h.documentId}`)?.status
              ).toBe('in_doubt');
              expect(
                h.db.get<{ revoked: string | null }>(sql`SELECT revoked_at AS revoked
              FROM connector_runtime_bindings WHERE id=${operationBindingId}`)?.revoked
              ).not.toBeNull();
              expect(
                h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n
              ).toBe(commitsBefore + 1);
              expect(() =>
                startCodexCommittedRoomResponder(runtime!, prepared!, committed)
              ).toThrow();
            } finally {
              setupFault.mockRestore();
            }
            return;
          }
          if (
            scenario === 'early mesh Error with cleanup Error' ||
            scenario === 'early mesh undefined with cleanup Error'
          ) {
            const primary =
              scenario === 'early mesh Error with cleanup Error'
                ? new Error('original entered mesh setup')
                : undefined;
            const secondary = new Error('secondary genuine revoke failure');
            const revoke = h.principals.revoke.bind(h.principals);
            const revokeSpy = vi
              .spyOn(h.principals, 'revoke')
              .mockImplementation(async (...args) => {
                await revoke(...args);
                throw secondary;
              });
            runtime.setMeshCore({
              getByPath: () => {
                throw primary;
              },
              updateLastSeen: () => {},
              listWithPaths: () => [],
            });
            try {
              await expect(
                drain(startCodexCommittedRoomResponder(runtime, prepared, committed))
              ).rejects.toBe(primary);
              expect(revokeSpy).toHaveBeenCalled();
              expect(readCodexNativeOperation(operation)).toBeUndefined();
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(
                h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
              WHERE document_id=${h.documentId}`)?.status
              ).toBe('in_doubt');
              expect(
                h.db.get<{ revoked: string | null }>(sql`SELECT revoked_at AS revoked
              FROM connector_runtime_bindings WHERE id=${operationBindingId}`)?.revoked
              ).not.toBeNull();
              // The original retirement memo retains the injected secondary failure.
              // Prove it explicitly after preserving the entered operation's primary cause.
              await expect(retirePrepared()).rejects.toBe(secondary);
              verifiedRetirementFailure = true;
              verifiedRetirementCause = secondary;
            } finally {
              revokeSpy.mockRestore();
            }
            return;
          }
          if (scenario === 'durable native binding revocation bypasses public select') {
            h.db
              .run(sql`UPDATE connector_runtime_bindings SET revoked_at=${new Date().toISOString()}
            WHERE id=${operationBindingId}`);
            const originalSelect = h.db.select.bind(h.db);
            const publicBindingSelect = vi.fn();
            const spoof = vi.spyOn(h.db, 'select').mockImplementation((fields) => {
              const query = originalSelect(fields);
              const from = query.from;
              Object.defineProperty(query, 'from', {
                value: (table: unknown) => {
                  if (table === connectorRuntimeBindings) {
                    publicBindingSelect();
                    throw new Error('replaceable public SELECT must not run in final native read');
                  }
                  return Reflect.apply(from, query, [table]);
                },
              });
              return query;
            });
            try {
              await expect(
                drain(startCodexCommittedRoomResponder(runtime, prepared, committed))
              ).rejects.toThrow();
              // Published durable thread metadata still uses its ordinary query.
              // The revoked connector authority must use its captured native read.
              expect(spoof).toHaveBeenCalled();
              expect(publicBindingSelect).not.toHaveBeenCalled();
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(readCodexNativeOperation(operation)).toBeUndefined();
            } finally {
              spoof.mockRestore();
            }
            return;
          }
          if (
            scenario === 'onTurnStart Error before first pull' ||
            scenario === 'onTurnStart undefined with failing child sweep'
          ) {
            const primary =
              scenario === 'onTurnStart Error before first pull'
                ? new Error('original pre-pull observer')
                : undefined;
            const projector = getOrCreateProjector('native-source');
            projector.ingest({
              type: 'subagent_update',
              taskId: 'actual-stranded-child',
              status: 'running',
            });
            expect(projector.listRunningSubagents()).toContain('actual-stranded-child');
            const sweep =
              scenario === 'onTurnStart undefined with failing child sweep'
                ? vi.spyOn(projector, 'listRunningSubagents').mockImplementation(() => {
                    throw new Error('secondary sweep failure');
                  })
                : undefined;
            const stream = startCodexCommittedRoomResponder(runtime, prepared, committed);
            try {
              await expect(
                feedProjector(projector, stream, {
                  originalRoomStream: stream,
                  onTurnStart: () => {
                    throw primary;
                  },
                })
              ).rejects.toBe(primary);
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(readCodexNativeOperation(operation)).toBeUndefined();
              expect(
                h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
              WHERE document_id=${h.documentId}`)?.status
              ).toBe('in_doubt');
              await retireOriginalRoomResponderStream(stream);
            } finally {
              sweep?.mockRestore();
              disposeProjector('native-source');
            }
            return;
          }
          if (scenario === 'foreign original runtime') {
            const peer = makeRuntime(); // Actual second constructor; it owns no part of this preparation.
            expect(() => startCodexCommittedRoomResponder(peer, prepared!, committed)).toThrow(
              'Room responder preparation is not original.'
            );
            expect(sdkMocks.prompts).toHaveLength(modelsBefore);
          }
          if (scenario === 'return before first pull') {
            const neverPulled = startCodexCommittedRoomResponder(runtime, prepared, committed);
            await neverPulled.return(undefined);
            expect(sdkMocks.prompts).toHaveLength(modelsBefore);
            expect(readCodexNativeOperation(operation)).toBeUndefined();
            expect(
              h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
          WHERE document_id=${h.documentId}`)?.status
            ).toBe('in_doubt');
            expect(() => startCodexCommittedRoomResponder(runtime, prepared!, committed)).toThrow();
          } else if (
            scenario === 'fixed projector and terminal' ||
            scenario === 'projection observer revokes grant' ||
            scenario === 'foreign same-id projector'
          ) {
            const projector =
              scenario === 'foreign same-id projector'
                ? new SessionStateProjector('native-source')
                : getOrCreateProjector('native-source');
            const forgedPublic = vi.spyOn(projector, 'ingest').mockImplementation(() => {
              throw new Error('Mutable public projection must not be consulted.');
            });
            const originalStream = startCodexCommittedRoomResponder(runtime, prepared, committed);
            const onTurnStart = vi.fn(() => {
              if (scenario === 'projection observer revokes grant')
                h.db.run(
                  sql`UPDATE canvas_doc_grants SET revoked_at=${new Date().toISOString()} WHERE grant_id=${h.granted.grant.grantId}`
                );
            });
            const projected = feedProjector(projector, originalStream, {
              originalRoomStream: originalStream,
              onTurnStart,
            });
            if (scenario === 'fixed projector and terminal') {
              await projected;
              expect(sdkMocks.prompts).toHaveLength(modelsBefore + 1);
              expect(
                h.db.get<{ status: string; outcome: string; projected: string | null }>(
                  sql`SELECT status,outcome,turn_id AS projected FROM room_doc_admissions WHERE document_id=${h.documentId}`
                )
              ).toEqual({
                status: 'settled',
                outcome: 'turn_done',
                projected: expect.stringMatching(/^native-source:/),
              });
              expect(onTurnStart).toHaveBeenCalledTimes(1);
              // Completed original cleanup is idempotent and cannot rewrite durable success.
              await retireOriginalRoomResponderStream(originalStream);
              await retireOriginalRoomResponderStream(originalStream);
              expect(
                h.db.get<{ status: string; outcome: string }>(sql`SELECT status,outcome
              FROM room_doc_admissions WHERE document_id=${h.documentId}`)
              ).toEqual({
                status: 'settled',
                outcome: 'turn_done',
              });
            } else {
              await expect(projected).rejects.toThrow();
              expect(sdkMocks.prompts).toHaveLength(modelsBefore);
              expect(
                h.db.get<{ status: string }>(
                  sql`SELECT status FROM room_doc_admissions WHERE document_id=${h.documentId}`
                )?.status
              ).toBe('in_doubt');
              expect(onTurnStart).toHaveBeenCalledTimes(
                scenario === 'foreign same-id projector' ? 0 : 1
              );
            }
            expect(forgedPublic).not.toHaveBeenCalled();
            forgedPublic.mockRestore();
            disposeProjector('native-source');
            expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
              commitsBefore + 1
            );
          } else if (scenario === 'grant revoked after commit') {
            h.db.run(sql`UPDATE canvas_doc_grants SET revoked_at=${new Date().toISOString()}
          WHERE grant_id=${h.granted.grant.grantId}`);
            await expect(
              drain(startCodexCommittedRoomResponder(runtime, prepared, committed))
            ).rejects.toThrow('Original Room source/approved target changed.');
            expect(sdkMocks.prompts).toHaveLength(modelsBefore);
            expect(
              h.db.get<{ status: string }>(sql`SELECT status FROM room_doc_admissions
          WHERE document_id=${h.documentId}`)?.status
            ).toBe('in_doubt');
          } else {
            await drain(startCodexCommittedRoomResponder(runtime, prepared, committed));
            expect(sdkMocks.prompts).toHaveLength(modelsBefore + 1);
            expect(h.db.select().from(connectorRuntimeBindings).all()).toHaveLength(
              nativeBindingsAfterCommit
            );
            expect(readCodexNativeOperation(operation)).toBeUndefined();
            expect(() => startCodexCommittedRoomResponder(runtime, prepared!, committed)).toThrow();
            expect(sdkMocks.prompts).toHaveLength(modelsBefore + 1);
            expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
              commitsBefore + 1
            );
          }
        } catch (cause) {
          failed = true;
          first = cause;
        } finally {
          await drainOriginalCleanup();
        }
      };
      if (scenario === selectedNativeCase) {
        if (!selectedNativeOwner) throw new Error('Selected genuine fixture was not prepared.');
        await selectedNativeOwner.run(runOriginalCase);
      } else {
        await runOriginalCase();
      }
    }
  );
});

it('cold-loads the real constructor graph and cannot replay its settled original commitment', async () => {
  vi.resetModules();
  const { nativeCommittedCodexRoomFixture } =
    await import('../../../canvas/doc-channel/writes/__tests__/authority-fixtures.js');
  const coldRuntime = await import('../codex-runtime.js');
  sdkMocks.behavior = 'park-past-abort';
  const h = await nativeCommittedCodexRoomFixture({
    options: sdkMocks.constructorOptions,
    prompts: sdkMocks.prompts,
    releaseProducer: () => sdkMocks.releaseParked?.(),
    completeFutureTurns: () => {
      sdkMocks.behavior = 'complete';
    },
  });
  let failed = false;
  let primary: unknown;
  try {
    const admission = h.db.$client
      .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
      .get(h.admission.admission_id);
    expect(admission).toMatchObject({ status: 'settled', outcome: 'turn_done' });
    const spends = h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all();
    const models = sdkMocks.prompts.length;
    expect(coldRuntime.readCodexNativeOperation(h.nativeOperation)).toBeUndefined();
    expect(() =>
      coldRuntime.startCodexCommittedRoomResponder(h.runtime, h.prepared, h.committed)
    ).toThrow();
    // An old module's map cannot recognize even a genuine object from the cold graph.
    expect(() => startCodexCommittedRoomResponder(h.runtime, h.prepared, h.committed)).toThrow();
    expect(sdkMocks.prompts).toHaveLength(models);
    expect(h.db.$client.prepare('SELECT * FROM room_turn_spend ORDER BY id').all()).toEqual(spends);
    expect(
      h.db.$client
        .prepare('SELECT * FROM room_doc_admissions WHERE admission_id=?')
        .get(h.admission.admission_id)
    ).toEqual(admission);
  } catch (cause) {
    failed = true;
    primary = cause;
  } finally {
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        primary = cause;
      }
    }
  }
  if (failed) throw primary;
});
