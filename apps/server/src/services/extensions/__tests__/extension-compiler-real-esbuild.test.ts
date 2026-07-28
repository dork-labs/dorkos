/**
 * Integration coverage that exercises the REAL filesystem and REAL esbuild
 * binary — no mock — for three variants of the same underlying defect: an
 * environment-level failure to READ a file OR DIRECTORY must degrade an
 * extension for this attempt, not throw uncaught and not get cached as a
 * permanent compile error.
 *
 * These tests probe esbuild's actual read-failure surface directly (real
 * `chmod`, real `build()`) rather than only encoding the classifier's own
 * model of it — a suite that only ever constructs the shapes the
 * classifier already expects cannot catch the classifier being wrong about
 * what esbuild actually does, which is exactly how the directory case
 * below survived an earlier round of this fix.
 *
 * 1. `compile()`/`compileServer()` read the entry point themselves via
 *    plain `fs.readFile`, to compute the content hash a cache entry would
 *    be keyed by — BEFORE esbuild ever runs. An unreadable entry point
 *    (`chmod 000`) fails HERE. This used to be unguarded: the rejection
 *    propagated uncaught through `compile()`/`compileServer()`, then
 *    through `ExtensionServerLifecycle.initialize()` and
 *    `ExtensionManager.initialize()`'s per-extension loop — a transient
 *    permission or file-descriptor error on ONE extension's entry point
 *    could abort startup for every extension queued after it.
 * 2. Once past that read, esbuild's own binary reads the entry point again
 *    (and everything it imports) while bundling. An unreadable file the
 *    entry point *imports* fails HERE instead, inside `build()`, and
 *    rejects with a `BuildFailure` carrying a POPULATED `errors[]` — the
 *    same *shape* a genuine compile error has, distinguished only by
 *    esbuild's own "Cannot read file ...: permission denied" prose (see
 *    `ESBUILD_IO_FAILURE_PATTERNS` in `extension-compiler.ts`).
 * 3. esbuild also reads the entry point's CONTAINING DIRECTORY before
 *    reading the entry point itself — confirmed here with a ZERO-import
 *    entry point, so there is nothing else the failure could be attributed
 *    to. Specifically this fixture (`chmod 0111`) exercises `loadAsFile`'s
 *    directory listing, one of two separate directory reads in esbuild's
 *    resolver (see `ESBUILD_IO_FAILURE_PATTERNS` in `extension-compiler.ts`
 *    for the other, which swallows exactly this permission case and so
 *    isn't reachable this way) — real `EMFILE`/`ENOSPC` would hit both.
 *    Either way, a directory read happens before any file read, making it
 *    at least as likely a manifestation of real resource exhaustion as the
 *    file-level cases above, not a rarer one.
 *
 * `chmod 000`/`chmod 0111` do not block root from reading (root can
 * override a file's permission bits on POSIX), so this suite is skipped
 * when running as root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionCompiler } from '../extension-compiler.js';
import type { ExtensionRecord } from '@dorkos/extension-api';

/** True when this process can bypass a `chmod 000` file permission (root on POSIX). */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Create an ExtensionRecord with a server entry point. */
function makeServerRecord(id: string, extDir: string, serverEntryPath: string): ExtensionRecord {
  return {
    id,
    path: extDir,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
    serverEntryPath,
  };
}

