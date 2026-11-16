/**
 * Compile `checkbox-crash-worker.ts` once per test file, so every crash test
 * forks plain `node` on JavaScript instead of `node --import tsx` on source.
 *
 * Forking with `--import tsx` sends the worker's whole import graph (~1,000
 * modules) through tsx's loader on every fork: 6-10 s per child on a loaded
 * machine, past Vitest's 10 s hook budget at worst. One esbuild bundle costs
 * under a second and each fork then boots in ~1.5 s.
 *
 * What the child runs is unchanged: the same worker over the same production
 * modules, taken from source, not from `dist`. Two things keep the bundle
 * behaving as the source does:
 *
 * - **Paths stay where they were.** Every workspace module's `import.meta.url`
 *   is replaced with that module's own original file URL before it is
 *   compiled, so code that finds files next to itself (`@dorkos/db`'s
 *   migrations folder, the server's `package.json`) finds the same files.
 * - **npm packages are not bundled.** Each is left as an import of the exact
 *   file Node would load, resolved from the importing module's own location
 *   with Node's conditions (`node`, `import`; `main`, never `module`), so
 *   native modules such as `better-sqlite3` load as they always do.
 *
 * @module server/services/canvas/doc-channel/writes/__tests__/checkbox-crash-worker-bundle
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';

/** The compiled worker and a way to remove it. */
export interface CrashWorkerBundle {
  /** Absolute path of the compiled worker, for `fork(path, args, { execArgv: [] })`. */
  path: string;
  /** Delete the bundle's temporary folder. */
  dispose(): Promise<void>;
}

const WORKER_SOURCE = fileURLToPath(new URL('./checkbox-crash-worker.ts', import.meta.url));

/** Bundle workspace source; leave every npm package to Node, at its resolved file. */
const sourceOnly: Plugin = {
  name: 'checkbox-crash-worker-source-only',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === 'inner' || args.path.startsWith('@dorkos/')) return undefined;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      const resolved = await b.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        importer: args.importer,
        pluginData: 'inner',
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: pathToFileURL(resolved.path).href, external: true };
    });
    b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await readFile(args.path, 'utf8');
      const loader = args.path.endsWith('.tsx')
        ? 'tsx'
        : /\.[cm]?ts$/.test(args.path)
          ? 'ts'
          : 'js';
      return {
        contents: source.replaceAll(
          'import.meta.url',
          JSON.stringify(pathToFileURL(args.path).href)
        ),
        loader,
      };
    });
  },
};

/** Compile the crash worker into a fresh temporary folder. */
export async function buildCrashWorkerBundle(): Promise<CrashWorkerBundle> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dorkos-checkbox-crash-worker-'));
  const outfile = path.join(dir, 'checkbox-crash-worker.mjs');
  try {
    await build({
      entryPoints: [WORKER_SOURCE],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      mainFields: ['main'],
      conditions: ['node'],
      logLevel: 'error',
      plugins: [sourceOnly],
    });
  } catch (cause) {
    await rm(dir, { recursive: true, force: true });
    throw cause;
  }
  return { path: outfile, dispose: () => rm(dir, { recursive: true, force: true }) };
}
