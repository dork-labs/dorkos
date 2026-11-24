/**
 * Shared setup for the extension-load-policy suites: everything the original file declared or
 * registered outside its tests.
 */
import { it, beforeEach, vi } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';

// Stand in for loading the compiled server entry, evaluating whatever
// the lifecycle "wrote" to its temp file — the same rig as
// `extension-manager-server.test.ts`, so a mounted router here means the real
// load path ran end to end rather than being stubbed past.
const { lastWrittenCodeRef } = vi.hoisted(() => ({ lastWrittenCodeRef: { value: '' } }));

vi.mock('../../server-bundle/load-in-process.js', () => ({
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

export const mockDiscover = vi.fn<() => Promise<ExtensionRecord[]>>();

vi.mock('../../extension-discovery.js', () => ({
  ExtensionDiscovery: vi.fn().mockImplementation(function () {
    return { discover: mockDiscover };
  }),
}));

export const mockCompile = vi.fn();

export const mockCompileServer = vi.fn();

export const mockReadBundle = vi.fn();

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

/** The digest every folder reads as, unless a test changes it (an edit). */
export const D1 = `sha256:${'1'.repeat(64)}`;

export const D2 = `sha256:${'2'.repeat(64)}`;

export const folderDigest = vi.hoisted(() => ({ value: `sha256:${'1'.repeat(64)}` }));

vi.mock('../../../marketplace/lib/install-digest.js', () => ({
  installFolderDigest: async () => ({ kind: 'digest', digest: folderDigest.value }),
  forgetFolderDigest: () => {},
}));

// The snapshot a pinned yes runs from: named by its digest, never written here.
vi.mock('../../pin/extension-snapshots.js', () => ({
  ensureSnapshot: async (_home: string, _root: string, digest: string) =>
    `/fake/dork-home/extension-snapshots/${digest.slice(7, 15)}`,
  collectSnapshots: async () => [],
  snapshotRootOf: (_home: string, digest: string) =>
    `/fake/dork-home/extension-snapshots/${digest.slice(7, 15)}`,
}));

/** The stored `extensions` config the gate reads, mutable per test. */
/** The `extensions` config shape these tests store; `approvedSources` may predate DOR-2383. */
export interface StoredExtensions {
  enabled: string[];
  disabled: string[];
  approvedToRun: string[];
  legacyUnsourced?: string[];
  approvedSources?: Record<
    string,
    { path: string; plugin?: string; digest?: string; grants?: string; pinnedOnFirstUse?: string }
  >;
  roomAccess?: Record<string, string[]>;
  forwardAgents?: Record<string, string[]>;
}

export const stored = vi.hoisted(() => ({
  value: { enabled: [], disabled: [], approvedToRun: [] } as StoredExtensions,
}));

// `set` WRITES THROUGH to the same object `get` reads. A mock that only records
// the call would let `approveToRun` look like it worked while the gate kept
// reading the old list — the test would pass and the feature would not.
export const mockConfigSet = vi.fn((key: string, value: unknown) => {
  if (key === 'extensions') stored.value = value as typeof stored.value;
});

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: () => stored.value,
    set: (...args: [string, unknown]) => mockConfigSet(...args),
  },
}));

export const mockMkdir = vi.fn().mockResolvedValue(undefined);

export const mockWriteFile = vi.fn().mockImplementation(async (path: string, content: string) => {
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
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  },
}));

// Every folder reads as the approved files unless a test edits them.
beforeEach(() => {
  folderDigest.value = D1;
});

export function makeRecord(id: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    // Installed directly under the manager's dorkHome, so an id-only approval in
    // `stored` binds to it on the first discovery (DOR-2383).
    path: `/fake/dork-home/extensions/${id}`,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    // What discovery reads from the folder (DOR-3068).
    currentDigest: folderDigest.value,
    ...overrides,
  };
}

/** A bundle whose `activate()` would be observable if it were ever evaluated. */
export const OBSERVABLE_BUNDLE =
  'var __dorkosExtension = { activate(api) { api.registerCommand("x", "X", () => {}); } };';