describe.skipIf(isRoot)('ExtensionCompiler — real filesystem, unreadable files', () => {
  let tmpDir: string;
  let compiler: ExtensionCompiler;
  /** Paths this test suite chmod 000'd, restored in afterEach before rm. */
  let unreadablePaths: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-compiler-real-esbuild-'));
    compiler = new ExtensionCompiler(tmpDir);
    unreadablePaths = [];
  });

  afterEach(async () => {
    await Promise.all(unreadablePaths.map((p) => fs.chmod(p, 0o644).catch(() => {})));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does not cache or crash on an unreadable entry point (fails before esbuild runs)', async () => {
    const serverPath = path.join(tmpDir, 'server.ts');
    await fs.writeFile(serverPath, 'export default function register() {}');
    await fs.chmod(serverPath, 0o000);
    unreadablePaths.push(serverPath);

    const record = makeServerRecord('unreadable-entry-ext', tmpDir, serverPath);

    // The bug this guards: this used to reject uncaught (a plain Node
    // EACCES from fs.readFile, never reaching any of the compiler's own
    // error handling) instead of resolving to a structured error result.
    const result = await compiler.compileServer(record);

    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error result');
    expect(result.error.errors[0]?.text).toMatch(/EACCES|permission denied/);
    // No source was ever read, so there is no content hash to cache
    // against — this failure is uncacheable by construction.
    expect(result.sourceHash).toBe('');

    // Nothing under the server cache dir claims this extension id.
    const serverCacheDir = path.join(tmpDir, 'cache', 'extensions', 'server');
    const cachedEntries = await fs.readdir(serverCacheDir).catch(() => []);
    expect(cachedEntries.some((e) => e.startsWith('unreadable-entry-ext.'))).toBe(false);

    // Restore readability (simulating the environment recovering) and
    // confirm the next attempt succeeds instead of repeating a crash.
    await fs.chmod(serverPath, 0o644);
    const second = await compiler.compileServer(record);
    expect('code' in second).toBe(true);
  });

  it('does not cache esbuild failing to read an imported file as a permanent compile error', async () => {
    const serverPath = path.join(tmpDir, 'server.ts');
    const depPath = path.join(tmpDir, 'helper.ts');
    await fs.writeFile(
      serverPath,
      'import { helper } from "./helper.js";\nexport default function register() { return helper(); }'
    );
    await fs.writeFile(depPath, 'export function helper() { return 1; }');
    await fs.chmod(depPath, 0o000);
    unreadablePaths.push(depPath);

    const record = makeServerRecord('unreadable-import-ext', tmpDir, serverPath);
    const result = await compiler.compileServer(record);

    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error result');

    // esbuild's real rejection for this case: a populated errors[] whose
    // text is its own "Cannot read file ...: permission denied" prose.
    // Confirms the fixture actually reaches esbuild's own read failure,
    // not some other error (e.g. a resolution failure with different text).
    expect(result.error.errors[0]?.text).toMatch(/Cannot read file .*: permission denied/);

    const cachedErrorPath = path.join(
      tmpDir,
      'cache',
      'extensions',
      'server',
      `unreadable-import-ext.${result.sourceHash}.error.json`
    );
    await expect(fs.access(cachedErrorPath)).rejects.toThrow();

    // Restore readability (simulating the environment recovering) and
    // confirm the next attempt succeeds instead of replaying a cached error.
    await fs.chmod(depPath, 0o644);
    const second = await compiler.compileServer(record);
    expect('code' in second).toBe(true);
  });

  it('does not cache esbuild failing to read the entry point directory as a permanent compile error', async () => {
    // A zero-import entry point isolates the failure to the directory read
    // itself — there is nothing else (an import, a second file) it could
    // be attributed to.
    const extDir = path.join(tmpDir, 'proj');
    await fs.mkdir(extDir, { recursive: true });
    const serverPath = path.join(extDir, 'server.ts');
    await fs.writeFile(serverPath, 'export default function register() {}');

    // Execute-only: the directory can still be TRAVERSED into by a known
    // filename (Node's own fs.readFile of server.ts needs no more than
    // that, so it stays unaffected — this test is only about esbuild's
    // OWN directory read), but it cannot be LISTED. esbuild's resolver
    // reads the directory listing while checking whether the entry point
    // exists as a file (`loadAsFile`, called before opening it) — that is
    // what this specific permission denies; a real EMFILE would also hit
    // the resolver's separate, longer-lived directory-info cache read,
    // which this fixture does not reach (it swallows EACCES/EPERM).
    await fs.chmod(extDir, 0o111);

    const record = makeServerRecord('unreadable-dir-ext', extDir, serverPath);
    let result: Awaited<ReturnType<typeof compiler.compileServer>>;
    try {
      result = await compiler.compileServer(record);
    } finally {
      // Restore write+execute before anything (including afterEach's own
      // cleanup) needs to modify this directory's contents.
      await fs.chmod(extDir, 0o755);
    }

    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error result');

    // esbuild's real rejection for this case: a populated, two-entry
    // errors[] — "Cannot read directory ...: permission denied" alongside
    // a "Could not resolve" for the entry point itself. Confirms the
    // fixture actually reaches esbuild's directory-read failure.
    expect(
      result.error.errors.some((e) => /Cannot read directory .*: permission denied/.test(e.text))
    ).toBe(true);

    const cachedErrorPath = path.join(
      tmpDir,
      'cache',
      'extensions',
      'server',
      `unreadable-dir-ext.${result.sourceHash}.error.json`
    );
    await expect(fs.access(cachedErrorPath)).rejects.toThrow();

    // Directory readable again — confirm the next attempt succeeds instead
    // of replaying a cached error.
    const second = await compiler.compileServer(record);
    expect('code' in second).toBe(true);
  });
});
