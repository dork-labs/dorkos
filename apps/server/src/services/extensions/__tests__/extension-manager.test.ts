import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManager } from '../extension-manager.js';
import type { CoreExtensionInfo } from '../extension-enable-resolution.js';

// --- Mocks ---

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
  ExtensionDiscovery: vi.fn().mockImplementation(() => ({
    discover: mockDiscover,
  })),
}));

const mockCompile = vi.fn();
const mockReadBundle = vi.fn();
const mockCleanStaleCache = vi.fn().mockResolvedValue(0);
vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(() => ({
    compile: mockCompile,
    readBundle: mockReadBundle,
    cleanStaleCache: mockCleanStaleCache,
  })),
}));

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

const mockAccess = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
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

describe('ExtensionManager', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigGet.mockReturnValue({ enabled: [], disabled: [] });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  // === 1. Initialize ===

  it('initializes by cleaning cache, discovering, and compiling enabled extensions', async () => {
    const enabledRecord = makeRecord('ext-a', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-a'], disabled: [] });
    mockDiscover.mockResolvedValue([enabledRecord]);
    mockCompile.mockResolvedValue({ code: 'compiled code', sourceHash: 'abc123' });

    await manager.initialize('/my/project');

    expect(mockCleanStaleCache).toHaveBeenCalledOnce();
    expect(mockDiscover).toHaveBeenCalledWith(
      '/my/project',
      { enabled: ['ext-a'], disabled: [] },
      expect.any(Map)
    );
    expect(mockCompile).toHaveBeenCalledWith(enabledRecord);
  });

  // === 2. Enable flow ===

  it('enables an extension: disabled -> enabled -> compiled, adds to config', async () => {
    const record = makeRecord('ext-a', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash123' });

    await manager.initialize(null);

    const result = await manager.enable('ext-a');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('compiled');
    expect(result!.extension.bundleReady).toBe(true);
    expect(result!.reloadRequired).toBe(true);
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', { enabled: ['ext-a'], disabled: [] });
  });

  // === 3. Enable with compile error ===

  it('sets compile_error status when compilation fails during enable', async () => {
    const record = makeRecord('ext-b', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({
      error: {
        code: 'compilation_failed',
        message: 'Syntax error',
        errors: [{ text: 'Unexpected token' }],
      },
      sourceHash: 'badhash',
    });

    await manager.initialize(null);

    const result = await manager.enable('ext-b');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('compile_error');
    expect(result!.extension.bundleReady).toBe(false);
    expect(result!.extension.error).toMatchObject({
      code: 'compilation_failed',
      message: 'Syntax error',
      details: 'Unexpected token',
    });
  });

  // === 4. Disable flow ===

  it('disables an extension: removes from config and resets status', async () => {
    const record = makeRecord('ext-c', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-c'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    const result = await manager.disable('ext-c');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('disabled');
    expect(result!.extension.bundleReady).toBe(false);
    expect(result!.extension.error).toBeUndefined();
    expect(result!.reloadRequired).toBe(true);
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', { enabled: [], disabled: [] });
  });

  // === 5. Reject enable incompatible ===

  it('returns null when enabling an incompatible extension', async () => {
    const record = makeRecord('incompat', { status: 'incompatible' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    const result = await manager.enable('incompat');

    expect(result).toBeNull();
    expect(mockCompile).not.toHaveBeenCalled();
  });

  // === 6. Reject enable invalid ===

  it('returns null when enabling an invalid extension', async () => {
    const record = makeRecord('invalid-ext', { status: 'invalid' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    const result = await manager.enable('invalid-ext');

    expect(result).toBeNull();
  });

  // === 7. Reload ===

  it('re-discovers and recompiles on reload', async () => {
    const record1 = makeRecord('ext-1', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record1]);

    await manager.initialize(null);
    expect(manager.listPublic()).toHaveLength(1);

    // Now simulate a reload with a new extension
    const record2 = makeRecord('ext-2', { status: 'enabled' });
    mockDiscover.mockResolvedValue([record1, record2]);
    mockCompile.mockResolvedValue({ code: 'new bundle', sourceHash: 'newhash' });

    const result = await manager.reload();

    expect(result).toHaveLength(2);
    expect(mockDiscover).toHaveBeenCalledTimes(2);
  });

  // === 8. Read bundle ===

  it('reads bundle for compiled extensions', async () => {
    const record = makeRecord('ext-d', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-d'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'bundle-code', sourceHash: 'hash456' });
    mockReadBundle.mockResolvedValue('bundle-code');

    await manager.initialize(null);

    const bundle = await manager.readBundle('ext-d');

    expect(bundle).toBe('bundle-code');
    expect(mockReadBundle).toHaveBeenCalledWith('ext-d', 'hash456');
  });

  it('returns null when reading bundle for a disabled extension', async () => {
    const record = makeRecord('ext-e', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    const bundle = await manager.readBundle('ext-e');

    expect(bundle).toBeNull();
    expect(mockReadBundle).not.toHaveBeenCalled();
  });

  it('returns null when reading bundle for a non-existent extension', async () => {
    await manager.initialize(null);

    const bundle = await manager.readBundle('no-such-ext');

    expect(bundle).toBeNull();
  });

  // === 9. Report activated ===

  it('transitions status from compiled to active on reportActivated', async () => {
    const record = makeRecord('ext-f', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-f'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);
    expect(manager.get('ext-f')?.status).toBe('compiled');

    manager.reportActivated('ext-f');

    expect(manager.get('ext-f')?.status).toBe('active');
  });

  it('does not change status on reportActivated if not compiled', async () => {
    const record = makeRecord('ext-g', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    manager.reportActivated('ext-g');

    expect(manager.get('ext-g')?.status).toBe('disabled');
  });

  // === 10. Report activate error ===

  it('transitions to activate_error with error message on reportActivateError', async () => {
    const record = makeRecord('ext-h', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-h'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    manager.reportActivateError('ext-h', 'Runtime error in activate()');

    const ext = manager.get('ext-h');
    expect(ext?.status).toBe('activate_error');
    expect(ext?.error).toEqual({
      code: 'activate_error',
      message: 'Runtime error in activate()',
    });
  });

  // === 11. Update CWD diff ===

  it('returns added and removed extension IDs when CWD changes', async () => {
    // First discovery: ext-a only
    const recordA = makeRecord('ext-a', { status: 'disabled' });
    mockDiscover.mockResolvedValue([recordA]);

    await manager.initialize('/project-1');

    // Second discovery after CWD change: ext-b only (ext-a removed)
    const recordB = makeRecord('ext-b', { status: 'disabled' });
    mockDiscover.mockResolvedValue([recordB]);

    const diff = await manager.updateCwd('/project-2');

    expect(diff.added).toEqual(['ext-b']);
    expect(diff.removed).toEqual(['ext-a']);
  });

  it('returns empty diff when CWD change produces same extensions', async () => {
    const record = makeRecord('ext-a', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);

    await manager.initialize(null);

    const diff = await manager.updateCwd('/new-project');

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  // === 12. toPublic strips internal fields ===

  it('strips path and sourceHash from public records', async () => {
    const record = makeRecord('ext-i', {
      status: 'enabled',
      path: '/secret/path/to/ext',
      sourceHash: 'internalhash',
    });
    mockConfigGet.mockReturnValue({ enabled: ['ext-i'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'internalhash' });

    await manager.initialize(null);

    const publicList = manager.listPublic();

    expect(publicList).toHaveLength(1);
    const pub = publicList[0];
    expect(pub.id).toBe('ext-i');
    expect(pub.status).toBe('compiled');
    expect(pub.bundleReady).toBe(true);
    // origin is surfaced to the client
    expect(pub.origin).toBe('user');
    // These internal fields must NOT be present
    expect('path' in pub).toBe(false);
    expect('sourceHash' in pub).toBe(false);
  });

  it('carries origin through toPublic for both core and user records', async () => {
    mockDiscover.mockResolvedValue([
      makeRecord('core-ext', { status: 'disabled', origin: 'core' }),
      makeRecord('user-ext', { status: 'disabled', origin: 'user' }),
    ]);

    await manager.initialize(null);

    const pubById = Object.fromEntries(manager.listPublic().map((p) => [p.id, p]));
    expect(pubById['core-ext'].origin).toBe('core');
    expect(pubById['user-ext'].origin).toBe('user');
  });

  // === Additional edge cases ===

  it('returns null when enabling a non-existent extension', async () => {
    await manager.initialize(null);

    const result = await manager.enable('ghost');

    expect(result).toBeNull();
  });

  it('returns null when disabling a non-existent extension', async () => {
    await manager.initialize(null);

    const result = await manager.disable('ghost');

    expect(result).toBeNull();
  });

  it('does not duplicate ID in enabled list when enabling already-enabled extension', async () => {
    const record = makeRecord('ext-j', { status: 'disabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-j'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    await manager.enable('ext-j');

    // setEnabled() strips the id from both lists before re-adding, so the
    // already-enabled id is written through exactly once (no duplicate).
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', { enabled: ['ext-j'], disabled: [] });
    const lastEnabled = mockConfigSet.mock.calls.at(-1)![1].enabled as string[];
    expect(lastEnabled.filter((id) => id === 'ext-j')).toHaveLength(1);
  });

  it('reads bundle for active extensions', async () => {
    const record = makeRecord('ext-k', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-k'], disabled: [] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'activehash' });
    mockReadBundle.mockResolvedValue('active-bundle');

    await manager.initialize(null);
    manager.reportActivated('ext-k');

    const bundle = await manager.readBundle('ext-k');

    expect(bundle).toBe('active-bundle');
    expect(mockReadBundle).toHaveBeenCalledWith('ext-k', 'activehash');
  });

  // === createExtension ===

  describe('createExtension', () => {
    beforeEach(() => {
      // Default: directory does not exist (ENOENT)
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
    });

    it('scaffolds a global extension directory with manifest and index.ts', async () => {
      // After reload the new extension is discovered and compiled
      const newRecord = makeRecord('my-widget', { status: 'enabled' });
      mockDiscover
        .mockResolvedValueOnce([]) // initialize
        .mockResolvedValueOnce([newRecord]); // reload from createExtension (enable does not call reload)
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash123' });

      await manager.initialize(null);

      const result = await manager.createExtension({
        name: 'my-widget',
        description: 'A dashboard widget',
        template: 'dashboard-card',
        scope: 'global',
      });

      expect(result.id).toBe('my-widget');
      expect(result.scope).toBe('global');
      expect(result.template).toBe('dashboard-card');
      expect(result.files).toEqual(['extension.json', 'index.ts']);
      expect(mockMkdir).toHaveBeenCalledWith('/fake/dork-home/extensions/my-widget', {
        recursive: true,
      });
      // extension.json and index.ts should have been written
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('scaffolds a local extension when scope is local', async () => {
      const newRecord = makeRecord('local-ext', { status: 'enabled', scope: 'local' });
      mockDiscover
        .mockResolvedValueOnce([]) // initialize
        .mockResolvedValueOnce([newRecord]); // reload from createExtension (enable does not call reload)
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash456' });

      await manager.initialize('/my/project');

      const result = await manager.createExtension({
        name: 'local-ext',
        template: 'command',
        scope: 'local',
      });

      expect(result.scope).toBe('local');
      expect(mockMkdir).toHaveBeenCalledWith('/my/project/.dork/extensions/local-ext', {
        recursive: true,
      });
    });

    it('throws when creating local extension without active CWD', async () => {
      await manager.initialize(null);

      await expect(
        manager.createExtension({
          name: 'orphan-ext',
          template: 'dashboard-card',
          scope: 'local',
        })
      ).rejects.toThrow('Cannot create local extension: no working directory is active');
    });

    it('throws when extension directory already exists', async () => {
      // Directory exists (access succeeds)
      mockAccess.mockResolvedValue(undefined);

      await manager.initialize(null);

      await expect(
        manager.createExtension({
          name: 'existing-ext',
          template: 'dashboard-card',
          scope: 'global',
        })
      ).rejects.toThrow("Extension 'existing-ext' already exists");
    });

    it('includes compilation errors in result when compile fails', async () => {
      const newRecord = makeRecord('bad-ext', {
        status: 'compile_error',
        error: {
          code: 'compilation_failed',
          message: 'Syntax error',
          details: 'Unexpected token at line 5',
        },
      });
      mockDiscover
        .mockResolvedValueOnce([]) // initialize
        .mockResolvedValueOnce([newRecord]); // reload from createExtension (enable does not call reload)
      mockCompile.mockResolvedValue({
        error: {
          code: 'compilation_failed',
          message: 'Syntax error',
          errors: [{ text: 'Unexpected token at line 5' }],
        },
        sourceHash: 'badhash',
      });

      await manager.initialize(null);

      const result = await manager.createExtension({
        name: 'bad-ext',
        template: 'dashboard-card',
        scope: 'global',
      });

      expect(result.status).toBe('compile_error');
      expect(result.bundleReady).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('compilation_failed');
    });

    it('enables the extension after scaffolding', async () => {
      const newRecord = makeRecord('auto-enable', { status: 'enabled' });
      mockDiscover
        .mockResolvedValueOnce([]) // initialize
        .mockResolvedValueOnce([newRecord]); // reload from createExtension (enable does not call reload)
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'hash' });

      await manager.initialize(null);

      await manager.createExtension({
        name: 'auto-enable',
        template: 'dashboard-card',
        scope: 'global',
      });

      // compile should have been called: once during reload's compileEnabled and once during enable
      expect(mockCompile).toHaveBeenCalled();
      // Config should have been updated with the new extension enabled
      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: ['auto-enable'],
        disabled: [],
      });
    });
  });

  // === reloadExtension (single) ===

  describe('reloadExtension', () => {
    it('recompiles a single extension and returns compiled result', async () => {
      // Use 'disabled' status so compileEnabled() skips it during initialize
      const record = makeRecord('my-ext', { status: 'disabled' });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'new-bundle', sourceHash: 'newhash' });

      await manager.initialize(null);

      const result = await manager.reloadExtension('my-ext');

      expect(result.id).toBe('my-ext');
      expect(result.status).toBe('compiled');
      expect(result.bundleReady).toBe(true);
      expect(result.sourceHash).toBe('newhash');
      expect(result.error).toBeUndefined();
    });

    it('returns compile_error when recompilation fails', async () => {
      const record = makeRecord('broken-ext', { status: 'disabled' });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({
        error: {
          code: 'compilation_failed',
          message: 'Type error',
          errors: [
            {
              text: 'Type X not assignable to Y',
              location: { file: 'index.ts', line: 10, column: 5 },
            },
          ],
        },
        sourceHash: 'hash2',
      });

      await manager.initialize(null);

      const result = await manager.reloadExtension('broken-ext');

      expect(result.id).toBe('broken-ext');
      expect(result.status).toBe('compile_error');
      expect(result.bundleReady).toBe(false);
      expect(result.sourceHash).toBe('hash2');
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('compilation_failed');
      expect(result.error!.errors).toHaveLength(1);
      expect(result.error!.errors![0].text).toBe('Type X not assignable to Y');
    });

    it('throws when extension ID is not found', async () => {
      await manager.initialize(null);

      await expect(manager.reloadExtension('nonexistent')).rejects.toThrow(
        "Extension 'nonexistent' not found"
      );
    });

    it('updates the internal record status after successful reload', async () => {
      const record = makeRecord('ext-reload', { status: 'disabled' });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({ code: 'bundle', sourceHash: 'newhash' });

      await manager.initialize(null);

      await manager.reloadExtension('ext-reload');

      const updated = manager.get('ext-reload');
      expect(updated?.status).toBe('compiled');
      expect(updated?.bundleReady).toBe(true);
      expect(updated?.sourceHash).toBe('newhash');
      expect(updated?.error).toBeUndefined();
    });

    it('updates the internal record status after failed reload', async () => {
      const record = makeRecord('ext-fail', { status: 'disabled' });
      mockDiscover.mockResolvedValue([record]);
      mockCompile.mockResolvedValue({
        error: {
          code: 'compilation_failed',
          message: 'Parse error',
          errors: [{ text: 'Unexpected end of input' }],
        },
        sourceHash: 'hash2',
      });

      await manager.initialize(null);

      await manager.reloadExtension('ext-fail');

      const updated = manager.get('ext-fail');
      expect(updated?.status).toBe('compile_error');
      expect(updated?.bundleReady).toBe(false);
      expect(updated?.error?.code).toBe('compilation_failed');
    });
  });

  // === Tier-aware toggle routing (core extensions) ===

  describe('tier-aware toggle routing', () => {
    const onCore: CoreExtensionInfo = { id: 'marketplace', defaultEnabled: true, canDisable: true };
    const offCore: CoreExtensionInfo = {
      id: 'hello-world',
      defaultEnabled: false,
      canDisable: true,
    };
    const lockedCore: CoreExtensionInfo = {
      id: 'locked',
      defaultEnabled: true,
      canDisable: false,
    };

    it('disabling a default-on core ext adds its id to disabled (not removed from enabled)', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [onCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: [] });
      mockDiscover.mockResolvedValue([
        makeRecord('marketplace', { status: 'enabled', origin: 'core' }),
      ]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      await manager.disable('marketplace');

      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: [],
        disabled: ['marketplace'],
      });
    });

    it('enabling a disabled default-on core ext removes its id from disabled', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [onCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: ['marketplace'] });
      mockDiscover.mockResolvedValue([
        makeRecord('marketplace', { status: 'disabled', origin: 'core' }),
      ]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      await manager.enable('marketplace');

      expect(mockConfigSet).toHaveBeenCalledWith('extensions', { enabled: [], disabled: [] });
    });

    it('enabling a default-off core ext adds its id to enabled', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [offCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: [] });
      mockDiscover.mockResolvedValue([
        makeRecord('hello-world', { status: 'disabled', origin: 'core' }),
      ]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      await manager.enable('hello-world');

      expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
        enabled: ['hello-world'],
        disabled: [],
      });
    });

    it('refuses to disable a canDisable:false core ext (returns null, no config write)', async () => {
      const manager = new ExtensionManager('/fake/dork-home', [lockedCore]);
      mockConfigGet.mockReturnValue({ enabled: [], disabled: [] });
      mockDiscover.mockResolvedValue([makeRecord('locked', { status: 'enabled', origin: 'core' })]);
      mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'h' });
      await manager.initialize(null);

      const result = await manager.disable('locked');

      expect(result).toBeNull();
      expect(mockConfigSet).not.toHaveBeenCalled();
    });
  });
});
