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
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return {
      discover: mockDiscover,
    };
  }),
}));

const mockCompile = vi.fn();
const mockReadBundle = vi.fn();
const mockCleanStaleCache = vi.fn().mockResolvedValue(0);
vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: mockCompile,
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

/** A recorded yes to full access in these places (DOR-4282). */
function inProcessWith(slots: string[]) {
  return { runtime: 'in-process' as const, net: [], run: [], agents: false, slots };
}

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
    currentDigest: FIXTURE_DIGEST,
    ...overrides,
  };
}

// --- MockExtensionAPI tests ---

describe('MockExtensionAPI', () => {
  it("refuses registerComponent('dialog') like the real host: not counted, and warned", () => {
    const api = new MockExtensionAPI('test-ext');

    api.registerComponent('dialog', 'dlg-1', () => null);

    expect(api.getContributions()['dialog']).toBe(0);
    expect(api.warnings).toEqual([expect.stringContaining('use registerDialog')]);
  });
});

// --- testExtension() method tests ---

describe('ExtensionManager.testExtension', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Every extension this block uses is pre-approved to run, because these tests
    // are about the compile-and-activate mechanics AFTER a person said yes. The
    // gate itself (DOR-516) is covered separately in `extension-load-policy.test.ts`
    // and by the refusal test at the bottom of this block — approving here would
    // otherwise make the gate the only thing any of these assert.
    mockConfigGet.mockReturnValue({
      enabled: [],
      disabled: [],
      ...approved([
        'broken-ext',
        'cache-miss',
        'throw-ext',
        'no-activate',
        'good-ext',
        'loose-ext',
        'empty-ext',
      ]),
      // The places each yes was given for (DOR-4282). Without a recorded set,
      // an approval covers only a panel tab and a Settings page, so a manifest
      // declaring any other place is refused before activate() ever runs.
      approvedPermissions: {
        'good-ext': inProcessWith(['command-palette.items', 'dashboard.sections', 'settings.tabs']),
        'loose-ext': inProcessWith(['pages']),
      },
    });
    mockDiscover.mockResolvedValue([]);
    manager = new ExtensionManager('/fake/dork-home');
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

  it('returns activation error when activate() throws', async () => {
    const record = makeRecord('throw-ext', { status: 'disabled' });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'hash456' });

    // Bundle that throws during activate
    const bundle = `
      var __dorkosExtension = { activate(api) {
        throw new Error('Activation kaboom');
      } };
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

  it('returns contribution counts for valid extension', async () => {
    const record = makeRecord('good-ext', {
      status: 'disabled',
      manifest: {
        id: 'good-ext',
        name: 'good-ext',
        version: '1.0.0',
        contributions: {
          'dashboard.sections': true,
          'command-palette.items': true,
          'settings.tabs': true,
        },
      },
    });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'goodhash' });

    // Bundle that registers components
    const bundle = `
      var __dorkosExtension = { activate(api) {
        api.registerComponent('dashboard.sections', 'card-1', function() {});
        api.registerCommand('say-hello', 'Say Hello', function() {});
        api.registerSettingsTab('prefs', 'Preferences', function() {});
      } };
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

  it('counts only declared places, and warns for the rest and for the canvas (DOR-4282)', async () => {
    const record = makeRecord('loose-ext', {
      status: 'disabled',
      manifest: {
        id: 'loose-ext',
        name: 'loose-ext',
        version: '1.0.0',
        contributions: { pages: true },
      },
    });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'loosehash' });
    mockReadBundle.mockResolvedValue(`
      var __dorkosExtension = { activate(api) {
        api.registerPage('', function() {}, { title: 'Home' });
        api.registerCommand('go', 'Go', function() {});
        api.openCanvas({ type: 'markdown', content: '# Hi' });
      } };
    `);

    await manager.initialize(null);
    const result = await manager.testExtension('loose-ext');

    expect(result.status).toBe('ok');
    expect(result.contributions!['pages']).toBe(1);
    expect(result.contributions!['command-palette.items']).toBe(0);
    expect(result.message).toContain('1 contribution(s)');
    expect(result.warnings).toEqual([
      expect.stringContaining('command-palette.items adds nothing'),
      expect.stringContaining('canvas adds nothing'),
    ]);
  });

  // Purpose: new places alone never stop the app (DOR-4282, option C): each
  // waits on its own, and the rest of it runs as before.
  it('keeps going when the only thing its approval does not cover is a new place (DOR-4282)', async () => {
    // Approved before places were recorded: covers a panel tab and a Settings page only.
    const record = makeRecord('throw-ext', {
      manifest: {
        id: 'throw-ext',
        name: 'throw-ext',
        version: '1.0.0',
        contributions: { pages: true },
      },
    });
    mockDiscover.mockResolvedValue([record]);
    mockCompile.mockResolvedValue({ code: 'code', sourceHash: 'pagehash' });
    mockReadBundle.mockResolvedValue('var __dorkosExtension = { activate() {} };');

    await manager.initialize(null);
    const result = await manager.testExtension('throw-ext');

    expect(result.phase).not.toBe('approval');
    expect(mockCompile).toHaveBeenCalled();
  });
});
