/**
 * Integration coverage that exercises the REAL esbuild binary — no mock —
 * for the failure mode the mocked suite in
 * `extension-compiler-transient-errors.test.ts` could not reach: esbuild
 * failing to READ a file because of the local environment (permission
 * denied, exhausted file descriptors, a full disk, ...) rejects with a
 * POPULATED `errors[]` carrying esbuild's own I/O-failure prose ("Cannot
 * read file ...: permission denied") — the same *shape* `errors[]` has for
 * a genuine compile error. A classifier that only checks for an
 * empty/missing `errors` array (an earlier version of this fix did exactly
 * that) caches it as if the extension's own source were broken.
 *
 * The entry point here stays readable and only an IMPORTED file is made
 * unreadable (`chmod 000`). That is deliberate, not incidental: the
 * compiler reads the entry point itself via plain `fs.readFile` (to hash
 * it) before esbuild ever runs, so making the entry point itself
 * unreadable fails at that earlier, unrelated read — before reaching any
 * code this test is meant to exercise. Failing on an imported file instead
 * isolates the failure to esbuild's own read, inside `build()`, which is
 * the exact path {@link isEnvironmentFailure} classifies. It also proves
 * the fix handles both of esbuild's real shapes for this failure: this
 * case's rejection carries a `location` (pointing at the `import`
 * statement) where the direct-entry-point case carries `null` — verified
 * independently against esbuild 0.25.12 before writing this test; see
 * `ESBUILD_IO_FAILURE_PATTERNS` in `extension-compiler.ts`.
 *
 * `chmod 000` does not block root from reading (root can override a file's
 * permission bits on POSIX), so this suite is skipped when running as root.
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

describe.skipIf(isRoot)('ExtensionCompiler — real esbuild, unreadable file mid-bundle', () => {
  let tmpDir: string;
  let compiler: ExtensionCompiler;
  let depPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-compiler-real-esbuild-'));
    compiler = new ExtensionCompiler(tmpDir);
    depPath = path.join(tmpDir, 'helper.ts');
  });

  afterEach(async () => {
    // The dependency is chmod 000'd inside the test; restore permissions
    // before rm so cleanup itself doesn't hit EACCES.
    await fs.chmod(depPath, 0o644).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does not cache esbuild failing to read an imported file as a permanent compile error', async () => {
    const serverPath = path.join(tmpDir, 'server.ts');
    await fs.writeFile(
      serverPath,
      'import { helper } from "./helper.js";\nexport default function register() { return helper(); }'
    );
    await fs.writeFile(depPath, 'export function helper() { return 1; }');
    await fs.chmod(depPath, 0o000);

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
});
