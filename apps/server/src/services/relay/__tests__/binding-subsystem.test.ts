/**
 * Which runtime a chat-originated session is created on — and that
 * initialization survives a non-Claude default runtime (DOR-768, DOR-1614).
 *
 * `BindingSubsystem.init` picks the runtime that new chat-originated sessions
 * are created against. It used to look up `runtimeRegistry.getDefaultType()` in
 * the AdapterManager's runtime map and throw when it missed — and `init` caught
 * its own throw, downgraded it to a warn line, and returned `undefined`. The
 * caller treated that as "no binding routing" and carried on. So the failure
 * mode was a server that boots clean, connects its chat adapters, accepts
 * messages, and delivers none of them.
 *
 * Both halves are now closed: the runtime lookup falls back rather than
 * throwing, and a failure that IS fatal propagates instead of being swallowed
 * (see the second describe block).
 *
 * The rule itself then changed (DOR-1614): the runtime is no longer "whichever
 * one the relay was wired to" but the ADDRESSED AGENT's own, read from its
 * manifest at the moment the session is created — and written down, so every
 * later message on that session routes to the same program. The manifest read
 * runs for real against a temp directory here, because "does this path read the
 * manifest at all" is exactly the question.
 *
 * Two configurations hit that miss. `runtimes.default: opencode` is the one this
 * ticket is about. The other has been live the whole time: under
 * `DORKOS_TEST_RUNTIME` the manager's runtime sat under a hardcoded
 * `'claude-code'` key while the default type was `'test-mode'`, so binding
 * routing has never initialized in test mode.
 *
 * These tests construct the subsystem for real — real temp directories, real
 * stores — and assert that a BindingRouter comes back. There was no test
 * exercising this path at all before, which is why a silent init failure could
 * live in the tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike } from '@dorkos/relay';

const getDefaultType = vi.fn(() => 'claude-code');
const getSessionRuntimeType = vi.fn(async (_sessionId: string) => 'claude-code');
/** Which runtime types this server registered — what `has` answers about. */
let registeredTypes = ['claude-code'];
/** Records every session ownership write the creator makes (DOR-1614). */
const persistSessionRuntime = vi.fn(async (..._args: unknown[]) => true);

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefaultType: () => getDefaultType(),
    getSessionRuntimeType: (id: string) => getSessionRuntimeType(id),
    has: (type: string) => registeredTypes.includes(type),
    persistSessionRuntime: (...args: unknown[]) => persistSessionRuntime(...args),
    // A chat-created session is always brand new — the id is minted in the same
    // breath — so it can never have a settings row of its own.
    getSessionSettings: () => Promise.resolve(null),
    get: () => ({
      getCapabilities: () => ({
        settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
      }),
    }),
  },
}));

import { BindingSubsystem } from '../binding-subsystem.js';
import { BindingStore } from '../binding-store.js';
import { BindingRouter } from '../binding-router.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

/**
 * A runtime that records the sessions it was asked to create, so a test can
 * tell WHICH runtime the subsystem chose rather than only that it chose one.
 *
 * @param type - The runtime type this stands in for.
 */
function fakeRuntime(type: string) {
  const ensured: string[] = [];
  /** What each `ensureSession` was asked for — the model included. */
  const ensuredOpts: Record<string, unknown>[] = [];
  const runtime = {
    type,
    ensured,
    ensuredOpts,
    ensureSession: vi.fn((id: string, opts: Record<string, unknown>) => {
      ensured.push(id);
      ensuredOpts.push(opts);
    }),
    sendMessage: vi.fn(),
    getSdkSessionId: vi.fn(() => undefined),
    approveTool: vi.fn(() => false),
  };
  return runtime as unknown as AgentRuntimeLike & {
    ensured: string[];
    ensuredOpts: Record<string, unknown>[];
  };
}

const relayCore = {
  publish: vi.fn(async () => ({ messageId: 'm', deliveredTo: 0 })),
  subscribe: vi.fn(() => () => {}),
};

const meshCore = {
  getProjectPath: vi.fn(() => undefined),
} as unknown as AdapterMeshCoreLike;

let relayDir: string;
let configPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  getDefaultType.mockReturnValue('claude-code');
  getSessionRuntimeType.mockResolvedValue('claude-code');
  registeredTypes = ['claude-code', 'codex', 'opencode', 'test-mode'];
  persistSessionRuntime.mockResolvedValue(true);
  relayDir = await mkdtemp(path.join(tmpdir(), 'dorkos-binding-subsystem-'));
  configPath = path.join(relayDir, 'adapters.json');
});

