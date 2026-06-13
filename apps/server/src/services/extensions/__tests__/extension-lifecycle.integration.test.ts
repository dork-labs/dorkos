/**
 * Integration test for the complete extension lifecycle.
 *
 * Exercises discovery, compilation (real esbuild), enable/disable,
 * reload, iteration, error handling, and scope handling on real filesystem.
 * No mocks — all operations hit temp directories with real I/O and esbuild.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { ExtensionCompiler } from '../extension-compiler.js';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { CoreExtensionInfo, ExtensionsConfig } from '../extension-enable-resolution.js';

/** No user overrides; no core extensions (everything resolves to origin 'user'). */
const EMPTY_CONFIG: ExtensionsConfig = { enabled: [], disabled: [] };
const EMPTY_CORE = new Map<string, CoreExtensionInfo>();

// Suppress noisy log output during integration tests
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Filesystem helpers ---

/** Write a valid extension.json manifest to a directory. */
async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2));
}

/** Write an index.ts source file to an extension directory. */
async function writeSource(dir: string, source: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'index.ts'), source);
}

/** Write a pre-compiled index.js file to an extension directory. */
async function writeJsSource(dir: string, source: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'index.js'), source);
}

// --- Test data ---

const VALID_TS_SOURCE = `
import type { ExtensionAPI } from '@dorkos/extension-api';

function HelloSection() {
  return null;
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('dashboard.sections', 'hello-section', HelloSection, { priority: 50 });
  api.registerCommand('greet', 'Say Hello', () => {});
}
`;

const VALID_JS_SOURCE = `
export function activate(api) {
  api.registerComponent('dashboard.sections', 'js-section', function JsSection() { return null; });
}
`;

const INVALID_TS_SOURCE = `
import { nonExistent } from './does-not-exist.js';
export function activate() { nonExistent(); }
`;

const UPDATED_TS_SOURCE = `
import type { ExtensionAPI } from '@dorkos/extension-api';

function UpdatedSection() {
  return null;
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('dashboard.sections', 'updated-section', UpdatedSection, { priority: 10 });
  api.registerComponent('sidebar.footer', 'footer-widget', UpdatedSection);
  api.registerCommand('updated-cmd', 'Updated Command', () => {});
}
`;

