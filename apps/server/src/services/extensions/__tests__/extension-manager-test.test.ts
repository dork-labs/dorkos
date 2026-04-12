import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManager } from '../extension-manager.js';
import { MockExtensionAPI } from '../extension-test-harness.js';

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
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  };
}

// --- MockExtensionAPI tests ---

describe('MockExtensionAPI', () => {
  it('tracks registerComponent calls per slot', () => {
    const api = new MockExtensionAPI('test-ext');

    api.registerComponent('dashboard.sections', 'card-1', () => null);
    api.registerComponent('dashboard.sections', 'card-2', () => null);
    api.registerComponent('sidebar.footer', 'footer-1', () => null);

    const contributions = api.getContributions();
    expect(contributions['dashboard.sections']).toBe(2);
    expect(contributions['sidebar.footer']).toBe(1);
    expect(contributions['header.actions']).toBe(0);
  });

  it('tracks registerCommand calls under command-palette.items', () => {
    const api = new MockExtensionAPI('test-ext');

    api.registerCommand('cmd-1', 'Command One', () => {});
    api.registerCommand('cmd-2', 'Command Two', () => {});

    const contributions = api.getContributions();
    expect(contributions['command-palette.items']).toBe(2);
  });

  it('tracks registerDialog calls under dialog slot', () => {
    const api = new MockExtensionAPI('test-ext');

    const handle = api.registerDialog('dlg-1', () => null);

    const contributions = api.getContributions();
    expect(contributions['dialog']).toBe(1);
    expect(typeof handle.open).toBe('function');
    expect(typeof handle.close).toBe('function');
  });

  it('tracks registerSettingsTab calls under settings.tabs slot', () => {
    const api = new MockExtensionAPI('test-ext');

    api.registerSettingsTab('tab-1', 'My Tab', () => null);

    const contributions = api.getContributions();
    expect(contributions['settings.tabs']).toBe(1);
  });

  it('returns zero counts for all 8 slots when nothing is registered', () => {
    const api = new MockExtensionAPI('test-ext');

    const contributions = api.getContributions();

    expect(Object.keys(contributions)).toHaveLength(8);
    for (const count of Object.values(contributions)) {
      expect(count).toBe(0);
    }
  });

  it('returns all known slot IDs in getContributions', () => {
    const api = new MockExtensionAPI('test-ext');

    const contributions = api.getContributions();

    expect(contributions).toHaveProperty('dashboard.sections');
    expect(contributions).toHaveProperty('command-palette.items');
    expect(contributions).toHaveProperty('settings.tabs');
    expect(contributions).toHaveProperty('sidebar.footer');
    expect(contributions).toHaveProperty('sidebar.tabs');
    expect(contributions).toHaveProperty('header.actions');
    expect(contributions).toHaveProperty('dialog');
    expect(contributions).toHaveProperty('right-panel');
  });

  it('exposes the extension id as a readonly property', () => {
    const api = new MockExtensionAPI('my-ext');
    expect(api.id).toBe('my-ext');
  });

  it('implements getState with all-null values', () => {
    const api = new MockExtensionAPI('test-ext');
    const state = api.getState();

    expect(state.currentCwd).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.agentId).toBeNull();
  });

  it('implements subscribe as a no-op returning cleanup', () => {
    const api = new MockExtensionAPI('test-ext');
    const unsub = api.subscribe();
    expect(typeof unsub).toBe('function');
  });

  it('implements loadData returning null', async () => {
    const api = new MockExtensionAPI('test-ext');
    const data = await api.loadData();
    expect(data).toBeNull();
  });

  it('implements saveData as a no-op', async () => {
    const api = new MockExtensionAPI('test-ext');
    await expect(api.saveData()).resolves.toBeUndefined();
  });

  it('implements isSlotAvailable returning true', () => {
    const api = new MockExtensionAPI('test-ext');
    expect(api.isSlotAvailable()).toBe(true);
  });

  it('registerComponent returns a cleanup function', () => {
    const api = new MockExtensionAPI('test-ext');
    const unsub = api.registerComponent('header.actions', 'btn', () => null);
    expect(typeof unsub).toBe('function');
  });
});

// --- testExtension() method tests ---

