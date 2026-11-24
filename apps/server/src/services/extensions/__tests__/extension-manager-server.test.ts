import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { logger } from '../../../lib/logger.js';

// --- Hoisted mocks (available before module-level code runs) ---

// Stand in for loading the compiled server entry, evaluating whatever the
// lifecycle "wrote" to its temp file.
const { lastWrittenCodeRef } = vi.hoisted(() => ({ lastWrittenCodeRef: { value: '' } }));

vi.mock('../server-bundle/load-in-process.js', () => ({
  loadInProcessBundle: () => {
    const mod = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', 'require', lastWrittenCodeRef.value)(
      mod,
      mod.exports,
      () => ({})
    );
    return mod.exports;
  },
}));

// --- Standard mocks ---

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDiscover = vi.fn<[], Promise<ExtensionRecord[]>>();
vi.mock('../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return {
      discover: mockDiscover,
    };
  }),
}));

const mockCompile = vi.fn();
const mockCompileServer = vi.fn();
const mockReadBundle = vi.fn();
const mockCleanStaleCache = vi.fn().mockResolvedValue(0);
vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: mockCompile,
      compileServer: mockCompileServer,
      readBundle: mockReadBundle,
      cleanStaleCache: mockCleanStaleCache,
    };
  }),
}));

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

const mockScheduledCleanup = vi.fn();
const mockReleaseListeners = vi.fn();
const mockDispose = vi.fn();
const mockCreateDataProviderContext = vi.fn().mockReturnValue({
  ctx: {
    secrets: {},
    storage: { loadData: vi.fn(), saveData: vi.fn() },
    schedule: vi.fn(),
    emit: vi.fn(),
    extensionId: 'test-ext',
    extensionDir: '/fake/extensions/test-ext',
  },
  getScheduledCleanups: () => [mockScheduledCleanup],
  releaseListeners: () => mockReleaseListeners(),
  dispose: () => mockDispose(),
  tools: { seal: () => ({ handled: [], unhandled: [] }), close: () => {} },
});
vi.mock('../extension-server-api-factory.js', () => ({
  createDataProviderContext: (...args: unknown[]) => mockCreateDataProviderContext(...args),
}));

const mockAccess = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockImplementation(async (_path: string, content: string) => {
  // Capture the written code for the mock require to evaluate
  if (typeof content === 'string' && _path.endsWith('.js')) {
    lastWrittenCodeRef.value = content;
  }
});
const mockReadFile = vi.fn();
const mockReaddir = vi.fn();
const mockRm = vi.fn();
const mockStat = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
}));

// Import after mocks are set up
import { ExtensionManager } from '../extension-manager.js';
import { mintMediaTicket, resolveMediaTicket } from '../http/media-tickets.js';
import { runDirMissingMessage } from '../pin/run-dir.js';

// --- Helpers ---

/**
 * The digest every fixture copy holds and every fixture approval names: since
 * DOR-3068 an approval names a copy's files, not only its folder. These tests
 * are about what happens after a yes, so the files on disk never change here;
 * the pin itself is covered in `extension-content-pin.test.ts`.
 */
const FIXTURE_DIGEST = vi.hoisted(() => `sha256:${'f'.repeat(64)}`);
vi.mock('../pin/extension-content-pin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pin/extension-content-pin.js')>()),
  liveDigestOf: vi.fn(async () => FIXTURE_DIGEST),
  pinStillHolds: vi.fn(async () => true),
}));
vi.mock('../pin/extension-snapshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pin/extension-snapshots.js')>()),
  ensureSnapshot: vi.fn(async (_dorkHome: string, root: string) => root),
  collectSnapshots: vi.fn(async () => 0),
}));

/**
 * Approvals of the given ids, each bound to the copy `makeRecord` builds for it
 * (DOR-2383: an approval names the copy it was given to, not just the id).
 */
