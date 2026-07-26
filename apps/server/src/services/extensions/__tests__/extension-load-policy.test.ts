/**
 * The extension load gate (DOR-516): a person approves an extension id once,
 * before its code may run inside the DorkOS server process, and after that the
 * whole edit-test-reload loop is unprompted.
 *
 * Two things are pinned here, and the second matters more than the first:
 *
 * 1. **Every in-process load path refuses an unapproved extension.** Not the MCP
 *    tools one by one — the two functions that actually execute extension code
 *    ({@link ExtensionServerLifecycle.initialize} and {@link testClientExtension}),
 *    reached through each of the manager entry points the routes and tools use.
 *    Gating the tools would have left `POST /api/extensions/:id/init-server`
 *    walking straight around it, which is the shape DOR-467 already cost this
 *    repo once.
 * 2. **One approval is enough, forever.** The reason this feature is a policy on
 *    the artifact rather than a `destructive` tier is that a per-call card would
 *    fire once per compile error. So the loop is asserted end to end, including a
 *    compile error and the fix after it, with `configManager.set` watched to prove
 *    nothing re-asks.
 *
 * @module services/extensions/__tests__/extension-load-policy
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  mayRunInServer,
  describeExtensionLoadRefusal,
  EXTENSION_NOT_APPROVED_CODE,
} from '../extension-load-policy.js';

// Stand in for the `require()` of the compiled server entry, evaluating whatever
// the lifecycle "wrote" to its temp file — the same rig as
// `extension-manager-server.test.ts`, so a mounted router here means the real
// load path ran end to end rather than being stubbed past.
const { mockRequireFn, lastWrittenCodeRef } = vi.hoisted(() => {
  const codeRef = { value: '' };
  const resolveImpl = Object.assign((p: string) => p, { resolve: (p: string) => p });
  const cacheObj: Record<string, unknown> = {};
  const requireImpl = Object.assign(
    (_path: string) => {
      const mod = { exports: {} as Record<string, unknown> };
      const fn = new Function('module', 'exports', 'require', codeRef.value);
      fn(mod, mod.exports, requireImpl);
      return mod.exports;
    },
    { resolve: resolveImpl, cache: cacheObj }
  );
  return { mockRequireFn: requireImpl, lastWrittenCodeRef: codeRef };
});

vi.mock('node:module', () => ({ createRequire: () => mockRequireFn }));

vi.mock('../extension-server-api-factory.js', () => ({
  createDataProviderContext: () => ({
    ctx: {
      secrets: {},
      storage: { loadData: vi.fn(), saveData: vi.fn() },
      schedule: vi.fn(),
      emit: vi.fn(),
      extensionId: 'my-ext',
      extensionDir: '/fake/extensions/my-ext',
    },
    getScheduledCleanups: () => [],
  }),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDiscover = vi.fn<() => Promise<ExtensionRecord[]>>();
vi.mock('../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return { discover: mockDiscover };
  }),
}));

const mockCompile = vi.fn();
const mockCompileServer = vi.fn();
const mockReadBundle = vi.fn();
vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: mockCompile,
      compileServer: mockCompileServer,
      readBundle: mockReadBundle,
      cleanStaleCache: vi.fn().mockResolvedValue(0),
    };
  }),
}));

/** The stored `extensions` config the gate reads, mutable per test. */
const stored = vi.hoisted(() => ({
  value: { enabled: [] as string[], disabled: [] as string[], approvedToRun: [] as string[] },
}));
// `set` WRITES THROUGH to the same object `get` reads. A mock that only records
// the call would let `approveToRun` look like it worked while the gate kept
// reading the old list — the test would pass and the feature would not.
const mockConfigSet = vi.fn((key: string, value: unknown) => {
  if (key === 'extensions') stored.value = value as typeof stored.value;
});
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: () => stored.value,
    set: (...args: [string, unknown]) => mockConfigSet(...args),
  },
}));

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockImplementation(async (path: string, content: string) => {
  if (typeof content === 'string' && path.endsWith('.js')) lastWrittenCodeRef.value = content;
});
vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
  },
}));

import { ExtensionManager } from '../extension-manager.js';

function makeRecord(id: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    path: `/fake/extensions/${id}`,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  };
}

/** A bundle whose `activate()` would be observable if it were ever evaluated. */
const OBSERVABLE_BUNDLE =
  'export function activate(api) { api.registerCommand("x", "X", () => {}); }';

