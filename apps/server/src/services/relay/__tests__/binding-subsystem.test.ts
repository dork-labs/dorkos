/**
 * Which runtime a chat-originated session is created on, and that init never
 * fails silently (DOR-768, DOR-1614). Init used to swallow its own throw and
 * return `undefined`, so a server booted clean, connected its chat adapters and
 * delivered nothing. The runtime is now the ADDRESSED AGENT's own, read from a
 * real manifest on disk when the session is created.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike } from '@dorkos/relay';

const getDefaultType = vi.fn(() => 'claude-code');
/** Which runtime types this server registered — what `has` answers about. */
let registeredTypes = ['claude-code'];
/** Records every session ownership write the creator makes (DOR-1614). */
const persistSessionRuntime = vi.fn(async (..._args: unknown[]) => true);

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefaultType: () => getDefaultType(),
    getSessionRuntimeType: async () => 'claude-code',
    has: (type: string) => registeredTypes.includes(type),
    persistSessionRuntime: (...args: unknown[]) => persistSessionRuntime(...args),
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

/** A runtime that records the sessions (and options) it was asked to create. */
function fakeRuntime(type: string) {
  const ensuredOpts: Record<string, unknown>[] = [];
  const runtime = {
    type,
    ensuredOpts,
    ensureSession: vi.fn((_id: string, opts: Record<string, unknown>) => {
      ensuredOpts.push(opts);
    }),
    sendMessage: vi.fn(),
    getSdkSessionId: vi.fn(() => undefined),
    approveTool: vi.fn(() => false),
  };
  return runtime as unknown as AgentRuntimeLike & {
    ensureSession: ReturnType<typeof vi.fn>;
    ensuredOpts: Record<string, unknown>[];
  };
}

let relayDir: string;
const dirs: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  getDefaultType.mockReturnValue('claude-code');
  registeredTypes = ['claude-code', 'codex', 'opencode', 'test-mode'];
  persistSessionRuntime.mockResolvedValue(true);
  relayDir = await mkdtemp(path.join(tmpdir(), 'dorkos-binding-subsystem-'));
  dirs.push(relayDir);
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function init(entries: [string, AgentRuntimeLike][]) {
  return BindingSubsystem.init({
    relayCore: {
      publish: vi.fn(async () => ({ messageId: 'm', deliveredTo: 0 })),
      subscribe: vi.fn(() => () => {}),
    },
    meshCore: { getProjectPath: vi.fn(() => undefined) } as unknown as AdapterMeshCoreLike,
    agentRuntimes: new Map(entries),
    configPath: path.join(relayDir, 'adapters.json'),
  });
}

/** Create a session through the seam the router uses, for the agent working in `cwd`. */
async function createSessionThrough(subsystem: BindingSubsystem, cwd: string) {
  const router = subsystem.getBindingRouter() as unknown as {
    deps: {
      agentManager: {
        createSession(cwd: string, mode: string, agentPath: string): Promise<{ id: string }>;
      };
    };
  };
  expect(router).toBeDefined();
  return router.deps.agentManager.createSession(cwd, 'default', cwd);
}

/** Write a real `.dork/agent.json` into a fresh temp directory. */
async function agentWith(manifest: Record<string, unknown>): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-binding-agent-'));
  dirs.push(agentDir);
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
  // DOR-768: a default the relay does not hold, and test mode, both used to
  // leave chat routing silently off.
  it.each([
    ['claude-code', 'claude-code'],
    ['opencode', 'claude-code'],
    ['test-mode', 'test-mode'],
  ])('initializes routing when the default is %s and the relay holds %s', async (def, held) => {
    getDefaultType.mockReturnValue(def);
    const subsystem = await init([[held, fakeRuntime(held)]]);
    expect(subsystem.getBindingRouter()).toBeDefined();
  });

  it("creates the session on the addressed agent's own runtime, and records it (DOR-1614)", async () => {
    const agentDir = await agentWith({ runtime: 'codex' });
    const claude = fakeRuntime('claude-code');
    const codex = fakeRuntime('codex');
    const subsystem = await init([
      ['claude-code', claude],
      ['codex', codex],
    ]);
    const session = await createSessionThrough(subsystem, agentDir);
    expect(codex.ensureSession).toHaveBeenCalledTimes(1);
    expect(claude.ensureSession).not.toHaveBeenCalled();
    // A binding grants the session no power of its own (DOR-604, DOR-2105).
    expect(persistSessionRuntime).toHaveBeenCalledWith(
      session.id,
      'codex',
      { kind: 'relay-binding' },
      agentDir
    );
  });

  it('still opens the session when the ownership write fails', async () => {
    const agentDir = await agentWith({ runtime: 'codex' });
    persistSessionRuntime.mockRejectedValue(new Error('database is locked'));
    const codex = fakeRuntime('codex');
    await createSessionThrough(await init([['codex', codex]]), agentDir);
    expect(codex.ensureSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the manifest names an unregistered runtime', ['test-mode'], 'test-mode'],
    ["the relay's map is missing the agent's runtime", undefined, 'claude-code'],
  ])('falls back to the default entry when %s', async (_label, registry, held) => {
    const agentDir = await agentWith({ runtime: 'codex' });
    if (registry) registeredTypes = registry;
    getDefaultType.mockReturnValue(held);
    const runtime = fakeRuntime(held);
    await createSessionThrough(await init([[held, runtime]]), agentDir);
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("creates a chat-originated session on the addressed agent's own model", async () => {
    // The router creates the session here, before the adapter's own
    // `ensureSession`, so a model resolved only there reached nothing.
    const agentDir = await agentWith({ model: 'claude-haiku-4-5' });
    const claude = fakeRuntime('claude-code');
    await createSessionThrough(await init([['claude-code', claude]]), agentDir);
    expect(claude.ensuredOpts[0]).toEqual({
      permissionMode: 'default',
      cwd: agentDir,
      model: 'claude-haiku-4-5',
    });
  });

  it('throws when the relay holds no runtimes at all', async () => {
    await expect(createSessionThrough(await init([]), '/tmp/project')).rejects.toThrow(
      /holds no agent runtimes/
    );
  });
});

describe('BindingSubsystem.init failure handling', () => {
  // A throw is what stops Telegram and Slack starting with no routing and no
  // consent gate behind them.
  it('propagates a store failure instead of returning undefined', async () => {
    const failure = new Error('EMFILE: too many open files');
    const spy = vi.spyOn(BindingStore.prototype, 'init').mockRejectedValue(failure);
    try {
      await expect(init([['claude-code', fakeRuntime('claude-code')]])).rejects.toThrow(failure);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes what it opened before rethrowing', async () => {
    const routerInit = vi
      .spyOn(BindingRouter.prototype, 'init')
      .mockRejectedValue(new Error('EMFILE: too many open files'));
    const storeShutdown = vi
      .spyOn(BindingStore.prototype, 'shutdown')
      .mockImplementation(async () => {});
    try {
      await expect(init([['claude-code', fakeRuntime('claude-code')]])).rejects.toThrow(/EMFILE/);
      expect(storeShutdown).toHaveBeenCalledTimes(1);
    } finally {
      routerInit.mockRestore();
      storeShutdown.mockRestore();
    }
  });
});
