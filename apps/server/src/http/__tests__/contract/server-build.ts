/**
 * The composed server, built once per test run for the contract harness (DOR-4190).
 *
 * Booting `tsx src/index.ts` costs most of its time in loading ~3,000 modules
 * one by one through tsx's hooks, not in the server itself: measured at
 * 11–45 s a boot on a loaded machine, against 3.5–4 s for this build. The
 * harness boots ~35 servers a run, so it builds once and boots plain `node`.
 *
 * The build has to be the same server, not a production build of it, so it
 * keeps what `tsx` gives each module and changes only how they are loaded:
 *
 * - **Every module keeps its own location.** `import.meta.url`, `.filename` and
 *   `.dirname` are replaced, per file, with that file's real source location,
 *   as tsx itself does when it transforms a file. Every path worked out from
 *   them (the package version, the core extensions, the extension child's
 *   bootstrap source, `createRequire`) is therefore the path tsx would give.
 * - **Every package is the one tsx would load.** Anything that resolves into
 *   `node_modules` stays external, imported by the absolute path esbuild
 *   resolved from the importing file's own folder, so pnpm's per-package
 *   resolution, native addons and module identity are unchanged. The
 *   workspace packages are bundled from the file their `exports` map gives
 *   Node (`default`, so `dist/`, or `src/` where that is what they export),
 *   which is the file tsx loads too.
 * - **The transform is tsx's**: the same esbuild, a `node<current>` target,
 *   `keepNames`, the server's TypeScript settings and source maps.
 * - **One file per entry, no code splitting.** Splitting reorders the
 *   evaluation of modules that import each other, and a cycle in the config
 *   schemas then reads a binding before it is set; one file keeps ES module
 *   evaluation order.
 *
 * `process.argv[1]` is set to the source entry before the server runs, as tsx
 * leaves it, for the code that asks which file started the process.
 *
 * @module http/__tests__/contract/server-build
 */
import { build, transform, type Plugin } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `apps/server`. */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The entries the harness boots, as source paths, each built to its own file.
 * An entry not listed here is booted with tsx, as before.
 */
export const BUILT_ENTRIES: Readonly<Record<string, string>> = {
  index: path.join(SERVER_DIR, 'src/index.ts'),
  'task-runtime-server': path.join(
    SERVER_DIR,
    'src/http/__tests__/contract/fixtures/task-runtime-server.ts'
  ),
};

/** What tsx targets: the running Node. */
const TARGET = `node${process.versions.node}`;

/** The server's compiler settings that change emitted code (`@dorkos/typescript-config/base.json`). */
const TSCONFIG_RAW = { compilerOptions: { target: 'ES2022' } } as const;

/** Marks the plugin's own nested resolve, so it does not resolve itself. */
const NESTED = Symbol('nested-resolve');

/**
 * Keep third-party packages external at the path Node would resolve them to
 * from the importing file, and give every bundled module its own
 * `import.meta`.
 */
function sameModulesPlugin(): Plugin {
  return {
    name: 'contract-same-modules',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === NESTED || args.path.startsWith('node:')) return undefined;
        if (path.isAbsolute(args.path)) return undefined;
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          with: args.with,
          pluginData: NESTED,
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        if (resolved.external) return resolved;
        if (resolved.path.split(path.sep).includes('node_modules')) {
          return { path: resolved.path, external: true };
        }
        return resolved;
      });

      pluginBuild.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        if (!source.includes('import.meta')) return undefined;
        const loader = /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js';
        const result = await transform(source, {
          loader,
          format: 'esm',
          target: TARGET,
          sourcefile: args.path,
          sourcemap: 'inline',
          keepNames: true,
          tsconfigRaw: TSCONFIG_RAW,
          define: {
            'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
            'import.meta.filename': JSON.stringify(args.path),
            'import.meta.dirname': JSON.stringify(path.dirname(args.path)),
          },
        });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/**
 * Build {@link BUILT_ENTRIES} into `outDir`, one `<name>.mjs` each.
 *
 * @param outDir - An empty or missing directory; it is replaced.
 * @returns The built file for each entry's source path.
 * @throws If esbuild reports an error or any warning.
 */
export async function buildContractServer(outDir: string): Promise<Map<string, string>> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build({
    absWorkingDir: SERVER_DIR,
    entryPoints: BUILT_ENTRIES as Record<string, string>,
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: TARGET,
    // Node's own resolution: `main` only, and no `module` condition.
    mainFields: ['main'],
    conditions: [],
    keepNames: true,
    sourcemap: 'linked',
    tsconfigRaw: TSCONFIG_RAW,
    logLevel: 'silent',
    plugins: [sameModulesPlugin()],
  });
  if (result.warnings.length > 0) {
    throw new Error(
      `The contract server build warned, and a warning here can be a module that ` +
        `loads differently from tsx:\n${result.warnings.map((w) => w.text).join('\n')}`
    );
  }
  const built = new Map<string, string>();
  for (const [name, source] of Object.entries(BUILT_ENTRIES)) {
    const file = path.join(outDir, `${name}.mjs`);
    // tsx leaves the source entry in argv[1]; so does this, before any server module runs.
    const prelude = path.join(outDir, `${name}.argv.mjs`);
    await writeFile(prelude, `process.argv[1] = ${JSON.stringify(source)};\n`);
    built.set(source, file);
  }
  return built;
}