describe('mayRunInServer', () => {
  it('refuses a user extension that nobody approved', () => {
    expect(mayRunInServer('my-ext', 'user', [])).toBe(false);
    expect(mayRunInServer('my-ext', 'user', ['some-other-ext'])).toBe(false);
  });

  it('allows a user extension a person approved', () => {
    expect(mayRunInServer('my-ext', 'user', ['my-ext'])).toBe(true);
  });

  it('allows a core extension with no approval at all', () => {
    // Core extensions ship inside the DorkOS the person installed. Gating them
    // would make DorkOS ask permission to run itself, and would break the bundled
    // `linear-issues` data proxy on every install.
    expect(mayRunInServer('linear-issues', 'core', [])).toBe(true);
  });

  it('is decided by id, never by a manifest claim', () => {
    // The `origin` argument comes from the startup staging set, not from anything
    // the extension says about itself, so an extension cannot declare itself core.
    expect(mayRunInServer('pretender', 'user', ['a-different-id'])).toBe(false);
  });
});

describe('describeExtensionLoadRefusal', () => {
  it('names the extension and tells the model retrying cannot work', () => {
    const text = describeExtensionLoadRefusal('my-ext');
    expect(text).toContain("'my-ext'");
    expect(text).toContain('Retrying will be refused');
    expect(text).toContain('Settings > Extensions');
  });
});

describe('the load gate, at every path that runs extension code', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };
    mockDiscover.mockResolvedValue([]);
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue(OBSERVABLE_BUNDLE);
    manager = new ExtensionManager('/fake/dork-home');
  });

  /** Seed one server-entry extension into the manager's map. */
  async function seedServerExtension(id = 'my-ext') {
    mockDiscover.mockResolvedValue([makeRecord(id, { status: 'enabled', hasServerEntry: true })]);
    await manager.initialize(null);
  }

  it('refuses at startup, and never writes the loadable bundle to disk', async () => {
    await seedServerExtension();

    // `initialize()` loops every discovered record through the server lifecycle.
    // The refusal has to land before `compileServer` and before the temp file that
    // `require()` would read, or "we did not load it" is only half true.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(manager.getServerRouter('my-ext')).toBeNull();
  });

  it('refuses POST /api/extensions/:id/init-server (the direct REST primitive)', async () => {
    await seedServerExtension();

    const result = await manager.initializeServer('my-ext');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Settings > Extensions');
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerRouter('my-ext')).toBeNull();
  });

  it('refuses the server half of enable(), which is what the marketplace and Shapes reach', async () => {
    mockDiscover.mockResolvedValue([
      makeRecord('my-ext', { status: 'disabled', hasServerEntry: true }),
    ]);
    await manager.initialize(null);

    const result = await manager.enable('my-ext');

    // Enabling still succeeds — approval and on/off are different questions, and
    // the client bundle is compiled and served to the browser either way.
    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('compiled');
    // But nothing ran in this process.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerRouter('my-ext')).toBeNull();
    expect(result!.extension.approvedToRun).toBe(false);
  });

  it('refuses the server half of reload_extensions --id', async () => {
    await seedServerExtension();
    vi.clearAllMocks();
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h2' });

    const result = await manager.reloadExtension('my-ext');

    // The client bundle still recompiles, so the agent still gets real errors.
    expect(result.status).toBe('compiled');
    expect(mockCompile).toHaveBeenCalled();
    // The server entry does not load.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerRouter('my-ext')).toBeNull();
  });

  it('refuses test_extension BEFORE compiling, and never imports the bundle', async () => {
    mockDiscover.mockResolvedValue([makeRecord('my-ext')]);
    await manager.initialize(null);
    vi.clearAllMocks();

    const result = await manager.testExtension('my-ext');

    expect(result.status).toBe('error');
    expect(result.phase).toBe('approval');
    expect(result.error).toContain('Settings > Extensions');
    // `testClientExtension` is the sharpest path: it `import()`s a data URI and
    // calls `activate()`. Refusing ahead of the compile proves nothing about the
    // extension was even built, let alone evaluated.
    expect(mockCompile).not.toHaveBeenCalled();
    expect(mockReadBundle).not.toHaveBeenCalled();
    expect(result.contributions).toBeUndefined();
  });

  it('lets a CORE extension load with no approval anywhere in config', async () => {
    stored.value = { enabled: [], disabled: [], approvedToRun: [] };
    mockDiscover.mockResolvedValue([
      makeRecord('linear-issues', { status: 'enabled', origin: 'core', hasServerEntry: true }),
    ]);

    await manager.initialize(null);

    expect(mockCompileServer).toHaveBeenCalled();
    expect(manager.getServerRouter('linear-issues')).not.toBeNull();
  });
});

