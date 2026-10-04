/**
 * Approvals bound to a declared permission set, end to end through the
 * extension manager (DOR-2686 task 1.3): approving records the set the
 * extension declares; the same manifest keeps running with nothing to click;
 * a narrower one too; a wider one stops and waits; and, until DorkOS can run
 * an extension in its own process, one that asks for that never runs at all,
 * in-process or otherwise.
 *
 * The rig is `extension-load-policy.test.ts`'s: a config store whose `set`
 * writes through to what `get` reads, a stand-in `require()` that evaluates
 * whatever bundle the lifecycle wrote, so a mounted router means the real
 * load path ran.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { mayRunExtensionCode } from '../../extension-load-policy.js';
import { isPendingApproval } from '../../extension-approval-queue.js';

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

vi.mock('../../extension-server-api-factory.js', () => ({
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
    releaseListeners: () => {},
    tools: { seal: () => ({ handled: [], unhandled: [] }), close: () => {} },
  }),
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDiscover = vi.fn<() => Promise<ExtensionRecord[]>>();
vi.mock('../../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return { discover: mockDiscover };
  }),
}));

const mockCompile = vi.fn();
const mockCompileServer = vi.fn();
const mockReadBundle = vi.fn();
vi.mock('../../extension-compiler.js', () => ({
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
/** The `extensions` config shape these tests store; `approvedSources` may predate DOR-2383. */
interface StoredExtensions {
  enabled: string[];
  disabled: string[];
  approvedToRun: string[];
  approvedSources?: Record<string, { path: string; plugin?: string }>;
  approvedPermissions?: Record<string, ApprovedPermissionSet>;
}
const stored = vi.hoisted(() => ({
  value: { enabled: [], disabled: [], approvedToRun: [] } as StoredExtensions,
}));
// `set` WRITES THROUGH to the same object `get` reads. A mock that only records
// the call would let `approveToRun` look like it worked while the gate kept
// reading the old list — the test would pass and the feature would not.
const mockConfigSet = vi.fn((key: string, value: unknown) => {
  if (key === 'extensions') stored.value = value as typeof stored.value;
});
vi.mock('../../../core/config-manager.js', () => ({
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

import { ExtensionManager } from '../../extension-manager.js';

const PATH = '/fake/dork-home/extensions/mail-app';

/** A record for `mail-app` with these server capabilities. */
function makeRecord(serverCapabilities: Record<string, unknown>): ExtensionRecord {
  return {
    id: 'mail-app',
    manifest: {
      id: 'mail-app',
      name: 'Mail',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', ...serverCapabilities },
    } as ExtensionManifest,
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    path: PATH,
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
  };
}

/** A subprocess manifest's capabilities. */
const isolated = (allow: Record<string, unknown>) => ({ runtime: 'subprocess', allow });

describe('an approval covers the permission set it was given for', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = { enabled: ['mail-app'], disabled: [], approvedToRun: [] };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    mockReadBundle.mockResolvedValue('export function activate() {}');
    manager = new ExtensionManager('/fake/dork-home');
  });

  // Purpose: approving records exactly what the extension declares, beside
  // the copy, and the identical manifest after a re-scan asks nothing.
  it('records the declared set, and the same manifest runs without asking', async () => {
    mockDiscover.mockResolvedValue([makeRecord(isolated({ net: ['imap.example.com:993'] }))]);
    await manager.initialize(null);
    await manager.approveToRun('mail-app');
    expect(stored.value.approvedPermissions).toEqual({
      'mail-app': { runtime: 'subprocess', net: ['imap.example.com:993'], run: [], agents: false },
    });
    mockConfigSet.mockClear();
    mockDiscover.mockResolvedValue([makeRecord(isolated({ net: ['imap.example.com:993'] }))]);
    await manager.reload();
    const record = manager.get('mail-app')!;
    expect(mayRunExtensionCode(record, stored.value)).toBe(true);
    expect(isPendingApproval(record, stored.value)).toBe(false);
    // Nothing was written: no new approval was needed.
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  // Purpose: a wider manifest under the same approved copy stops running and
  // waits; approving again records the wider set and lets it run.
  it('makes a widened manifest wait for a person again', async () => {
    mockDiscover.mockResolvedValue([makeRecord(isolated({ net: ['imap.example.com:993'] }))]);
    await manager.initialize(null);
    await manager.approveToRun('mail-app');

    mockDiscover.mockResolvedValue([
      makeRecord(isolated({ net: ['imap.example.com:993'], run: ['bash'], agents: true })),
    ]);
    await manager.reload();
    const widened = manager.get('mail-app')!;
    expect(mayRunExtensionCode(widened, stored.value)).toBe(false);
    expect(isPendingApproval(widened, stored.value)).toBe(true);

    await manager.approveToRun('mail-app');
    expect(stored.value.approvedPermissions?.['mail-app']).toEqual({
      runtime: 'subprocess',
      net: ['imap.example.com:993'],
      run: ['bash'],
      agents: true,
    });
    expect(mayRunExtensionCode(manager.get('mail-app')!, stored.value)).toBe(true);
  });

  // Purpose: narrowing keeps the approval and writes nothing.
  it('lets a narrowed manifest keep running', async () => {
    mockDiscover.mockResolvedValue([
      makeRecord(isolated({ net: ['a.example.com', 'b.example.com'], agents: true })),
    ]);
    await manager.initialize(null);
    await manager.approveToRun('mail-app');
    mockConfigSet.mockClear();
    mockDiscover.mockResolvedValue([makeRecord(isolated({ net: ['a.example.com'] }))]);
    await manager.reload();
    expect(mayRunExtensionCode(manager.get('mail-app')!, stored.value)).toBe(true);
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  // Purpose: an approval given before sets were recorded (no entry) is the
  // full in-process set, so an existing extension still runs after upgrade,
  // and moving it to subprocess is a narrowing that asks nothing.
  it('keeps running an approval that recorded no set', async () => {
    stored.value = {
      enabled: ['mail-app'],
      disabled: [],
      approvedToRun: ['mail-app'],
      approvedSources: { 'mail-app': { path: PATH } },
    };
    mockDiscover.mockResolvedValue([makeRecord({})]);
    await manager.initialize(null);
    expect(manager.getServerRouter('mail-app')).not.toBeNull();
    const moved = makeRecord(isolated({ net: ['x.example.com'], run: ['git'], agents: true }));
    expect(mayRunExtensionCode(moved, stored.value)).toBe(true);
  });

  // Purpose: withdrawing an approval forgets its set too, so nothing stale is
  // read against whatever is approved next.
  it('forgets the set with the approval', async () => {
    mockDiscover.mockResolvedValue([makeRecord(isolated({ net: ['a.example.com'] }))]);
    await manager.initialize(null);
    await manager.approveToRun('mail-app');
    await manager.revokeRunApproval('mail-app');
    expect(stored.value.approvedPermissions).toEqual({});
  });
});

describe('an extension that asks to run separately does not run yet', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.value = {
      enabled: ['mail-app'],
      disabled: [],
      approvedToRun: ['mail-app'],
      approvedSources: { 'mail-app': { path: PATH } },
    };
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'h1' });
    mockCompileServer.mockResolvedValue({
      code: 'module.exports = function register(router, ctx) {};',
      sourceHash: 'h1',
    });
    manager = new ExtensionManager('/fake/dork-home');
  });

  // Purpose: an approved subprocess extension is refused after the approval
  // gate with the grep-able code, and none of its server code is compiled or
  // evaluated — it never runs in-process as a fallback.
  it('refuses it with isolation_not_ready and runs none of its code', async () => {
    mockDiscover.mockResolvedValue([makeRecord(isolated({}))]);
    await manager.initialize(null);
    const result = await manager.initializeServer('mail-app');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Mail needs a newer version of DorkOS to run.');
    expect(manager.get('mail-app')!.serverError).toEqual({
      code: 'isolation_not_ready',
      message: 'Mail needs a newer version of DorkOS to run.',
    });
    expect(mockCompileServer).not.toHaveBeenCalled();
    expect(manager.getServerRouter('mail-app')).toBeNull();
  });

  // Purpose: a running in-process extension whose manifest moves to
  // subprocess is stopped, not left serving its old code.
  it('stops an in-process instance when the manifest moves to subprocess', async () => {
    mockDiscover.mockResolvedValue([makeRecord({})]);
    await manager.initialize(null);
    expect(manager.getServerRouter('mail-app')).not.toBeNull();

    mockDiscover.mockResolvedValue([makeRecord(isolated({}))]);
    await manager.reload();
    await manager.initializeServer('mail-app');
    expect(manager.getServerRouter('mail-app')).toBeNull();
  });
});
