import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExtensionCompiler } from '../extension-compiler.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type { ExtensionRecord } from '@dorkos/extension-api';

/** True when this process can bypass a `chmod` file permission (root on POSIX). */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Create a minimal ExtensionRecord pointing at the given directory. */
function makeRecord(id: string, extDir: string): ExtensionRecord {
  return {
    id,
    path: extDir,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
  };
}

/** Create an ExtensionRecord with a server entry point. */
function makeServerRecord(id: string, extDir: string, serverEntryPath: string): ExtensionRecord {
  return {
    ...makeRecord(id, extDir),
    hasServerEntry: true,
    serverEntryPath,
  };
}

/** Compute the same content hash the compiler uses internally. */
function contentHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

describe('ExtensionCompiler', () => {
  let tmpDir: string;
  let compiler: ExtensionCompiler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-compiler-'));
    compiler = new ExtensionCompiler(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // === 1. Compile TypeScript ===

  it('compiles a TypeScript extension', async () => {
    const extDir = path.join(tmpDir, 'test-ext');
    await fs.mkdir(extDir, { recursive: true });
    const source = 'export function activate(api: any) { console.log("hello"); }';
    await fs.writeFile(path.join(extDir, 'index.ts'), source);

    const result = await compiler.compile(makeRecord('test-ext', extDir));

    expect('code' in result).toBe(true);
    if ('code' in result) {
      expect(result.code).toContain('activate');
      // The key is the bundle's own content hash, so it changes exactly
      // when the served code does.
      expect(result.sourceHash).toBe(contentHash(result.code));
    }
  });

  // === 2. Pre-compiled JS ===

  it.skipIf(isRoot)(
    'reports an error, not a silent success, when a pre-compiled bundle cannot be cached',
    async () => {
      // Regression coverage: unlike TypeScript compilation, a pre-compiled
      // extension's disk cache IS the delivery mechanism — compile()'s
      // in-memory `code` is discarded by applyCompileResult, and the
      // bundle is served later, from disk, by readBundle(). A version of
      // this method used to swallow a write failure and report success
      // anyway, which left the extension looking healthy
      // (compiled/bundleReady) while readBundle() returned null forever.
      const extDir = path.join(tmpDir, 'uncacheable-js-ext');
      await fs.mkdir(extDir, { recursive: true });
      const jsSource = 'export function activate() {}';
      await fs.writeFile(path.join(extDir, 'index.js'), jsSource);

      // Pre-create the cache dir read-only: ensureCacheDir's mkdir
      // succeeds trivially (the dir already exists), but the write that
      // actually persists the bundle fails.
      const cacheDir = path.join(tmpDir, 'cache', 'extensions');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.chmod(cacheDir, 0o555);

      let result: Awaited<ReturnType<typeof compiler.compile>>;
      try {
        result = await compiler.compile(makeRecord('uncacheable-js-ext', extDir));
      } finally {
        await fs.chmod(cacheDir, 0o755);
      }

      expect('error' in result).toBe(true);
      if (!('error' in result)) throw new Error('expected error result');
      expect(result.error.message).toContain('cache the pre-compiled bundle');

      // Consistent with the error: there is nothing to read back either.
      const bundle = await compiler.readBundle('uncacheable-js-ext', result.sourceHash);
      expect(bundle).toBeNull();
    }
  );

  // === 3. No entry point ===

  // === 4. Cache hit ===

  // === 5. Cache invalidation ===

  // === 6. Compilation error ===

  it('removes cache entries older than 7 days', async () => {
    const cacheDir = path.join(tmpDir, 'cache', 'extensions');
    await fs.mkdir(cacheDir, { recursive: true });

    // Create a stale file and a fresh file
    const stalePath = path.join(cacheDir, 'stale-ext.abc123.js');
    const freshPath = path.join(cacheDir, 'fresh-ext.def456.js');
    await fs.writeFile(stalePath, 'stale content');
    await fs.writeFile(freshPath, 'fresh content');

    // Backdate the stale file's access time to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(stalePath, eightDaysAgo, eightDaysAgo);

    const cleaned = await compiler.cleanStaleCache();

    expect(cleaned).toBe(1);

    // Stale file should be gone
    await expect(fs.access(stalePath)).rejects.toThrow();
    // Fresh file should remain
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });

  // === 9. Stale cache cleanup ===

  it.skipIf(isRoot)(
    'does not throw when a cache subdirectory cannot be read (EACCES, not missing)',
    async () => {
      // Regression coverage: a bare `fs.readdir` outside any try/catch used
      // to run first thing in `cleanStaleCache()` — called before discovery
      // even starts in `ExtensionManager.initialize()` — so a transient
      // EMFILE/EACCES there (as opposed to the directory simply not
      // existing yet, the case the old code's `fs.access` pre-check
      // handled) took the entire extension system down for that boot.
      const cacheDir = path.join(tmpDir, 'cache', 'extensions');
      await fs.mkdir(cacheDir, { recursive: true });
      // Write-and-execute only: the directory exists (unlike the "does not
      // exist" case above) but cannot be LISTED.
      await fs.chmod(cacheDir, 0o333);

      try {
        await expect(compiler.cleanStaleCache()).resolves.toBe(0);
      } finally {
        await fs.chmod(cacheDir, 0o755);
      }
    }
  );

  // === 10. External packages ===

  // === readBundle ===

  it('never serves a cached bundle swapped after it was built, and builds it again (DOR-3068)', async () => {
    const extDir = path.join(tmpDir, 'swap-ext');
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() { return 1; }');
    const first = await compiler.compile(makeRecord('swap-ext', extDir));
    if (!('code' in first)) throw new Error('expected a build');
    const cached = path.join(tmpDir, 'cache', 'extensions', `swap-ext.${first.sourceHash}.js`);

    await fs.writeFile(cached, 'export function activate() { fetch("/steal"); }');
    expect(await compiler.readBundle('swap-ext', first.sourceHash)).toBeNull();

    const again = await compiler.compile(makeRecord('swap-ext', extDir));
    if (!('code' in again)) throw new Error('expected a build');
    expect(again.code).not.toContain('/steal');
    expect(await compiler.readBundle('swap-ext', again.sourceHash)).toBe(again.code);
  });

  it('ignores a build record swapped into the cache, and builds again (DOR-3068)', async () => {
    const extDir = path.join(tmpDir, 'record-ext');
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() { return 2; }');
    const first = await compiler.compile(makeRecord('record-ext', extDir));
    if (!('code' in first)) throw new Error('expected a build');

    const cacheDir = path.join(tmpDir, 'cache', 'extensions');
    const manifest = (await fs.readdir(cacheDir)).find(
      (name) => name.startsWith('record-ext.') && name.endsWith('.manifest.json')
    )!;
    const recorded = JSON.parse(await fs.readFile(path.join(cacheDir, manifest), 'utf8'));
    // A planted record claiming the build failed: a person would see an error,
    // or a planted bundle key would be served, were it believed.
    recorded.outcome = {
      kind: 'error',
      error: { code: 'compilation_failed', message: 'planted', errors: [] },
    };
    await fs.writeFile(path.join(cacheDir, manifest), JSON.stringify(recorded));

    const again = await compiler.compile(makeRecord('record-ext', extDir));
    expect('code' in again && again.code).toBe(first.code);
  });

  it('serves nothing it did not write itself, even at a matching name', async () => {
    const extDir = path.join(tmpDir, 'planted-ext');
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(path.join(extDir, 'index.js'), 'export function activate() {}');
    const result = await compiler.compile(makeRecord('planted-ext', extDir));
    if (!('code' in result)) throw new Error('expected a build');
    // A fresh compiler is a server restart: the file on disk is only a name.
    expect(
      await new ExtensionCompiler(tmpDir).readBundle('planted-ext', result.sourceHash)
    ).toBeNull();
  });

  // === compileServer ===

  describe('compileServer', () => {
    it('compiles a valid server.ts to CJS', async () => {
      const extDir = path.join(tmpDir, 'server-ext');
      await fs.mkdir(extDir, { recursive: true });
      const source =
        'export default function register(router: any) { router.get("/test", () => {}); }';
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, source);

      const record = makeServerRecord('server-ext', extDir, serverPath);
      const result = await compiler.compileServer(record);

      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toContain('register');
        // CJS format uses module.exports or exports
        expect(result.code).toContain('module.exports');
        expect(result.sourceHash).toBe(contentHash(result.code));
      }
    });

    it('returns structured error for invalid server TypeScript', async () => {
      const extDir = path.join(tmpDir, 'bad-server-ext');
      await fs.mkdir(extDir, { recursive: true });
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(
        serverPath,
        'import { nonExistent } from "./missing.js";\nexport default function register() { nonExistent(); }'
      );

      const record = makeServerRecord('bad-server-ext', extDir, serverPath);
      const result = await compiler.compileServer(record);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.code).toBe('compilation_failed');
        expect(result.error.errors.length).toBeGreaterThan(0);
        expect(result.sourceHash).toHaveLength(16);
      }
    });
  });

  // === cleanStaleCache with server/ subdirectory ===
});
