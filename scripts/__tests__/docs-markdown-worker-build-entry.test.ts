/**
 * The live docs markdown worker ships with every build that ships the server
 * (DOR-2984).
 *
 * The server starts `docs-markdown-worker.mjs` from beside its own bundle as a
 * worker thread (`services/docs/collab/worker-entry.ts`). A build that forgot
 * it would ship a server whose live docs all fail to open, and nothing else in
 * CI would notice until a person opened one. A full build is too slow for this
 * suite, so these are static assertions on the build scripts and packaging,
 * plus a real bundle of the worker run the way the builds' smoke step runs it:
 *
 * - both the CLI and the desktop server builds bundle the worker entry to
 *   `server/docs-markdown-worker.mjs`, as ESM, and smoke-test the result
 *   (the desktop build through `build-side-bundles.ts`);
 * - that file name is the one the server looks for;
 * - the desktop app unpacks it from `app.asar`;
 * - a bundle made with the builds' options runs in a worker thread and
 *   round-trips a doc.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MARKDOWN_WORKER_BANNER,
  MARKDOWN_WORKER_FILE,
  MARKDOWN_WORKER_SOURCE,
} from '../../apps/server/src/services/docs/collab/worker-build.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = MARKDOWN_WORKER_SOURCE;
const OUTFILE = `server/${MARKDOWN_WORKER_FILE}`;
const SMOKE = 'scripts/smoke-docs-markdown-worker.mjs';

/** Read a repo file. */
function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * The text of the esbuild `build({...})` call whose entry is the worker.
 *
 * @param source - A build script.
 */
function workerBuildCall(source: string): string | null {
  const at = source.indexOf('MARKDOWN_WORKER_SOURCE)');
  if (at === -1) return null;
  const start = source.lastIndexOf('await build(', at);
  const end = source.indexOf('});', at);
  return start === -1 || end === -1 ? null : source.slice(start, end);
}

/** The slice of esbuild's API this test uses (the root has no esbuild types of its own). */
interface EsbuildApi {
  build(options: Record<string, unknown>): Promise<{
    warnings: unknown[];
    metafile?: { outputs: Record<string, { imports: { path: string; external?: boolean }[] }> };
  }>;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'markdown-worker-build-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('docs markdown worker build entry', () => {
  // Purpose: each production build bundles the worker to the right file, as
  // one self-contained ES module, and smoke-tests what it emitted.
  it.each([['packages/cli/scripts/build.ts'], ['apps/desktop/scripts/build-side-bundles.ts']])(
    '%s bundles and smoke-tests the worker',
    (script) => {
      const source = read(script);
      const call = workerBuildCall(source);
      expect(call, `${script} has no build() for ${ENTRY}`).not.toBeNull();
      const region = source.slice(
        Math.max(0, source.indexOf(call!) - 400),
        source.indexOf(call!) + call!.length + 600
      );
      expect(region).toMatch(/'server', MARKDOWN_WORKER_FILE\)/);
      expect(region).toContain(SMOKE);
      expect(call).toContain('banner: { js: MARKDOWN_WORKER_BANNER }');
      expect(call).toMatch(/format:\s*'esm'/);
      expect(call).toMatch(/bundle:\s*true/);
      expect(call).toMatch(/platform:\s*'node'/);
    }
  );

  // Purpose: the desktop server build actually runs its worker step.
  it('runs in the desktop server build', () => {
    expect(read('apps/desktop/scripts/build-server.ts')).toMatch(/await buildSideBundles\(/);
  });

  // Purpose: every build reads the name, entry and banner from one module,
  // and that name is the one the server looks for.
  it('builds from the one shared description of the worker', () => {
    const shared = read('apps/server/src/services/docs/collab/worker-build.ts');
    expect(shared.match(/export const MARKDOWN_WORKER_FILE = '([^']+)'/)?.[1]).toBe(
      path.basename(OUTFILE)
    );
    expect(shared).toContain(`'${ENTRY}'`);
    for (const script of [
      'packages/cli/scripts/build.ts',
      'apps/desktop/scripts/build-side-bundles.ts',
    ]) {
      const source = read(script);
      expect(source).toContain('MARKDOWN_WORKER_BANNER');
      expect(source).toContain('MARKDOWN_WORKER_FILE');
    }
    expect(read('apps/server/src/services/docs/collab/worker-entry.ts')).toContain(
      './worker-build.js'
    );
  });

  // Purpose: the desktop app ships the worker as a real file.
  it('is unpacked from app.asar', () => {
    const config = read('apps/desktop/electron-builder.yml');
    expect(config).toMatch(/asarUnpack:[\s\S]*- 'dist\/server\/docs-markdown-worker\.mjs'/);
  });

  // Purpose: a bundle made the way the builds make it actually runs: Blintz
  // loads in a Node worker thread with nothing external but Node itself.
  it('bundles into a worker that round-trips a doc', async () => {
    // The repo root has no esbuild of its own; the server's is the one the builds use.
    const esbuildPath = createRequire(path.join(ROOT, 'apps/server/package.json')).resolve(
      'esbuild'
    );
    const { build } = (await import(pathToFileURL(esbuildPath).href)) as EsbuildApi;
    const outfile = path.join(scratch, MARKDOWN_WORKER_FILE);
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: [path.join(ROOT, ENTRY)],
      bundle: true,
      platform: 'node',
      target: 'node22.22',
      format: 'esm',
      outfile,
      banner: { js: MARKDOWN_WORKER_BANNER },
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.warnings).toEqual([]);
    const externals = Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .filter((dependency) => dependency.external)
      .map((dependency) => dependency.path);
    expect(externals.every((name) => name.startsWith('node:'))).toBe(true);
    const output = execFileSync(process.execPath, [path.join(ROOT, SMOKE), outfile], {
      encoding: 'utf8',
    });
    expect(output).toContain('round-trips a doc');
  }, 60_000);
});