function approved(ids: string[]): {
  approvedToRun: string[];
  approvedSources: Record<string, { path: string; digest: string }>;
} {
  return {
    approvedToRun: ids,
    approvedSources: Object.fromEntries(
      ids.map((id) => [id, { path: `/fake/extensions/${id}`, digest: FIXTURE_DIGEST }])
    ),
  };
}

function makeRecord(id: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'disabled',
    scope: 'global',
    origin: 'user',
    path: `/fake/extensions/${id}`,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    currentDigest: FIXTURE_DIGEST,
    ...overrides,
  };
}

/**
 * Build a CJS module string that exports a register function.
 * The register function optionally returns a cleanup function.
 */
function makeCjsModule(options: { returnsCleanup?: boolean; throws?: boolean } = {}): string {
  if (options.throws) {
    return `module.exports = function register() { throw new Error('register failed'); };`;
  }
  if (options.returnsCleanup) {
    return `module.exports = function register(router, ctx) { return function cleanup() {}; };`;
  }
  return `module.exports = function register(router, ctx) {};`;
}

describe('ExtensionManager — server lifecycle', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    lastWrittenCodeRef.value = '';
    // Every extension this file uses is pre-approved to run in the server, because
    // these tests are about what happens AFTER a person said yes: compiling,
    // requiring the entry, mounting the router, tearing it down. The gate that
    // decides whether they get that far (DOR-516) is covered in
    // `extension-load-policy.test.ts` and `extension-load-gate.test.ts`; leaving it
    // unapproved here would silently turn every assertion below into a re-test of
    // the gate.
    mockConfigGet.mockReturnValue({
      enabled: [],
      disabled: [],
      ...approved([
        'srv-ext',
        'no-srv',
        'disabled-srv',
        'bad-srv',
        'pinned-srv',
        'throw-srv',
        'obj-srv',
        'reinit-ext',
        'idem-ext',
        'proxy-ext',
        'shutdown-ext',
        'fetch-ext',
        'fetch-only',
        'bad-fetch',
        'router-ext',
        'auto-srv',
        'fail-srv',
        'dis-srv',
      ]),
    });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  describe('initializeServer', () => {
    it('returns ok:false for disabled extensions', async () => {
      const record = makeRecord('disabled-srv', {
        status: 'disabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/disabled-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);

      await manager.initialize(null);

      const result = await manager.initializeServer('disabled-srv');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Extension has no server entry or is not enabled');
    });

    // Purpose: a pinned copy whose checked copy went away while it compiled
    // (a rescan cleared `runPath`) never starts from the folder it was found
    // in, inside DorkOS or in its own process: it is refused with the fixed
    // words, never loaded or given a ctx, and the start does not throw
    // (pin/run-dir).
    it.each([
      ['inside DorkOS', {}],
      ['in its own process', { isolation: {} as ExtensionRecord['isolation'] }],
    ])('refuses to start a pinned copy with no snapshot %s', async (_where, how) => {
      const record = makeRecord('pinned-srv', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/pinned-srv/server.ts',
        ...how,
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockImplementation(async (rec: ExtensionRecord) => {
        rec.pinnedDigest = FIXTURE_DIGEST;
        rec.runPath = undefined;
        return { code: makeCjsModule(), sourceHash: 'srvhash' };
      });
      await manager.initialize(null);
      mockCreateDataProviderContext.mockClear();
      vi.mocked(logger.error).mockClear();

      const result = await manager.initializeServer('pinned-srv');

      expect(result).toEqual({ ok: false, error: runDirMissingMessage(record.manifest.name) });
      expect(mockCreateDataProviderContext).not.toHaveBeenCalled();
      // Refused before a start began, not a start that failed.
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('shuts down the existing instance when the server source changed', async () => {
      const record = makeRecord('reinit-ext', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/reinit-ext/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      // `initialize` already started it once.
      await manager.initialize(null);
      const first = manager.getServerHandler('reinit-ext');
      expect(first).not.toBeNull();

      // The extension's server.ts changed, so the running instance is stale.
      mockCompileServer.mockResolvedValue({ code: makeCjsModule(), sourceHash: 'srvhash-v2' });
      await manager.initializeServer('reinit-ext');

      expect(manager.getServerHandler('reinit-ext')).not.toBe(first);
      // The scheduled cleanup from the first init should have been called
      expect(mockScheduledCleanup).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Server shutdown for reinit-ext')
      );
    });
  });

  describe('shutdownServer', () => {
    it('cancels scheduled tasks and calls cleanup function', async () => {
      const record = makeRecord('shutdown-ext', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/shutdown-ext/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule({ returnsCleanup: true }),
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);
      await manager.initializeServer('shutdown-ext');

      expect(manager.getServerHandler('shutdown-ext')).not.toBeNull();

      await manager.shutdownServer('shutdown-ext');

      expect(manager.getServerHandler('shutdown-ext')).toBeNull();
      expect(mockScheduledCleanup).toHaveBeenCalled();
      expect(mockReleaseListeners).toHaveBeenCalledTimes(1);
      // DOR-2462: the cleanups list is a copy taken when `register()` returned.
      // Fails if the context is not disposed too, so a timer the extension
      // scheduled later, or schedules after this, keeps running.
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });

    it('serves a fetch handler register() returns, and runs its cleanup on shutdown', async () => {
      const record = makeRecord('fetch-ext', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/fetch-ext/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: `module.exports = function register() {
          return {
            fetch: () => new Response('ok'),
            cleanup() { globalThis.__fetchExtCleaned = true; },
          };
        };`,
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);
      expect(await manager.initializeServer('fetch-ext')).toEqual({ ok: true });
      expect(manager.getServerHandler('fetch-ext')).not.toBeNull();

      await manager.shutdownServer('fetch-ext');

      expect((globalThis as { __fetchExtCleaned?: boolean }).__fetchExtCleaned).toBe(true);
      delete (globalThis as { __fetchExtCleaned?: boolean }).__fetchExtCleaned;
    });

    it('stops what a refused register() scheduled, and keeps it from starting more', async () => {
      const record = makeRecord('bad-fetch', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/bad-fetch/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: `module.exports = function register(_router, ctx) {
          ctx.schedule(5, async () => {});
          return { cleanup: 'nope' };
        };`,
        sourceHash: 'srvhash',
      });
      await manager.initialize(null);
      mockDispose.mockClear();

      const result = await manager.initializeServer('bad-fetch');

      expect(result.ok).toBe(false);
      // Disposing cancels its schedules and makes a later `ctx.schedule` inert.
      expect(mockDispose).toHaveBeenCalledTimes(1);
      expect(manager.getServerHandler('bad-fetch')).toBeNull();
    });
  });

  describe('disable with server entry', () => {
    it('calls shutdownServer before disabling', async () => {
      const record = makeRecord('dis-srv', {
        status: 'disabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/dis-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);
      await manager.enable('dis-srv');
      expect(manager.getServerHandler('dis-srv')).not.toBeNull();

      await manager.disable('dis-srv');

      expect(manager.getServerHandler('dis-srv')).toBeNull();
      expect(mockScheduledCleanup).toHaveBeenCalled();
    });
  });

  describe('reloadExtension with server entry', () => {
    it('shuts down old server instance and reinitializes after recompilation', async () => {
      const record = makeRecord('reload-srv', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/reload-srv/server.ts',
      });
      mockConfigGet.mockReturnValue({
        enabled: ['reload-srv'],
        disabled: [],
        ...approved(['reload-srv']),
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      // initialize compiles enabled extensions (disabled -> compiled) and inits server
      await manager.initialize(null);
      expect(manager.getServerHandler('reload-srv')).not.toBeNull();

      // Reload should shut down and reinitialize
      await manager.reloadExtension('reload-srv');

      // Server router should still be available (reinitialized)
      expect(manager.getServerHandler('reload-srv')).not.toBeNull();
      // compileServer called twice: once during initialize, once during reload
      expect(mockCompileServer).toHaveBeenCalledTimes(2);
      // The old instance's context is disposed, so its timers stop beside the
      // new instance's (DOR-2462).
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('a register() that never finishes (security review, DOR-2527)', () => {
    it('stops waiting, marks it as unable to start, and lets every later scan run', async () => {
      const hung = makeRecord('hangs', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/hangs/server.ts',
      });
      const fine = makeRecord('fine', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/fine/server.ts',
      });
      mockConfigGet.mockReturnValue({
        enabled: ['hangs', 'fine'],
        disabled: [],
        ...approved(['hangs', 'fine']),
      });
      mockDiscover.mockResolvedValue([hung, fine]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockImplementation(async (record: ExtensionRecord) => ({
        code:
          record.id === 'hangs'
            ? 'module.exports = function register() { return new Promise(function () {}); };'
            : makeCjsModule(),
        sourceHash: `srv-${record.id}`,
      }));
      const timed = new ExtensionManager('/fake/dork-home', [], { registerTimeoutMs: 50 });

      await timed.initialize('/my/project');

      expect(timed.getServerHandler('hangs')).toBeNull();
      expect(timed.get('hangs')?.serverError).toMatchObject({ code: 'server_start_timeout' });
      expect(timed.get('hangs')?.serverError?.message).toBe(
        'hangs took too long to start. Reload it to try again.'
      );
      // Its context is disposed: what it scheduled is cancelled, what it
      // registered released, and anything it tries later does nothing.
      expect(mockDispose).toHaveBeenCalledTimes(1);
      // The one after it still started, and the next scan is not held up.
      expect(timed.getServerHandler('fine')).not.toBeNull();
      await expect(timed.reload()).resolves.toEqual(expect.any(Array));

      // Retrying does not stack instances: each attempt is disposed in turn,
      // and none of them is ever mounted.
      await timed.reloadExtension('hangs');
      await timed.reloadExtension('hangs');
      expect(mockDispose).toHaveBeenCalledTimes(3);
      expect(timed.getServerHandler('hangs')).toBeNull();
    });
  });

  describe('video links', () => {
    const FETCH_ONLY = `module.exports = function register() {
      return {
        fetch: (request, caller) => {
          globalThis.__mediaSeen = { url: request.url, method: request.method, person: caller.person };
          return new Response('v', { status: 206, headers: { 'content-type': 'video/mp4' } });
        },
      };
    };`;

    async function startMedia(id: string, code: string): Promise<void> {
      const record = makeRecord(id, {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: `/fake/extensions/${id}/server.ts`,
      });
      mockConfigGet.mockReturnValue({ enabled: [id], disabled: [], ...approved([id]) });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({ code, sourceHash: 'srvhash' });
      await manager.initialize(null);
      expect(manager.getServerHandler(id)).not.toBeNull();
    }

    it('gives an extension with only an Express router no way to answer one', async () => {
      await startMedia('router-only', makeCjsModule());
      expect(manager.getMediaFetch('router-only')).toBeNull();
    });

    // Security condition 3: a reload or a stop ends every link the app had.
    it('ends every link of an extension when it reloads, and again when it stops', async () => {
      await startMedia('media-ext', FETCH_ONLY);
      const first = manager.getMediaFetch('media-ext')!;
      const before = mintMediaTicket('media-ext', '/v.mp4', first);
      const otherApp = mintMediaTicket('another-ext', '/v.mp4', {});
      await manager.reloadExtension('media-ext');
      const second = manager.getMediaFetch('media-ext');
      expect(second).not.toBeNull();
      expect(resolveMediaTicket(before)).toBeNull();
      expect(resolveMediaTicket(otherApp)).not.toBeNull();
      // A link minted for the old instance is told apart from the new one even
      // if it survived the revoke: the serve route compares the instance.
      expect(second).not.toBe(first);

      const after = mintMediaTicket('media-ext', '/v.mp4', second!);
      await manager.shutdownServer('media-ext');
      expect(manager.getMediaFetch('media-ext')).toBeNull();
      expect(resolveMediaTicket(after)).toBeNull();
    });
  });
});
