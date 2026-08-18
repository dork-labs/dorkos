import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { logger } from '../../../lib/logger.js';

// --- Hoisted mocks (available before module-level code runs) ---

const { mockRequireFn, lastWrittenCodeRef } = vi.hoisted(() => {
  const codeRef = { value: '' };
  const resolveImpl = Object.assign((p: string) => p, { resolve: (p: string) => p });
  const cacheObj: Record<string, unknown> = {};
  const requireImpl = Object.assign(
    (_path: string) => {
      // Evaluate the CJS code that was "written" to the temp file
      const mod = { exports: {} as Record<string, unknown> };
      const fn = new Function('module', 'exports', 'require', codeRef.value);
      fn(mod, mod.exports, requireImpl);
      return mod.exports;
    },
    { resolve: resolveImpl, cache: cacheObj }
  );
  return {
    mockRequireFn: requireImpl,
    mockRequireResolve: resolveImpl,
    mockRequireCache: cacheObj,
    lastWrittenCodeRef: codeRef,
  };
});

vi.mock('node:module', () => ({
  createRequire: () => mockRequireFn,
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

// --- Helpers ---

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
      approvedToRun: [
        'srv-ext',
        'no-srv',
        'disabled-srv',
        'bad-srv',
        'throw-srv',
        'obj-srv',
        'reinit-ext',
        'idem-ext',
        'proxy-ext',
        'shutdown-ext',
        'router-ext',
        'auto-srv',
        'fail-srv',
        'dis-srv',
      ],
    });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  // === initializeServer ===

  describe('initializeServer', () => {
    it('compiles, loads, and registers a server extension router', async () => {
      const record = makeRecord('srv-ext', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/srv-ext/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);

      const result = await manager.initializeServer('srv-ext');

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockCompileServer).toHaveBeenCalledWith(record);
      expect(mockCreateDataProviderContext).toHaveBeenCalledWith({
        extensionId: 'srv-ext',
        extensionDir: '/fake/extensions/srv-ext',
        dorkHome: '/fake/dork-home',
      });
    });

    it('returns ok:false for extensions without server entry', async () => {
      const record = makeRecord('no-srv', { status: 'compiled', hasServerEntry: false });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });

      await manager.initialize(null);

      const result = await manager.initializeServer('no-srv');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Extension has no server entry or is not enabled');
    });

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

    it('returns ok:false when server compilation fails', async () => {
      const record = makeRecord('bad-srv', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/bad-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        error: {
          code: 'compilation_failed',
          message: 'Syntax error in server.ts',
          errors: [{ text: 'Unexpected token' }],
        },
        sourceHash: 'badhash',
      });

      await manager.initialize(null);

      const result = await manager.initializeServer('bad-srv');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Syntax error in server.ts');
    });

    it('returns ok:false when register function throws', async () => {
      const record = makeRecord('throw-srv', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/throw-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule({ throws: true }),
        sourceHash: 'throwhash',
      });

      await manager.initialize(null);

      const result = await manager.initializeServer('throw-srv');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('register failed');
    });

    it('returns ok:false when module does not export a function', async () => {
      const record = makeRecord('obj-srv', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/obj-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: `module.exports = { notAFunction: true };`,
        sourceHash: 'objhash',
      });

      await manager.initialize(null);

      const result = await manager.initializeServer('obj-srv');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Server entry does not export a register function');
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
      const first = manager.getServerRouter('reinit-ext');
      expect(first).not.toBeNull();

      // The extension's server.ts changed, so the running instance is stale.
      mockCompileServer.mockResolvedValue({ code: makeCjsModule(), sourceHash: 'srvhash-v2' });
      await manager.initializeServer('reinit-ext');

      expect(manager.getServerRouter('reinit-ext')).not.toBe(first);
      // The scheduled cleanup from the first init should have been called
      expect(mockScheduledCleanup).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Server shutdown for reinit-ext')
      );
    });

    /**
     * The client POSTs `/api/extensions/:id/init-server` for every server-side
     * extension on every page load and every tab, so an unconditional restart
     * meant the marketplace extension tore itself down and re-evaluated its
     * module seconds after boot, and again on each new tab (DOR-1336 / F10).
     */
    describe('idempotence', () => {
      it('leaves an unchanged running server extension alone', async () => {
        const record = makeRecord('idem-ext', {
          status: 'compiled',
          hasServerEntry: true,
          serverEntryPath: '/fake/extensions/idem-ext/server.ts',
        });
        mockDiscover.mockResolvedValue([record]);
        mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
        mockCompileServer.mockResolvedValue({ code: makeCjsModule(), sourceHash: 'srvhash' });

        await manager.initialize(null);
        const router = manager.getServerRouter('idem-ext');
        expect(mockCreateDataProviderContext).toHaveBeenCalledTimes(1);

        // What every page load asks for.
        const result = await manager.initializeServer('idem-ext');

        expect(result).toEqual({ ok: true });
        expect(manager.getServerRouter('idem-ext')).toBe(router);
        expect(mockCreateDataProviderContext).toHaveBeenCalledTimes(1);
        expect(mockScheduledCleanup).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining('Server shutdown for idem-ext')
        );
      });

      it('leaves an unchanged proxy-only extension mounted', async () => {
        const record = makeRecord('proxy-ext', {
          status: 'compiled',
          hasDataProxy: true,
          manifest: {
            id: 'proxy-ext',
            name: 'proxy-ext',
            version: '1.0.0',
            dataProxy: { baseUrl: 'https://api.example.com', authSecret: 'api_key' },
          },
        });
        mockDiscover.mockResolvedValue([record]);
        mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });

        await manager.initialize(null);
        const router = manager.getServerRouter('proxy-ext');
        expect(router).not.toBeNull();

        await manager.initializeServer('proxy-ext');

        expect(manager.getServerRouter('proxy-ext')).toBe(router);
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining('Server shutdown for proxy-ext')
        );
      });

      it('restarts an extension whose reload the operator asked for', async () => {
        const record = makeRecord('reload-ext', {
          status: 'compiled',
          hasServerEntry: true,
          serverEntryPath: '/fake/extensions/reload-ext/server.ts',
        });
        mockConfigGet.mockReturnValue({
          enabled: ['reload-ext'],
          disabled: [],
          approvedToRun: ['reload-ext'],
        });
        mockDiscover.mockResolvedValue([record]);
        mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
        mockCompileServer.mockResolvedValue({ code: makeCjsModule(), sourceHash: 'srvhash' });

        await manager.initialize(null);
        const router = manager.getServerRouter('reload-ext');

        // `reload_extensions --id` means "run this again", even byte-for-byte.
        await manager.reloadExtension('reload-ext');

        expect(manager.getServerRouter('reload-ext')).not.toBe(router);
        expect(mockScheduledCleanup).toHaveBeenCalled();
      });
    });
  });

  // === shutdownServer ===

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

      expect(manager.getServerRouter('shutdown-ext')).not.toBeNull();

      await manager.shutdownServer('shutdown-ext');

      expect(manager.getServerRouter('shutdown-ext')).toBeNull();
      expect(mockScheduledCleanup).toHaveBeenCalled();
    });

    it('is a no-op for extensions without an active server', async () => {
      await manager.initialize(null);

      // Should not throw
      await manager.shutdownServer('nonexistent');
    });
  });

  // === getServerRouter ===

  describe('getServerRouter', () => {
    it('returns router for an active server extension', async () => {
      const record = makeRecord('router-ext', {
        status: 'compiled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/router-ext/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);
      await manager.initializeServer('router-ext');

      const router = manager.getServerRouter('router-ext');

      expect(router).not.toBeNull();
    });

    it('returns null for extensions without an active server', async () => {
      await manager.initialize(null);

      const router = manager.getServerRouter('nonexistent');

      expect(router).toBeNull();
    });
  });

  // === Lifecycle integration ===

  describe('enable with server entry', () => {
    it('calls initializeServer automatically after successful compilation', async () => {
      const record = makeRecord('auto-srv', {
        status: 'disabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/auto-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      await manager.initialize(null);

      await manager.enable('auto-srv');

      expect(mockCompileServer).toHaveBeenCalled();
      expect(manager.getServerRouter('auto-srv')).not.toBeNull();
    });

    it('still enables even if server init fails', async () => {
      const record = makeRecord('fail-srv', {
        status: 'disabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/fail-srv/server.ts',
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        error: {
          code: 'compilation_failed',
          message: 'Server compile error',
          errors: [{ text: 'bad code' }],
        },
        sourceHash: 'badhash',
      });

      await manager.initialize(null);

      const result = await manager.enable('fail-srv');

      // Extension should still be enabled (client-side compiled successfully)
      expect(result).not.toBeNull();
      expect(result!.extension.status).toBe('compiled');
      // But no server router should be active
      expect(manager.getServerRouter('fail-srv')).toBeNull();
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
      expect(manager.getServerRouter('dis-srv')).not.toBeNull();

      await manager.disable('dis-srv');

      expect(manager.getServerRouter('dis-srv')).toBeNull();
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
        approvedToRun: ['reload-srv'],
      });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      // initialize compiles enabled extensions (disabled -> compiled) and inits server
      await manager.initialize(null);
      expect(manager.getServerRouter('reload-srv')).not.toBeNull();

      // Reload should shut down and reinitialize
      await manager.reloadExtension('reload-srv');

      // Server router should still be available (reinitialized)
      expect(manager.getServerRouter('reload-srv')).not.toBeNull();
      // compileServer called twice: once during initialize, once during reload
      expect(mockCompileServer).toHaveBeenCalledTimes(2);
    });
  });

  describe('startup initialization', () => {
    it('initializes server extensions for all compiled extensions on startup', async () => {
      const srvRecord = makeRecord('startup-srv', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/startup-srv/server.ts',
      });
      const clientRecord = makeRecord('startup-client', {
        status: 'enabled',
        hasServerEntry: false,
      });
      mockConfigGet.mockReturnValue({
        enabled: ['startup-srv', 'startup-client'],
        disabled: [],
        approvedToRun: ['startup-srv', 'startup-client'],
      });
      mockDiscover.mockResolvedValue([srvRecord, clientRecord]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockResolvedValue({
        code: makeCjsModule(),
        sourceHash: 'srvhash',
      });

      await manager.initialize('/my/project');

      // Server extension should have been initialized
      expect(mockCompileServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'startup-srv' })
      );
      expect(manager.getServerRouter('startup-srv')).not.toBeNull();
      // Client-only extension should not have server router
      expect(manager.getServerRouter('startup-client')).toBeNull();
    });

    it('does not let one extension throwing during startup stop the rest from initializing', async () => {
      // Regression coverage: a transient failure (an EMFILE reading one
      // extension's entry point, say) used to reject uncaught from
      // compileServer(), which this loop did not catch — one bad extension
      // took every extension queued after it down with it. Simulated here
      // with a rejection from compileServer() directly, since that is the
      // shape of "server init threw" this loop must isolate regardless of
      // what caused it.
      const throwsRecord = makeRecord('startup-throws', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/startup-throws/server.ts',
      });
      const survivesRecord = makeRecord('startup-survives', {
        status: 'enabled',
        hasServerEntry: true,
        serverEntryPath: '/fake/extensions/startup-survives/server.ts',
      });
      mockConfigGet.mockReturnValue({
        enabled: ['startup-throws', 'startup-survives'],
        disabled: [],
        approvedToRun: ['startup-throws', 'startup-survives'],
      });
      mockDiscover.mockResolvedValue([throwsRecord, survivesRecord]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });
      mockCompileServer.mockImplementation(async (record: ExtensionRecord) => {
        if (record.id === 'startup-throws') {
          throw new Error('EMFILE: too many open files');
        }
        return { code: makeCjsModule(), sourceHash: 'srvhash' };
      });

      const { logger } = await import('../../../lib/logger.js');
      await manager.initialize('/my/project');

      // The extension after the throwing one still got initialized.
      expect(manager.getServerRouter('startup-survives')).not.toBeNull();
      // The failure is not silently swallowed — it is named and visible.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('startup-throws'),
        expect.any(Error)
      );
      expect(manager.getServerRouter('startup-throws')).toBeNull();
    });
  });
});
