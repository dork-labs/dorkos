import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManager } from '../extension-manager.js';

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

// --- Helpers ---

function makeRecord(id: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'disabled',
    scope: 'global',
    path: `/fake/extensions/${id}`,
    bundleReady: false,
    ...overrides,
  };
}

describe('ExtensionManager', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigGet.mockReturnValue({ enabled: [] });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  // === 1. Initialize ===

  it('initializes by cleaning cache, discovering, and compiling enabled extensions', async () => {
    const enabledRecord = makeRecord('ext-a', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-a'] });
    mockDiscover.mockResolvedValue([enabledRecord]);
    mockCompile.mockResolvedValue({ code: 'compiled code', sourceHash: 'abc123' });

    await manager.initialize('/my/project');

    expect(mockCleanStaleCache).toHaveBeenCalledOnce();
    expect(mockDiscover).toHaveBeenCalledWith('/my/project', ['ext-a']);
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
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: ['ext-a'],
    });
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-c'] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    const result = await manager.disable('ext-c');

    expect(result).not.toBeNull();
    expect(result!.extension.status).toBe('disabled');
    expect(result!.extension.bundleReady).toBe(false);
    expect(result!.extension.error).toBeUndefined();
    expect(result!.reloadRequired).toBe(true);
    expect(mockConfigSet).toHaveBeenCalledWith('extensions', {
      enabled: [],
    });
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-d'] });
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-f'] });
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-h'] });
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-i'] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'internalhash' });

    await manager.initialize(null);

    const publicList = manager.listPublic();

    expect(publicList).toHaveLength(1);
    const pub = publicList[0];
    expect(pub.id).toBe('ext-i');
    expect(pub.status).toBe('compiled');
    expect(pub.bundleReady).toBe(true);
    // These internal fields must NOT be present
    expect('path' in pub).toBe(false);
    expect('sourceHash' in pub).toBe(false);
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
    mockConfigGet.mockReturnValue({ enabled: ['ext-j'] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash' });

    await manager.initialize(null);

    await manager.enable('ext-j');

    // configSet should not have been called since the ID was already in the enabled list
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it('reads bundle for active extensions', async () => {
    const record = makeRecord('ext-k', { status: 'enabled' });
    mockConfigGet.mockReturnValue({ enabled: ['ext-k'] });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'activehash' });
    mockReadBundle.mockResolvedValue('active-bundle');

    await manager.initialize(null);
    manager.reportActivated('ext-k');

    const bundle = await manager.readBundle('ext-k');

    expect(bundle).toBe('active-bundle');
    expect(mockReadBundle).toHaveBeenCalledWith('ext-k', 'activehash');
  });
});
