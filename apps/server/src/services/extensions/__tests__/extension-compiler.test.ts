import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExtensionCompiler } from '../extension-compiler.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type { ExtensionRecord } from '@dorkos/extension-api';

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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
      expect(result.sourceHash).toHaveLength(16);
      expect(result.sourceHash).toBe(contentHash(source));
    }
  });

  // === 2. Pre-compiled JS ===

  it('serves pre-compiled JS directly without esbuild', async () => {
    const extDir = path.join(tmpDir, 'js-ext');
    await fs.mkdir(extDir, { recursive: true });
    const jsSource = 'export function activate(api) { console.log("pre-compiled"); }';
    await fs.writeFile(path.join(extDir, 'index.js'), jsSource);

    const result = await compiler.compile(makeRecord('js-ext', extDir));

    expect('code' in result).toBe(true);
    if ('code' in result) {
      expect(result.code).toBe(jsSource);
      expect(result.sourceHash).toBe(contentHash(jsSource));
    }
  });

  it('prefers index.js over index.ts when both exist', async () => {
    const extDir = path.join(tmpDir, 'both-ext');
    await fs.mkdir(extDir, { recursive: true });
    const jsSource = 'export function activate() { return "js"; }';
    const tsSource = 'export function activate(): string { return "ts"; }';
    await fs.writeFile(path.join(extDir, 'index.js'), jsSource);
    await fs.writeFile(path.join(extDir, 'index.ts'), tsSource);

    const result = await compiler.compile(makeRecord('both-ext', extDir));

    expect('code' in result).toBe(true);
    if ('code' in result) {
      // Should use the JS source directly, not the TS source
      expect(result.code).toBe(jsSource);
      expect(result.sourceHash).toBe(contentHash(jsSource));
    }
  });

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

  it('returns error when neither index.js nor index.ts exists', async () => {
    const extDir = path.join(tmpDir, 'empty-ext');
    await fs.mkdir(extDir, { recursive: true });

    const result = await compiler.compile(makeRecord('empty-ext', extDir));

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('compilation_failed');
      expect(result.error.message).toContain('No entry point');
      expect(result.sourceHash).toBe('');
    }
  });

  // === 4. Cache hit ===

  it('returns cached result on second compilation of same source', async () => {
    const extDir = path.join(tmpDir, 'cache-ext');
    await fs.mkdir(extDir, { recursive: true });
    const source = 'export function activate() { return 1; }';
    await fs.writeFile(path.join(extDir, 'index.ts'), source);

    const first = await compiler.compile(makeRecord('cache-ext', extDir));
    expect('code' in first).toBe(true);

    // Second call should hit cache
    const second = await compiler.compile(makeRecord('cache-ext', extDir));
    expect('code' in second).toBe(true);

    if ('code' in first && 'code' in second) {
      expect(second.code).toBe(first.code);
      expect(second.sourceHash).toBe(first.sourceHash);
    }
  });

  // === 5. Cache invalidation ===

  it('recompiles when source content changes', async () => {
    const extDir = path.join(tmpDir, 'invalidate-ext');
    await fs.mkdir(extDir, { recursive: true });
    const source1 = 'export function activate() { return "v1"; }';
    await fs.writeFile(path.join(extDir, 'index.ts'), source1);

    const first = await compiler.compile(makeRecord('invalidate-ext', extDir));
    expect('code' in first).toBe(true);

    // Change the source
    const source2 = 'export function activate() { return "v2"; }';
    await fs.writeFile(path.join(extDir, 'index.ts'), source2);

    const second = await compiler.compile(makeRecord('invalidate-ext', extDir));
    expect('code' in second).toBe(true);

    if ('code' in first && 'code' in second) {
      expect(second.sourceHash).not.toBe(first.sourceHash);
      expect(second.code).toContain('v2');
    }
  });

  // === 6. Compilation error ===

  it('returns structured error for invalid TypeScript', async () => {
    const extDir = path.join(tmpDir, 'bad-ext');
    await fs.mkdir(extDir, { recursive: true });
    // Invalid: importing a module that doesn't exist will cause a build error
    await fs.writeFile(
      path.join(extDir, 'index.ts'),
      'import { nonExistent } from "./does-not-exist.js";\nexport function activate() { nonExistent(); }'
    );

    const result = await compiler.compile(makeRecord('bad-ext', extDir));

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('compilation_failed');
      expect(result.error.errors.length).toBeGreaterThan(0);
      expect(result.sourceHash).toHaveLength(16);
    }
  });

  // === 7. Cached error ===

  it('returns cached error on second compilation of same failing source', async () => {
    const extDir = path.join(tmpDir, 'cached-err-ext');
    await fs.mkdir(extDir, { recursive: true });
    const badSource =
      'import { nonExistent } from "./missing.js";\nexport function activate() { nonExistent(); }';
    await fs.writeFile(path.join(extDir, 'index.ts'), badSource);

    const first = await compiler.compile(makeRecord('cached-err-ext', extDir));
    expect('error' in first).toBe(true);

    // Second call should return cached error
    const second = await compiler.compile(makeRecord('cached-err-ext', extDir));
    expect('error' in second).toBe(true);

    if ('error' in first && 'error' in second) {
      expect(second.error.code).toBe(first.error.code);
      expect(second.error.message).toBe(first.error.message);
      expect(second.sourceHash).toBe(first.sourceHash);
    }
  });

  // === 8. Bundle size warning ===

  it('logs warning when bundle exceeds 500KB', async () => {
    const { logger } = await import('../../../lib/logger.js');

    const extDir = path.join(tmpDir, 'large-ext');
    await fs.mkdir(extDir, { recursive: true });
    // Generate a large string constant to create a big bundle
    const largeString = 'x'.repeat(600 * 1024);
    const source = `export const big = "${largeString}";\nexport function activate() {}`;
    await fs.writeFile(path.join(extDir, 'index.ts'), source);

    const result = await compiler.compile(makeRecord('large-ext', extDir));

    expect('code' in result).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds 500KB guideline'));
  });

  // === 9. Stale cache cleanup ===

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

  it('returns 0 when cache directory does not exist', async () => {
    // Use a compiler pointing to a non-existent dorkHome
    const missingCompiler = new ExtensionCompiler(path.join(tmpDir, 'nonexistent'));
    const cleaned = await missingCompiler.cleanStaleCache();
    expect(cleaned).toBe(0);
  });

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

  it('externalizes react, react-dom, and @dorkos/extension-api', async () => {
    const extDir = path.join(tmpDir, 'external-ext');
    await fs.mkdir(extDir, { recursive: true });
    const source = [
      'import React from "react";',
      'import { createRoot } from "react-dom";',
      'import type { ExtensionAPI } from "@dorkos/extension-api";',
      'export function activate(api: ExtensionAPI) { return React.createElement("div"); }',
    ].join('\n');
    await fs.writeFile(path.join(extDir, 'index.ts'), source);

    const result = await compiler.compile(makeRecord('external-ext', extDir));

    expect('code' in result).toBe(true);
    if ('code' in result) {
      // External packages should appear as imports, not bundled inline
      expect(result.code).toContain('react');
      // The code should NOT contain React's internals (e.g., createElement implementation)
      // Instead it should reference externals
      expect(result.code).not.toContain('__SECRET_INTERNALS');
    }
  });

  // === readBundle ===

  it('reads a cached bundle by extension ID and source hash', async () => {
    const extDir = path.join(tmpDir, 'read-ext');
    await fs.mkdir(extDir, { recursive: true });
    const source = 'export function activate() { return "readable"; }';
    await fs.writeFile(path.join(extDir, 'index.ts'), source);

    const compileResult = await compiler.compile(makeRecord('read-ext', extDir));
    expect('code' in compileResult).toBe(true);

    if ('code' in compileResult) {
      const bundle = await compiler.readBundle('read-ext', compileResult.sourceHash);
      expect(bundle).toBe(compileResult.code);
    }
  });

  it('returns null for a non-existent bundle', async () => {
    const bundle = await compiler.readBundle('nonexistent', 'deadbeef12345678');
    expect(bundle).toBeNull();
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
        expect(result.sourceHash).toHaveLength(16);
        expect(result.sourceHash).toBe(contentHash(source));
      }
    });

    it('returns error when serverEntryPath is undefined', async () => {
      const extDir = path.join(tmpDir, 'no-server-ext');
      await fs.mkdir(extDir, { recursive: true });

      const record = makeRecord('no-server-ext', extDir);
      const result = await compiler.compileServer(record);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.code).toBe('compilation_failed');
        expect(result.error.message).toContain('No server entry point');
        expect(result.sourceHash).toBe('');
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

    it('returns cached result on second compilation of same source', async () => {
      const extDir = path.join(tmpDir, 'server-cache-ext');
      await fs.mkdir(extDir, { recursive: true });
      const source = 'export default function register() { return 1; }';
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, source);

      const record = makeServerRecord('server-cache-ext', extDir, serverPath);
      const first = await compiler.compileServer(record);
      expect('code' in first).toBe(true);

      const second = await compiler.compileServer(record);
      expect('code' in second).toBe(true);

      if ('code' in first && 'code' in second) {
        expect(second.code).toBe(first.code);
        expect(second.sourceHash).toBe(first.sourceHash);
      }
    });

    it('recompiles when server source content changes', async () => {
      const extDir = path.join(tmpDir, 'server-invalidate-ext');
      await fs.mkdir(extDir, { recursive: true });
      const serverPath = path.join(extDir, 'server.ts');

      await fs.writeFile(serverPath, 'export default function register() { return "v1"; }');
      const record = makeServerRecord('server-invalidate-ext', extDir, serverPath);
      const first = await compiler.compileServer(record);
      expect('code' in first).toBe(true);

      await fs.writeFile(serverPath, 'export default function register() { return "v2"; }');
      const second = await compiler.compileServer(record);
      expect('code' in second).toBe(true);

      if ('code' in first && 'code' in second) {
        expect(second.sourceHash).not.toBe(first.sourceHash);
        expect(second.code).toContain('v2');
      }
    });

    it('caches server bundles in server/ subdirectory, isolated from client', async () => {
      const extDir = path.join(tmpDir, 'isolation-ext');
      await fs.mkdir(extDir, { recursive: true });

      // Create client entry
      const clientSource = 'export function activate() { return "client"; }';
      await fs.writeFile(path.join(extDir, 'index.ts'), clientSource);

      // Create server entry
      const serverSource = 'export default function register() { return "server"; }';
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, serverSource);

      // Compile both
      const clientResult = await compiler.compile(makeRecord('isolation-ext', extDir));
      const serverRecord = makeServerRecord('isolation-ext', extDir, serverPath);
      const serverResult = await compiler.compileServer(serverRecord);

      expect('code' in clientResult).toBe(true);
      expect('code' in serverResult).toBe(true);

      // Verify server cache lives in server/ subdirectory
      const serverCacheDir = path.join(tmpDir, 'cache', 'extensions', 'server');
      const serverEntries = await fs.readdir(serverCacheDir);
      expect(serverEntries.some((e) => e.startsWith('isolation-ext.'))).toBe(true);

      // Verify client cache lives in root cache dir (not server/)
      const clientCacheDir = path.join(tmpDir, 'cache', 'extensions');
      const clientEntries = (await fs.readdir(clientCacheDir)).filter(
        (e) => !e.startsWith('.') && e !== 'server'
      );
      expect(clientEntries.some((e) => e.startsWith('isolation-ext.'))).toBe(true);
    });

    it('does not include browser polyfills in server output', async () => {
      const extDir = path.join(tmpDir, 'node-target-ext');
      await fs.mkdir(extDir, { recursive: true });
      // Use a Node.js-only API to verify the platform target is node
      const source =
        'import path from "path";\nexport default function register() { return path.join("a", "b"); }';
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, source);

      const record = makeServerRecord('node-target-ext', extDir, serverPath);
      const result = await compiler.compileServer(record);

      expect('code' in result).toBe(true);
      if ('code' in result) {
        // Node platform should use require("path"), not bundle a polyfill
        expect(result.code).toContain('require("path")');
      }
    });

    it('externalizes express and extension-api packages', async () => {
      const extDir = path.join(tmpDir, 'server-external-ext');
      await fs.mkdir(extDir, { recursive: true });
      // Use value imports (not type-only) so esbuild preserves them
      const source = [
        'import express from "express";',
        'import api from "@dorkos/extension-api";',
        'import serverApi from "@dorkos/extension-api/server";',
        'export default function register() { return [express, api, serverApi]; }',
      ].join('\n');
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, source);

      const record = makeServerRecord('server-external-ext', extDir, serverPath);
      const result = await compiler.compileServer(record);

      expect('code' in result).toBe(true);
      if ('code' in result) {
        // Externalized packages should appear as require() calls, not inlined
        expect(result.code).toContain('require("express")');
        expect(result.code).toContain('require("@dorkos/extension-api")');
        expect(result.code).toContain('require("@dorkos/extension-api/server")');
      }
    });
  });

  // === cleanStaleCache with server/ subdirectory ===

  it('cleans stale entries in both client and server cache directories', async () => {
    const cacheDir = path.join(tmpDir, 'cache', 'extensions');
    const serverCacheDir = path.join(cacheDir, 'server');
    await fs.mkdir(serverCacheDir, { recursive: true });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    // Create stale files in both directories
    const staleClient = path.join(cacheDir, 'stale-client.abc123.js');
    const staleServer = path.join(serverCacheDir, 'stale-server.abc123.js');
    const freshServer = path.join(serverCacheDir, 'fresh-server.def456.js');
    await fs.writeFile(staleClient, 'stale client');
    await fs.writeFile(staleServer, 'stale server');
    await fs.writeFile(freshServer, 'fresh server');

    await fs.utimes(staleClient, eightDaysAgo, eightDaysAgo);
    await fs.utimes(staleServer, eightDaysAgo, eightDaysAgo);

    const cleaned = await compiler.cleanStaleCache();

    expect(cleaned).toBe(2);
    await expect(fs.access(staleClient)).rejects.toThrow();
    await expect(fs.access(staleServer)).rejects.toThrow();
    await expect(fs.access(freshServer)).resolves.toBeUndefined();
  });
});