describe('the dev loop stays free after one approval', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue(OBSERVABLE_BUNDLE);
    mockDiscover.mockResolvedValue([
      makeRecord('my-ext', { status: 'enabled', hasServerEntry: true }),
    ]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('asks once, then never again across test, reload, a compile error, and the fix', async () => {
    await manager.initialize(null);

    // --- 1. FIRST TIME: the agent tries to run it, and DorkOS says no.
    const firstTest = await manager.testExtension('my-ext');
    expect(firstTest.status).toBe('error');
    expect(firstTest.phase).toBe('approval');

    // --- 2. A PERSON APPROVES, once, in Settings > Extensions.
    await manager.approveToRun('my-ext');
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
    });
    // The approve route is what makes one click enough: the extension is running
    // now, without a restart.
    expect(manager.getServerRouter('my-ext')).not.toBeNull();

    // Everything from here on must happen with NO further config write. That is
    // the whole claim of this feature, so it is watched rather than assumed.
    mockConfigSet.mockClear();

    // --- 3. SECOND TIME: the same call now goes through.
    const secondTest = await manager.testExtension('my-ext');
    expect(secondTest.status).toBe('ok');
    expect(secondTest.phase).toBeUndefined();

    // --- 4. Hot reload: silent.
    mockCompile.mockResolvedValue({ code: 'bundle-v2', sourceHash: 'h2' });
    const reloaded = await manager.reloadExtension('my-ext');
    expect(reloaded.status).toBe('compiled');
    expect(manager.getServerRouter('my-ext')).not.toBeNull();

    // --- 5. The agent breaks the build. This is the case a per-call approval card
    // would have carded, and the reason the gate is on the artifact instead.
    mockCompile.mockResolvedValue({
      error: { code: 'compilation_failed', message: 'Type error', errors: [{ text: 'boom' }] },
      sourceHash: 'h3',
    });
    const broken = await manager.reloadExtension('my-ext');
    expect(broken.status).toBe('compile_error');
    expect(broken.error?.message).toBe('Type error');

    // --- 6. The agent fixes it and reloads. Still silent.
    mockCompile.mockResolvedValue({ code: 'bundle-v3', sourceHash: 'h4' });
    const fixed = await manager.reloadExtension('my-ext');
    expect(fixed.status).toBe('compiled');
    expect(manager.getServerRouter('my-ext')).not.toBeNull();

    const afterFix = await manager.testExtension('my-ext');
    expect(afterFix.status).toBe('ok');

    // Not one further write to the approval list across steps 3-6.
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it('survives the user turning the extension off and on again', async () => {
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: ['my-ext'] };
    await manager.initialize(null);

    await manager.disable('my-ext');
    // `setEnabled` returns a whole-subtree replacement, so a version of it that
    // named only `enabled`/`disabled` would erase every approval on the install.
    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: [],
      disabled: [],
      approvedToRun: ['my-ext'],
    });

    stored.value = { enabled: [], disabled: [], approvedToRun: ['my-ext'] };
    await manager.enable('my-ext');
    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
    });
    // Back on, still approved, running again with nothing asked of the person.
    expect(manager.getServerRouter('my-ext')).not.toBeNull();
  });

  it('stops the extension again when a person withdraws the approval', async () => {
    stored.value = { enabled: ['my-ext'], disabled: [], approvedToRun: ['my-ext'] };
    await manager.initialize(null);
    expect(manager.getServerRouter('my-ext')).not.toBeNull();

    await manager.revokeRunApproval('my-ext');

    expect(mockConfigSet).toHaveBeenLastCalledWith('extensions', {
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: [],
    });
    expect(manager.getServerRouter('my-ext')).toBeNull();
  });
});

describe('reload_extensions --id on an extension the user turned OFF', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Turned off in config, but APPROVED — so the only thing that can stop the
    // load is the enabled check, not the approval gate.
    stored.value = { enabled: [], disabled: [], approvedToRun: ['off-ext'] };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockDiscover.mockResolvedValue([
      makeRecord('off-ext', { status: 'disabled', hasServerEntry: true }),
    ]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('refuses, instead of quietly turning it back on and running its server entry', async () => {
    await manager.initialize(null);

    await expect(manager.reloadExtension('off-ext')).rejects.toThrow(/turned off/);

    // The bug this replaces: `applyCompileResult` wrote `status = 'compiled'` over
    // `'disabled'`, and `'compiled'` is a status the server lifecycle accepts — so
    // the routes mounted and `server.ts` ran while the cockpit toggle still read
    // off. Assert the record was not touched either, not just the load.
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerRouter('off-ext')).toBeNull();
    expect(manager.get('off-ext')!.status).toBe('disabled');
  });
});

describe('the refusal code is stable', () => {
  it('is the string both the service and the routes report', () => {
    // Pinned because it is a machine-readable contract: the routes send it in
    // `code`, and changing it silently would break any caller matching on it.
    expect(EXTENSION_NOT_APPROVED_CODE).toBe('extension_not_approved_to_run');
  });
});
