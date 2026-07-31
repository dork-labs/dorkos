/**
 * Binding subsystem initialization survives a non-Claude default runtime
 * (DOR-768).
 *
 * `BindingSubsystem.init` picks the runtime that new chat-originated sessions
 * are created against. It used to look up `runtimeRegistry.getDefaultType()` in
 * the AdapterManager's runtime map and throw when it missed — and `init` catches
 * its own throw, downgrades it to a warn line, and returns `undefined`. The
 * caller treats that as "no binding routing" and carries on. So the failure mode
 * was a server that boots clean, connects its chat adapters, accepts messages,
 * and delivers none of them.
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike } from '@dorkos/relay';

const getDefaultType = vi.fn(() => 'claude-code');
const getSessionRuntimeType = vi.fn(async (_sessionId: string) => 'claude-code');

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefaultType: () => getDefaultType(),
    getSessionRuntimeType: (id: string) => getSessionRuntimeType(id),
  },
}));

import { BindingSubsystem } from '../binding-subsystem.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

/**
 * A runtime that records the sessions it was asked to create, so a test can
 * tell WHICH runtime the subsystem chose rather than only that it chose one.
 *
 * @param type - The runtime type this stands in for.
 */
function fakeRuntime(type: string) {
  const ensured: string[] = [];
  const runtime = {
    type,
    ensured,
    ensureSession: vi.fn((id: string) => {
      ensured.push(id);
    }),
    sendMessage: vi.fn(),
    getSdkSessionId: vi.fn(() => undefined),
    approveTool: vi.fn(() => false),
  };
  return runtime as unknown as AgentRuntimeLike & { ensured: string[] };
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

describe('BindingSubsystem.init runtime selection', () => {
  it('initializes routing when the default runtime is the one the relay holds', async () => {
    const claude = fakeRuntime('claude-code');
    const subsystem = await init(new Map([['claude-code', claude]]));

    expect(subsystem).toBeDefined();
    expect(subsystem?.getBindingRouter()).toBeDefined();
  });

  it('initializes routing when the default runtime is opencode and the relay holds claude-code', async () => {
    // The DOR-768 acceptance configuration. Before the fix this returned
    // undefined: the default-type lookup missed, init caught its own throw, and
    // chat-platform routing was silently off.
    getDefaultType.mockReturnValue('opencode');
    const claude = fakeRuntime('claude-code');

    const subsystem = await init(new Map([['claude-code', claude]]));

    expect(subsystem).toBeDefined();
    expect(subsystem?.getBindingRouter()).toBeDefined();
  });

  it('initializes routing in test mode, where the default type is test-mode', async () => {
    // Live the whole time, not introduced by this ticket: the legacy single
    // `agentManager` wrap keyed the runtime under 'claude-code' while the
    // default type was 'test-mode'.
    getDefaultType.mockReturnValue('test-mode');
    const testMode = fakeRuntime('test-mode');

    const subsystem = await init(new Map([['test-mode', testMode]]));

    expect(subsystem).toBeDefined();
    expect(subsystem?.getBindingRouter()).toBeDefined();
  });

  it('prefers the default runtime over another the relay also holds', async () => {
    // The fallback must not shadow a default that IS available — otherwise the
    // first two cases would pass for the wrong reason (map-order luck).
    getDefaultType.mockReturnValue('test-mode');
    const claude = fakeRuntime('claude-code');
    const testMode = fakeRuntime('test-mode');

    const subsystem = await init(
      new Map([
        ['claude-code', claude],
        ['test-mode', testMode],
      ])
    );

    const router = subsystem?.getBindingRouter();
    expect(router).toBeDefined();
    // Reach the chosen runtime through the seam the router actually uses.
    await (
      router as unknown as {
        deps: { agentManager: { createSession(cwd: string, mode: string): Promise<unknown> } };
      }
    ).deps.agentManager.createSession('/tmp/project', 'default');

    expect((testMode as unknown as { ensured: string[] }).ensured).toHaveLength(1);
    expect((claude as unknown as { ensured: string[] }).ensured).toHaveLength(0);
  });

  it('falls back to the runtime the relay holds, and creates sessions on it', async () => {
    getDefaultType.mockReturnValue('opencode');
    const claude = fakeRuntime('claude-code');

    const subsystem = await init(new Map([['claude-code', claude]]));
    const router = subsystem?.getBindingRouter();
    await (
      router as unknown as {
        deps: { agentManager: { createSession(cwd: string, mode: string): Promise<unknown> } };
      }
    ).deps.agentManager.createSession('/tmp/project', 'default');

    expect((claude as unknown as { ensured: string[] }).ensured).toHaveLength(1);
  });

  it('returns undefined when the relay holds no runtimes at all', async () => {
    // The one case that genuinely cannot be served. It must still be non-fatal.
    const subsystem = await init(new Map());
    expect(subsystem).toBeUndefined();
  });
});
