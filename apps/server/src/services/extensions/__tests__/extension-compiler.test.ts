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

/** Create a minimal ExtensionRecord pointing at the given directory. */
function makeRecord(id: string, extDir: string): ExtensionRecord {
  return {
    id,
    path: extDir,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    bundleReady: false,
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
});