describe('Extension Lifecycle Integration', () => {
  let tmpDir: string;
  let dorkHome: string;
  let cwd: string;
  let globalExtDir: string;
  let localExtDir: string;
  let discovery: ExtensionDiscovery;
  let compiler: ExtensionCompiler;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-lifecycle-'));
    dorkHome = path.join(tmpDir, '.dork');
    cwd = path.join(tmpDir, 'project');
    globalExtDir = path.join(dorkHome, 'extensions');
    localExtDir = path.join(cwd, '.dork', 'extensions');

    await fs.mkdir(globalExtDir, { recursive: true });
    await fs.mkdir(localExtDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    discovery = new ExtensionDiscovery(dorkHome);
    compiler = new ExtensionCompiler(dorkHome);
  });

  // ================================================================
  // 1. Create: scaffold a TypeScript extension on disk and discover it
  // ================================================================

  it('discovers a newly created TypeScript extension in the global directory', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    await writeManifest(extDir, {
      id: 'hello-world',
      name: 'Hello World',
      version: '1.0.0',
      description: 'Integration test extension',
      contributions: { 'dashboard.sections': true },
    });
    await writeSource(extDir, VALID_TS_SOURCE);

    const records = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

    const helloWorld = records.find((r) => r.id === 'hello-world');
    expect(helloWorld).toBeDefined();
    expect(helloWorld!.scope).toBe('global');
    expect(helloWorld!.status).toBe('disabled');
    expect(helloWorld!.manifest.name).toBe('Hello World');
    expect(helloWorld!.manifest.version).toBe('1.0.0');
  });

  // ================================================================
  // 2. Compile: real esbuild compilation of the TypeScript extension
  // ================================================================

  it('compiles a TypeScript extension with real esbuild', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    const record: ExtensionRecord = {
      id: 'hello-world',
      manifest: { id: 'hello-world', name: 'Hello World', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const result = await compiler.compile(record);

    expect('code' in result).toBe(true);
    if ('code' in result) {
      expect(result.code).toContain('activate');
      expect(result.code).toContain('HelloSection');
      expect(result.sourceHash).toHaveLength(16);
    }
  });

  // ================================================================
  // 3. Cache hit: second compile returns cached bundle
  // ================================================================

  it('returns cached bundle on second compilation of unchanged source', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    const record: ExtensionRecord = {
      id: 'hello-world',
      manifest: { id: 'hello-world', name: 'Hello World', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const first = await compiler.compile(record);
    const second = await compiler.compile(record);

    expect('code' in first && 'code' in second).toBe(true);
    if ('code' in first && 'code' in second) {
      expect(second.sourceHash).toBe(first.sourceHash);
      expect(second.code).toBe(first.code);
    }
  });

  // ================================================================
  // 4. Read bundle: serve the compiled JS from cache
  // ================================================================

  it('reads the compiled bundle from cache after compilation', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    const record: ExtensionRecord = {
      id: 'hello-world',
      manifest: { id: 'hello-world', name: 'Hello World', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const compileResult = await compiler.compile(record);
    expect('code' in compileResult).toBe(true);

    if ('code' in compileResult) {
      const bundle = await compiler.readBundle('hello-world', compileResult.sourceHash);
      expect(bundle).toBe(compileResult.code);
    }
  });

  // ================================================================
  // 5. Enable/disable via discovery status
  // ================================================================

  it('marks extension as enabled when its ID is in the enabled list', async () => {
    const records = await discovery.discover(
      null,
      { enabled: ['hello-world'], disabled: [] },
      EMPTY_CORE
    );

    const helloWorld = records.find((r) => r.id === 'hello-world');
    expect(helloWorld).toBeDefined();
    expect(helloWorld!.status).toBe('enabled');
  });

  it('marks extension as disabled when its ID is not in the enabled list', async () => {
    const records = await discovery.discover(
      null,
      { enabled: ['some-other-ext'], disabled: [] },
      EMPTY_CORE
    );

    const helloWorld = records.find((r) => r.id === 'hello-world');
    expect(helloWorld).toBeDefined();
    expect(helloWorld!.status).toBe('disabled');
  });

  // ================================================================
  // 6. Test extension: compile + activate against MockExtensionAPI
  // ================================================================

  it('evaluates a compiled bundle via data URI import and activates it', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    const record: ExtensionRecord = {
      id: 'hello-world',
      manifest: { id: 'hello-world', name: 'Hello World', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const compileResult = await compiler.compile(record);
    expect('code' in compileResult).toBe(true);

    if ('code' in compileResult) {
      const bundle = await compiler.readBundle('hello-world', compileResult.sourceHash);
      expect(bundle).toBeTruthy();

      // Import the bundle via data URI (same mechanism as testExtension)
      const dataUri = `data:text/javascript;base64,${Buffer.from(bundle!).toString('base64')}`;
      const mod = await import(/* @vite-ignore */ dataUri);
      expect(typeof mod.activate).toBe('function');

      // Activate against a simple tracking API stub
      const registrations: Array<{ slot: string; id: string }> = [];
      const commands: Array<{ id: string; label: string }> = [];
      const stubApi = {
        id: 'hello-world',
        registerComponent(slot: string, id: string) {
          registrations.push({ slot, id });
          return () => {};
        },
        registerCommand(id: string, label: string) {
          commands.push({ id, label });
          return () => {};
        },
      };

      mod.activate(stubApi);

      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toEqual({
        slot: 'dashboard.sections',
        id: 'hello-section',
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toEqual({
        id: 'greet',
        label: 'Say Hello',
      });
    }
  });

  // ================================================================
  // 7. Iterate: update source, recompile, verify changed output
  // ================================================================

  it('recompiles with updated output when source changes', async () => {
    const extDir = path.join(globalExtDir, 'hello-world');
    const record: ExtensionRecord = {
      id: 'hello-world',
      manifest: { id: 'hello-world', name: 'Hello World', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    // Compile original
    const original = await compiler.compile(record);
    expect('code' in original).toBe(true);

    // Update the source
    await writeSource(extDir, UPDATED_TS_SOURCE);

    // Recompile
    const updated = await compiler.compile(record);
    expect('code' in updated).toBe(true);

    if ('code' in original && 'code' in updated) {
      // Hash must change because source content changed
      expect(updated.sourceHash).not.toBe(original.sourceHash);
      // New output should contain updated references
      expect(updated.code).toContain('UpdatedSection');
      expect(updated.code).toContain('updated-section');
    }
  });

  // ================================================================
  // 8. Error handling: compilation errors from invalid TypeScript
  // ================================================================

  it('returns structured compilation error for invalid TypeScript', async () => {
    const extDir = path.join(globalExtDir, 'broken-ext');
    await writeManifest(extDir, {
      id: 'broken-ext',
      name: 'Broken Extension',
      version: '0.1.0',
    });
    await writeSource(extDir, INVALID_TS_SOURCE);

    const record: ExtensionRecord = {
      id: 'broken-ext',
      manifest: { id: 'broken-ext', name: 'Broken Extension', version: '0.1.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const result = await compiler.compile(record);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('compilation_failed');
      expect(result.error.errors.length).toBeGreaterThan(0);
      expect(result.sourceHash).toHaveLength(16);
    }
  });

  it('caches compilation errors and returns them on subsequent compiles', async () => {
    const extDir = path.join(globalExtDir, 'broken-ext');
    const record: ExtensionRecord = {
      id: 'broken-ext',
      manifest: { id: 'broken-ext', name: 'Broken Extension', version: '0.1.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const first = await compiler.compile(record);
    const second = await compiler.compile(record);

    expect('error' in first && 'error' in second).toBe(true);
    if ('error' in first && 'error' in second) {
      expect(second.error.code).toBe(first.error.code);
      expect(second.sourceHash).toBe(first.sourceHash);
    }
  });

  it('recovers from compile error after source is fixed', async () => {
    const extDir = path.join(globalExtDir, 'broken-ext');
    const record: ExtensionRecord = {
      id: 'broken-ext',
      manifest: { id: 'broken-ext', name: 'Broken Extension', version: '0.1.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    // Confirm it is currently broken
    const broken = await compiler.compile(record);
    expect('error' in broken).toBe(true);

    // Fix the source
    const fixedSource = `export function activate(api: any) { api.registerCommand('fixed', 'Fixed', () => {}); }`;
    await writeSource(extDir, fixedSource);

    // Recompile — should succeed now
    const fixed = await compiler.compile(record);
    expect('code' in fixed).toBe(true);
    if ('code' in fixed) {
      expect(fixed.code).toContain('activate');
    }
  });

  // ================================================================
  // 9. Invalid manifest handling
  // ================================================================

  it('marks extension with invalid manifest as status "invalid"', async () => {
    const extDir = path.join(globalExtDir, 'bad-manifest');
    await fs.mkdir(extDir, { recursive: true });
    // Manifest missing required fields (no id, no version)
    await fs.writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify({ name: 'Bad Extension' })
    );

    const records = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);
    const bad = records.find((r) => r.id === 'bad-manifest');

    expect(bad).toBeDefined();
    expect(bad!.status).toBe('invalid');
    expect(bad!.error).toBeDefined();
    expect(bad!.error!.code).toBe('invalid_manifest');
  });

  it('marks directory with no extension.json as status "invalid"', async () => {
    const extDir = path.join(globalExtDir, 'no-manifest');
    await fs.mkdir(extDir, { recursive: true });
    // No extension.json written

    const records = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);
    const noManifest = records.find((r) => r.id === 'no-manifest');

    expect(noManifest).toBeDefined();
    expect(noManifest!.status).toBe('invalid');
    expect(noManifest!.error!.code).toBe('manifest_read_error');
  });

  // ================================================================
  // 10. Version incompatibility
  // ================================================================

  it('marks extension with future minHostVersion as incompatible', async () => {
    const extDir = path.join(globalExtDir, 'future-ext');
    await writeManifest(extDir, {
      id: 'future-ext',
      name: 'Future Extension',
      version: '1.0.0',
      minHostVersion: '99.0.0',
    });

    const records = await discovery.discover(
      null,
      { enabled: ['future-ext'], disabled: [] },
      EMPTY_CORE
    );
    const future = records.find((r) => r.id === 'future-ext');

    expect(future).toBeDefined();
    expect(future!.status).toBe('incompatible');
  });

  // ================================================================
  // 11. Scope handling: local vs global, local overrides global
  // ================================================================

  it('discovers local extensions in the project .dork/extensions/ directory', async () => {
    const extDir = path.join(localExtDir, 'local-only');
    await writeManifest(extDir, {
      id: 'local-only',
      name: 'Local Only Extension',
      version: '0.1.0',
    });
    await writeSource(extDir, `export function activate() {}`);

    const records = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);
    const local = records.find((r) => r.id === 'local-only');

    expect(local).toBeDefined();
    expect(local!.scope).toBe('local');
    expect(local!.status).toBe('disabled');
  });

  it('local extension overrides global extension with the same ID', async () => {
    // Create a global extension with a known ID
    const globalDir = path.join(globalExtDir, 'shared-ext');
    await writeManifest(globalDir, {
      id: 'shared-ext',
      name: 'Global Shared',
      version: '1.0.0',
    });
    await writeSource(globalDir, `export function activate() {}`);

    // Create a local extension with the same ID
    const localDir = path.join(localExtDir, 'shared-ext');
    await writeManifest(localDir, {
      id: 'shared-ext',
      name: 'Local Shared',
      version: '2.0.0',
    });
    await writeSource(localDir, `export function activate() {}`);

    const records = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);
    const shared = records.find((r) => r.id === 'shared-ext');

    expect(shared).toBeDefined();
    expect(shared!.scope).toBe('local');
    expect(shared!.manifest.name).toBe('Local Shared');
    expect(shared!.manifest.version).toBe('2.0.0');
  });

  it('compiles a local extension with real esbuild', async () => {
    const extDir = path.join(localExtDir, 'local-only');
    const record: ExtensionRecord = {
      id: 'local-only',
      manifest: { id: 'local-only', name: 'Local Only Extension', version: '0.1.0' },
      status: 'enabled',
      scope: 'local',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const result = await compiler.compile(record);
    expect('code' in result).toBe(true);
    if ('code' in result) {
      expect(result.code).toContain('activate');
    }
  });

  // ================================================================
  // 12. Pre-compiled JS extension handling
  // ================================================================

  it('handles pre-compiled JS extension without running esbuild', async () => {
    const extDir = path.join(globalExtDir, 'js-ext');
    await writeManifest(extDir, {
      id: 'js-ext',
      name: 'JS Extension',
      version: '1.0.0',
    });
    await writeJsSource(extDir, VALID_JS_SOURCE);

    const record: ExtensionRecord = {
      id: 'js-ext',
      manifest: { id: 'js-ext', name: 'JS Extension', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const result = await compiler.compile(record);
    expect('code' in result).toBe(true);
    if ('code' in result) {
      // Pre-compiled JS is stored as-is
      expect(result.code).toBe(VALID_JS_SOURCE);
    }
  });

  // ================================================================
  // 13. No entry point: extension directory exists but has no index
  // ================================================================

  it('returns error when extension has manifest but no index.ts or index.js', async () => {
    const extDir = path.join(globalExtDir, 'no-source');
    await writeManifest(extDir, {
      id: 'no-source',
      name: 'No Source',
      version: '1.0.0',
    });
    // No index.ts or index.js written

    const record: ExtensionRecord = {
      id: 'no-source',
      manifest: { id: 'no-source', name: 'No Source', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      path: extDir,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
    };

    const result = await compiler.compile(record);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.message).toContain('No entry point');
    }
  });

  // ================================================================
  // 14. Stale cache cleanup
  // ================================================================

  it('cleans stale cache entries older than 7 days', async () => {
    const cacheDir = path.join(dorkHome, 'cache', 'extensions');
    await fs.mkdir(cacheDir, { recursive: true });

    const stalePath = path.join(cacheDir, 'stale.abcdef1234567890.js');
    const freshPath = path.join(cacheDir, 'fresh.1234567890abcdef.js');
    await fs.writeFile(stalePath, 'stale bundle');
    await fs.writeFile(freshPath, 'fresh bundle');

    // Backdate the stale file
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(stalePath, eightDaysAgo, eightDaysAgo);

    const cleaned = await compiler.cleanStaleCache();

    expect(cleaned).toBe(1);
    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });

  // ================================================================
  // 15. Full round-trip: discover -> compile -> iterate -> rediscover
  // ================================================================

  it('performs a full round-trip: discover, compile, update, recompile', async () => {
    const extDir = path.join(globalExtDir, 'roundtrip-ext');
    await writeManifest(extDir, {
      id: 'roundtrip-ext',
      name: 'Roundtrip Extension',
      version: '1.0.0',
    });
    const v1Source = `export function activate(api: any) { api.registerCommand('v1', 'Version 1', () => {}); }`;
    await writeSource(extDir, v1Source);

    // Step 1: Discover
    const records1 = await discovery.discover(
      null,
      { enabled: ['roundtrip-ext'], disabled: [] },
      EMPTY_CORE
    );
    const ext1 = records1.find((r) => r.id === 'roundtrip-ext');
    expect(ext1).toBeDefined();
    expect(ext1!.status).toBe('enabled');

    // Step 2: Compile v1
    const compile1 = await compiler.compile(ext1!);
    expect('code' in compile1).toBe(true);
    if ('code' in compile1) {
      expect(compile1.code).toContain('Version 1');
    }

    // Step 3: Update source
    const v2Source = `export function activate(api: any) { api.registerCommand('v2', 'Version 2', () => {}); }`;
    await writeSource(extDir, v2Source);

    // Step 4: Recompile
    const compile2 = await compiler.compile(ext1!);
    expect('code' in compile2).toBe(true);
    if ('code' in compile2) {
      expect(compile2.code).toContain('Version 2');
      if ('code' in compile1) {
        expect(compile2.sourceHash).not.toBe(compile1.sourceHash);
      }
    }

    // Step 5: Rediscover — extension should still be there
    const records2 = await discovery.discover(
      null,
      { enabled: ['roundtrip-ext'], disabled: [] },
      EMPTY_CORE
    );
    const ext2 = records2.find((r) => r.id === 'roundtrip-ext');
    expect(ext2).toBeDefined();
    expect(ext2!.status).toBe('enabled');
  });

  // ================================================================
  // 16. Discovery with no extensions directory returns empty
  // ================================================================

  it('returns empty when scanning a non-existent dorkHome', async () => {
    const noHome = new ExtensionDiscovery(path.join(tmpDir, 'nonexistent'));
    const records = await noHome.discover(null, EMPTY_CONFIG, EMPTY_CORE);
    expect(records).toEqual([]);
  });

  // ================================================================
  // 17. Multiple extensions discovered in parallel
  // ================================================================

  it('discovers multiple extensions in a single scan', async () => {
    // Count only valid-manifest extensions we've created
    const records = await discovery.discover(cwd, EMPTY_CONFIG, EMPTY_CORE);
    const validRecords = records.filter((r) => r.status !== 'invalid');

    // We should have at least: hello-world, broken-ext (fixed), future-ext,
    // local-only, shared-ext (local), js-ext, no-source, roundtrip-ext
    expect(validRecords.length).toBeGreaterThanOrEqual(6);

    // Verify scope separation
    const globalExts = records.filter((r) => r.scope === 'global');
    const localExts = records.filter((r) => r.scope === 'local');
    expect(globalExts.length).toBeGreaterThan(0);
    expect(localExts.length).toBeGreaterThan(0);
  });
});