afterEach(async () => {
  await rm(relayDir, { recursive: true, force: true });
});

/**
 * Initialize a subsystem over the temp relay dir with the given runtime map.
 *
 * @param agentRuntimes - Runtime-type → runtime entries for the manager map.
 */
async function init(agentRuntimes: Map<string, AgentRuntimeLike>) {
  return BindingSubsystem.init({ relayCore, meshCore, agentRuntimes, configPath });
}

/**
 * Create a session through the seam the router actually uses, so a test asserts
 * over the wiring rather than over a function it imported itself.
 *
 * @param subsystem - The initialized subsystem.
 * @param cwd - The answering agent's project directory, which is what the
 *   router passes: it resolves it from the binding's agent id.
 */
async function createSessionThrough(
  subsystem: BindingSubsystem,
  cwd: string
): Promise<{ id: string }> {
  const router = subsystem.getBindingRouter();
  expect(router).toBeDefined();
  return (
    router as unknown as {
      deps: { agentManager: { createSession(cwd: string, mode: string): Promise<{ id: string }> } };
    }
  ).deps.agentManager.createSession(cwd, 'default');
}

/**
 * Write a real `.dork/agent.json` into a fresh temp directory. The manifest read
 * runs for real — a stub would prove nothing about the rule under test, which is
 * exactly "does the relay read the manifest".
 *
 * @param manifest - The manifest fields under test.
 */
async function writeAgentManifest(manifest: Record<string, unknown>): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-binding-agent-'));
  await mkdir(path.join(agentDir, '.dork'), { recursive: true });
  await writeFile(
    path.join(agentDir, '.dork', 'agent.json'),
    JSON.stringify({
      id: 'ana',
      name: 'Ana',
      runtime: 'claude-code',
      registeredAt: '2026-08-18T10:00:00.000Z',
      registeredBy: 'test',
      ...manifest,
    })
  );
  return agentDir;
}

