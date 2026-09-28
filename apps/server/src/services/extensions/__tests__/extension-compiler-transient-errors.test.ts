/**
 * Regression coverage for the environment-vs-genuine compile error split
 * (DOR trace: a one-time "@esbuild/darwin-arm64 could not be found" failure
 * during a file-descriptor exhaustion event got cached to disk and replayed
 * on every subsequent server start, permanently disabling the extension
 * even after esbuild started working again).
 *
 * These tests mock esbuild's `build()` directly so each failure mode is
 * reproduced deterministically:
 *  - A plain `Error` with no `errors` array (what esbuild throws when it
 *    can't even start — a missing native binary, a spawn failure, an
 *    `EMFILE`) must never be cached.
 *  - A `BuildFailure`-shaped error with a populated `errors` array (what
 *    esbuild throws for a real syntax/resolution problem in the source)
 *    must still be cached and replayed, so a genuinely broken extension
 *    does not recompile on every boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { build } from 'esbuild';
import type { BuildResult } from 'esbuild';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionCompiler } from '../extension-compiler.js';

vi.mock('esbuild', () => ({
  build: vi.fn(),
  version: '0.0.0-test',
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockBuild = vi.mocked(build);

/** Create a minimal ExtensionRecord pointing at the given directory. */
function makeRecord(id: string, extDir: string): ExtensionRecord {
  return {
    id,
    path: extDir,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
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

/** The exact message esbuild throws when the platform-specific native binary is missing. */
const MISSING_BINARY_MESSAGE =
  'The package "@esbuild/darwin-arm64" could not be found, and is needed by esbuild.';

/** What esbuild's `build()` rejects with when it never got far enough to evaluate source. */
function environmentError(message = MISSING_BINARY_MESSAGE): Error {
  return new Error(message);
}

/** What esbuild's `build()` rejects with for a genuine syntax/resolution error. */
function genuineBuildFailure(text: string): Error {
  return Object.assign(new Error(`Build failed with 1 error:\n${text}`), {
    errors: [{ text, location: { file: 'index.ts', line: 1, column: 0 } }],
    warnings: [],
  });
}

/**
 * What esbuild's `build()` rejects with when its own binary can't READ a
 * file because of the local environment — a `BuildFailure` with a
 * POPULATED `errors[]`, the same shape a genuine compile error has. This
 * is the exact shape the classifier missed before it also checked message
 * text: an unreadable entry point carries `location: null` (nothing to
 * point at); an unreadable file the entry point *imports* carries a real
 * `location` pointing at the `import` statement. Both are reproduced for
 * real (no mock) in `extension-compiler-real-esbuild.test.ts`.
 */
function esbuildIoFailure(
  text: string,
  location: { file: string; line: number; column: number } | null = null
): Error {
  return Object.assign(new Error(`Build failed with 1 error:\n${text}`), {
    errors: [{ text, location }],
    warnings: [],
  });
}

/** What esbuild's `build()` resolves with on a successful compile (`write: false`). */
function buildSuccess(text: string): BuildResult {
  return {
    errors: [],
    warnings: [],
    outputFiles: [{ path: '', contents: new TextEncoder().encode(text), hash: '', text }],
    metafile: undefined,
    mangleCache: undefined,
  };
}

/**
 * Assert the compiler recorded no build of `extId` in `cacheDir`: an
 * uncached failure leaves no manifest behind to replay.
 */
async function expectNothingCached(cacheDir: string, extId: string): Promise<void> {
  const entries = await fs.readdir(cacheDir).catch(() => [] as string[]);
  expect(entries.filter((e) => e.startsWith(`${extId}.`) && e.endsWith('.manifest.json'))).toEqual(
    []
  );
}

describe('ExtensionCompiler — environment vs. genuine compile errors', () => {
  let tmpDir: string;
  let compiler: ExtensionCompiler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-compiler-transient-'));
    compiler = new ExtensionCompiler(tmpDir);
    mockBuild.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('client-side compile()', () => {
    it('does not cache an environment failure (missing native binary)', async () => {
      const extDir = path.join(tmpDir, 'env-fail-ext');
      await fs.mkdir(extDir, { recursive: true });
      await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() {}');

      mockBuild.mockRejectedValue(environmentError());

      const result = await compiler.compile(makeRecord('env-fail-ext', extDir));
      expect('error' in result).toBe(true);

      // Nothing was written to the cache.
      await expectNothingCached(path.join(tmpDir, 'cache', 'extensions'), 'env-fail-ext');

      // A second attempt retries esbuild instead of replaying a cached error.
      await compiler.compile(makeRecord('env-fail-ext', extDir));
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('recovers automatically once the environment failure clears', async () => {
      const extDir = path.join(tmpDir, 'env-recover-ext');
      await fs.mkdir(extDir, { recursive: true });
      const source = 'export function activate() { return "ok"; }';
      await fs.writeFile(path.join(extDir, 'index.ts'), source);

      mockBuild.mockRejectedValueOnce(environmentError());
      const first = await compiler.compile(makeRecord('env-recover-ext', extDir));
      expect('error' in first).toBe(true);

      mockBuild.mockResolvedValueOnce(buildSuccess(source));
      const second = await compiler.compile(makeRecord('env-recover-ext', extDir));

      expect('code' in second).toBe(true);
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('does not cache an esbuild read failure with no location (unreadable entry point)', async () => {
      const extDir = path.join(tmpDir, 'io-fail-no-location-ext');
      await fs.mkdir(extDir, { recursive: true });
      await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() {}');

      mockBuild.mockRejectedValue(
        esbuildIoFailure('Cannot read file "index.ts": permission denied', null)
      );

      const result = await compiler.compile(makeRecord('io-fail-no-location-ext', extDir));
      expect('error' in result).toBe(true);
      await expectNothingCached(
        path.join(tmpDir, 'cache', 'extensions'),
        'io-fail-no-location-ext'
      );

      await compiler.compile(makeRecord('io-fail-no-location-ext', extDir));
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('does not cache an esbuild read failure WITH a location (unreadable import)', async () => {
      // The regression this guards: a populated errors[] entry that DOES
      // carry a location (esbuild points at the `import` statement that
      // referenced the unreadable file) must still be recognized as an
      // environment failure by its text, not dismissed because it has a
      // location a genuine compile error would also have.
      const extDir = path.join(tmpDir, 'io-fail-with-location-ext');
      await fs.mkdir(extDir, { recursive: true });
      await fs.writeFile(path.join(extDir, 'index.ts'), 'import "./helper.js";');

      mockBuild.mockRejectedValue(
        esbuildIoFailure('Cannot read file "helper.ts": permission denied', {
          file: 'index.ts',
          line: 1,
          column: 7,
        })
      );

      const result = await compiler.compile(makeRecord('io-fail-with-location-ext', extDir));
      expect('error' in result).toBe(true);
      await expectNothingCached(
        path.join(tmpDir, 'cache', 'extensions'),
        'io-fail-with-location-ext'
      );

      await compiler.compile(makeRecord('io-fail-with-location-ext', extDir));
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('still caches a genuine compile error and replays it without recompiling', async () => {
      const extDir = path.join(tmpDir, 'genuine-fail-ext');
      await fs.mkdir(extDir, { recursive: true });
      await fs.writeFile(path.join(extDir, 'index.ts'), 'this is not valid typescript {{{');

      mockBuild.mockRejectedValue(genuineBuildFailure('Unexpected token'));

      const first = await compiler.compile(makeRecord('genuine-fail-ext', extDir));
      expect('error' in first).toBe(true);
      if (!('error' in first)) throw new Error('expected error result');

      const cached = await fs.readdir(path.join(tmpDir, 'cache', 'extensions'));
      expect(cached.some((e) => e.endsWith('.manifest.json'))).toBe(true);

      const second = await compiler.compile(makeRecord('genuine-fail-ext', extDir));
      expect('error' in second).toBe(true);
      if ('error' in second) {
        expect(second.error.message).toBe(first.error.message);
      }

      // esbuild was invoked exactly once — the second call was served from cache.
      expect(mockBuild).toHaveBeenCalledTimes(1);
    });
  });

  describe('server-side compileServer()', () => {
    it('does not cache an environment failure (missing native binary)', async () => {
      const extDir = path.join(tmpDir, 'server-env-fail-ext');
      await fs.mkdir(extDir, { recursive: true });
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, 'export default function register() {}');

      mockBuild.mockRejectedValue(environmentError());

      const record = makeServerRecord('server-env-fail-ext', extDir, serverPath);
      const result = await compiler.compileServer(record);
      expect('error' in result).toBe(true);

      await expectNothingCached(
        path.join(tmpDir, 'cache', 'extensions', 'server'),
        'server-env-fail-ext'
      );

      await compiler.compileServer(record);
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('still caches a genuine server compile error and replays it without recompiling', async () => {
      const extDir = path.join(tmpDir, 'server-genuine-fail-ext');
      await fs.mkdir(extDir, { recursive: true });
      const serverPath = path.join(extDir, 'server.ts');
      await fs.writeFile(serverPath, 'this is not valid typescript {{{');

      mockBuild.mockRejectedValue(genuineBuildFailure('Unexpected token'));

      const record = makeServerRecord('server-genuine-fail-ext', extDir, serverPath);
      const first = await compiler.compileServer(record);
      expect('error' in first).toBe(true);

      const second = await compiler.compileServer(record);
      expect('error' in second).toBe(true);

      expect(mockBuild).toHaveBeenCalledTimes(1);
    });
  });
});