describe('ExtensionManager.testExtension', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigGet.mockReturnValue({ enabled: [] });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
  });

  it('throws when extension ID is not found', async () => {
    await manager.initialize(null);

    await expect(manager.testExtension('nonexistent')).rejects.toThrow(
      "Extension 'nonexistent' not found"
    );
  });

  it('returns compilation errors when compilation fails', async () => {
    const record = makeRecord('broken-ext', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({
      error: {
        code: 'compilation_failed',
        message: 'Syntax error in broken-ext',
        errors: [{ text: 'Unexpected token', location: { file: 'index.ts', line: 5, column: 3 } }],
      },
      sourceHash: 'badhash',
    });

    await manager.initialize(null);

    const result = await manager.testExtension('broken-ext');

    expect(result.status).toBe('error');
    expect(result.id).toBe('broken-ext');
    expect(result.phase).toBe('compilation');
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].text).toBe('Unexpected token');
    expect(result.errors![0].location).toEqual({ file: 'index.ts', line: 5, column: 3 });
  });

  it('returns error when compiled bundle is not found in cache', async () => {
    const record = makeRecord('cache-miss', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash123' });
    mockReadBundle.mockResolvedValue(null);

    await manager.initialize(null);

    const result = await manager.testExtension('cache-miss');

    expect(result.status).toBe('error');
    expect(result.id).toBe('cache-miss');
    expect(result.phase).toBe('compilation');
    expect(result.error).toBe('Compiled bundle not found in cache');
  });

  it('returns activation error when activate() throws', async () => {
    const record = makeRecord('throw-ext', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash456' });

    // Bundle that throws during activate
    const bundle = `
      export function activate(api) {
        throw new Error('Activation kaboom');
      }
    `;
    mockReadBundle.mockResolvedValue(bundle);

    await manager.initialize(null);

    const result = await manager.testExtension('throw-ext');

    expect(result.status).toBe('error');
    expect(result.id).toBe('throw-ext');
    expect(result.phase).toBe('activation');
    expect(result.error).toContain('Activation kaboom');
    expect(result.stack).toBeDefined();
  });

  it('returns activation error when module has no activate() export', async () => {
    const record = makeRecord('no-activate', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash789' });

    // Bundle with no activate export
    const bundle = `export const name = 'No activate here';`;
    mockReadBundle.mockResolvedValue(bundle);

    await manager.initialize(null);

    const result = await manager.testExtension('no-activate');

    expect(result.status).toBe('error');
    expect(result.id).toBe('no-activate');
    expect(result.phase).toBe('activation');
    expect(result.error).toBe('Extension does not export an activate() function');
  });

  it('returns contribution counts for valid extension', async () => {
    const record = makeRecord('good-ext', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'goodhash' });

    // Bundle that registers components
    const bundle = `
      export function activate(api) {
        api.registerComponent('dashboard.sections', 'card-1', function() {});
        api.registerCommand('say-hello', 'Say Hello', function() {});
        api.registerSettingsTab('prefs', 'Preferences', function() {});
      }
    `;
    mockReadBundle.mockResolvedValue(bundle);

    await manager.initialize(null);

    const result = await manager.testExtension('good-ext');

    expect(result.status).toBe('ok');
    expect(result.id).toBe('good-ext');
    expect(result.contributions).toBeDefined();
    expect(result.contributions!['dashboard.sections']).toBe(1);
    expect(result.contributions!['command-palette.items']).toBe(1);
    expect(result.contributions!['settings.tabs']).toBe(1);
    expect(result.contributions!['sidebar.footer']).toBe(0);
    expect(result.contributions!['dialog']).toBe(0);
    expect(result.message).toContain('3 contribution(s)');
  });

  it('returns zero contributions when activate registers nothing', async () => {
    const record = makeRecord('empty-ext', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'emptyhash' });

    const bundle = `export function activate(api) { /* no-op */ }`;
    mockReadBundle.mockResolvedValue(bundle);

    await manager.initialize(null);

    const result = await manager.testExtension('empty-ext');

    expect(result.status).toBe('ok');
    expect(result.id).toBe('empty-ext');
    expect(result.contributions).toBeDefined();
    for (const count of Object.values(result.contributions!)) {
      expect(count).toBe(0);
    }
    expect(result.message).toContain('0 contribution(s)');
  });
});