describe('BindingSubsystem.init runtime selection', () => {
  it('initializes routing when the default runtime is the one the relay holds', async () => {
    const claude = fakeRuntime('claude-code');
    const subsystem = await init(new Map([['claude-code', claude]]));

    expect(subsystem.getBindingRouter()).toBeDefined();
  });

  it('initializes routing when the default runtime is opencode and the relay holds claude-code', async () => {
    // The DOR-768 acceptance configuration. Before the fix this returned
    // undefined: the default-type lookup missed, init caught its own throw, and
    // chat-platform routing was silently off.
    getDefaultType.mockReturnValue('opencode');
    const claude = fakeRuntime('claude-code');

    const subsystem = await init(new Map([['claude-code', claude]]));

    expect(subsystem.getBindingRouter()).toBeDefined();
  });

  it('initializes routing in test mode, where the default type is test-mode', async () => {
    // Live the whole time, not introduced by this ticket: the legacy single
    // `agentManager` wrap keyed the runtime under 'claude-code' while the
    // default type was 'test-mode'.
    getDefaultType.mockReturnValue('test-mode');
    const testMode = fakeRuntime('test-mode');

    const subsystem = await init(new Map([['test-mode', testMode]]));

    expect(subsystem.getBindingRouter()).toBeDefined();
  });

  it("creates the session on the ADDRESSED AGENT's own runtime (DOR-1614)", async () => {
    // The rule this replaced was "whatever single runtime the relay was wired
    // to", which answered a Codex agent's Telegram message with Claude Code —
    // the wrong program, under the right agent's name. Which runtime an agent
    // runs on is a property of the agent, so a chat message must reach the same
    // program a room message would.
    const agentDir = await writeAgentManifest({ runtime: 'codex' });
    try {
      const claude = fakeRuntime('claude-code');
      const codex = fakeRuntime('codex');
      const subsystem = await init(
        new Map([
          ['claude-code', claude],
          ['codex', codex],
        ])
      );

      await createSessionThrough(subsystem, agentDir);

      expect(codex.ensured).toHaveLength(1);
      expect(claude.ensured).toHaveLength(0);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('records which runtime owns the session it just created', async () => {
    // Without this write the ownership table has no row, `getSessionRuntimeType`
    // infers claude-code for every relay session, and the router publishes the
    // codex turn above to `relay.agent.claude-code.*` — where the wrong program
    // answers anyway. The rule and the write are one change.
    const agentDir = await writeAgentManifest({ runtime: 'codex' });
    try {
      const subsystem = await init(
        new Map([
          ['claude-code', fakeRuntime('claude-code')],
          ['codex', fakeRuntime('codex')],
        ])
      );

      const session = await createSessionThrough(subsystem, agentDir);

      expect(persistSessionRuntime).toHaveBeenCalledWith(session.id, 'codex', agentDir);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('still opens the session when the ownership write fails', async () => {
    // A failed bookkeeping write must never swallow somebody's first message.
    const agentDir = await writeAgentManifest({ runtime: 'codex' });
    try {
      persistSessionRuntime.mockRejectedValue(new Error('database is locked'));
      const codex = fakeRuntime('codex');
      const subsystem = await init(new Map([['codex', codex]]));

      await createSessionThrough(subsystem, agentDir);

      expect(codex.ensured).toHaveLength(1);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('falls back to the registry default when the manifest names an unregistered runtime', async () => {
    // The same soft fallback rooms take, and the reason a test-mode server —
    // whose manifests all say claude-code — can answer anything at all.
    const agentDir = await writeAgentManifest({ runtime: 'codex' });
    try {
      registeredTypes = ['test-mode'];
      getDefaultType.mockReturnValue('test-mode');
      const testMode = fakeRuntime('test-mode');
      const subsystem = await init(new Map([['test-mode', testMode]]));

      await createSessionThrough(subsystem, agentDir);

      expect(testMode.ensured).toHaveLength(1);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to the relay's default entry when its map is missing the agent's runtime", async () => {
    // A composition-root mismatch rather than a setting: the root passes every
    // registered runtime. A message that arrives still has to be answered.
    const agentDir = await writeAgentManifest({ runtime: 'codex' });
    try {
      const claude = fakeRuntime('claude-code');
      const subsystem = await init(new Map([['claude-code', claude]]));

      await createSessionThrough(subsystem, agentDir);

      expect(claude.ensured).toHaveLength(1);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("creates a chat-originated session on the addressed agent's own model", async () => {
    // The session a Telegram or Slack message opens is created HERE, not by the
    // relay adapter: the router mints the id and calls this, then publishes to
    // `relay.agent.*`. By the time the adapter's own `ensureSession` runs with a
    // model, the session already exists and that call is a no-op — so a model
    // resolved only there reached nothing on this path, and the agent answered
    // strangers on the SDK default while answering rooms on its own model.
    const agentDir = await writeAgentManifest({ model: 'claude-haiku-4-5' });
    try {
      const claude = fakeRuntime('claude-code');
      const subsystem = await init(new Map([['claude-code', claude]]));

      await createSessionThrough(subsystem, agentDir);

      expect(claude.ensuredOpts[0]).toEqual({
        permissionMode: 'default',
        cwd: agentDir,
        model: 'claude-haiku-4-5',
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('throws when the relay holds no runtimes at all', async () => {
    // The one case that genuinely cannot be served. It is raised where the
    // session is created rather than at init: which runtime answers is now a
    // per-agent question, so there is nothing for init itself to decide.
    const subsystem = await init(new Map());
    await expect(createSessionThrough(subsystem, '/tmp/project')).rejects.toThrow(
      /holds no agent runtimes/
    );
  });
});

describe('BindingSubsystem.init failure handling', () => {
  /**
   * A failure inside init used to become one warn line and `undefined`, and the
   * caller — which runs this BEFORE starting any adapter — carried on. Telegram
   * and Slack then connected, accepted messages, routed none of them, and the
   * consent gate that reads this subsystem's binding store was never installed.
   * A throw is what stops the adapters from starting at all.
   */
  it('propagates a store failure instead of returning undefined', async () => {
    // `EMFILE` is the documented shape of this on a machine running several
    // agents at once: the store's watcher cannot be attached.
    const failure = new Error('EMFILE: too many open files');
    const spy = vi.spyOn(BindingStore.prototype, 'init').mockRejectedValue(failure);
    try {
      await expect(init(new Map([['claude-code', fakeRuntime('claude-code')]]))).rejects.toThrow(
        failure
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('closes what it opened before rethrowing', async () => {
    // A retry (a hot-reload, a restart) must not leak the watcher or file
    // handle the first attempt had already opened.
    const shutdown = vi.fn(async () => {});
    const routerInit = vi
      .spyOn(BindingRouter.prototype, 'init')
      .mockRejectedValue(new Error('EMFILE: too many open files'));
    const storeShutdown = vi.spyOn(BindingStore.prototype, 'shutdown').mockImplementation(shutdown);
    try {
      await expect(init(new Map([['claude-code', fakeRuntime('claude-code')]]))).rejects.toThrow(
        /EMFILE/
      );
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      routerInit.mockRestore();
      storeShutdown.mockRestore();
    }
  });
});
