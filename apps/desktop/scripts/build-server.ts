import { build, type Plugin } from 'esbuild';
import { cpSync, readFileSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DESKTOP_PKG = path.resolve(__dirname, '..');
const OUT = path.resolve(DESKTOP_PKG, 'dist');
const PACKAGES_DIR = path.join(ROOT, 'packages');

// Read the desktop package version for injection into the bundle (mirrors
// packages/cli/scripts/build.ts's __CLI_VERSION__ define — apps/server/src/lib/
// version.ts reads that same global identifier regardless of which artifact
// bundled it).
const { version } = JSON.parse(readFileSync(path.join(DESKTOP_PKG, 'package.json'), 'utf-8'));

// --- Vintage-consistency plugin (copied from packages/cli/scripts/build.ts) --
//
// A naive esbuild resolves every `@dorkos/*` workspace import through
// node_modules -> the package's `exports` map -> its compiled `dist/`, which
// can be staler than the working tree (see the CLI build script's incident
// writeup, 2026-07-06, for the failure mode this prevents). Resolving every
// `@dorkos/*` import straight to its package's TypeScript SOURCE keeps this
// bundle internally consistent with the working tree regardless of dist
// freshness. Not extracted into a shared module: the CLI's copy is the only
// other consumer and the two build scripts are otherwise unrelated.
// -----------------------------------------------------------------------------

/** A workspace package indexed for source resolution. */
interface WorkspacePackage {
  /** Absolute path to the package directory. */
  dir: string;
  /** The package's parsed `exports` map (subpath key -> target). */
  exports: Record<string, unknown>;
}

/**
 * Scan the `packages/` directory for `@dorkos` workspace packages and index
 * them by package name so the source resolver can map any import onto that
 * package's TypeScript source.
 *
 * @returns Map from package name (e.g. `@dorkos/harness`) to its dir + exports.
 */
function loadWorkspacePackages(): Map<string, WorkspacePackage> {
  const registry = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PACKAGES_DIR, entry.name);
    let pkg: { name?: string; exports?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    } catch {
      continue; // Directory without a readable package.json (e.g. a build dir).
    }
    if (!pkg.name?.startsWith('@dorkos/') || !pkg.exports) continue;
    registry.set(pkg.name, { dir, exports: pkg.exports });
  }
  return registry;
}

/**
 * Resolve a single `exports` entry to its relative source path. Conditional
 * entries (`{ types, default }`) colocate `types` at the `.ts` source while
 * `default` points at compiled `dist`; `types` is deliberately picked so the
 * bundle embeds source. String entries already point at source and are used
 * as-is.
 *
 * @param entry - The value of an `exports` subpath key.
 * @returns The package-relative source path, or undefined if unresolvable.
 */
function sourcePathFromExportsEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>;
    const source = conditions.types ?? conditions.default;
    if (typeof source === 'string') return source;
  }
  return undefined;
}

/**
 * esbuild plugin that resolves every `@dorkos/*` workspace import (root and
 * subpath) to the package's TypeScript source instead of its compiled dist.
 * `@dorkos/server` itself isn't in this registry (it lives in `apps/`, not
 * `packages/`) — its own `exports` map points straight at source with no
 * `dist` alternative, so esbuild's default resolution already does the right
 * thing for it without this plugin's help.
 *
 * @returns The configured esbuild plugin.
 */
function dorkosSourcePlugin(): Plugin {
  const registry = loadWorkspacePackages();
  return {
    name: 'resolve-dorkos-source',
    setup(build) {
      build.onResolve({ filter: /^@dorkos\// }, (args) => {
        const segments = args.path.split('/');
        const pkgName = `${segments[0]}/${segments[1]}`;
        const pkg = registry.get(pkgName);
        if (!pkg) return undefined;
        const remainder = segments.slice(2).join('/');
        const subpathKey = remainder ? `./${remainder}` : '.';
        const relativeSource = sourcePathFromExportsEntry(pkg.exports[subpathKey]);
        if (!relativeSource) return undefined;
        return { path: path.resolve(pkg.dir, relativeSource) };
      });
    },
  };
}

/**
 * esbuild plugin that makes specific external packages resolve through
 * Node's CJS `require` at runtime, instead of esbuild's default (for
 * externals, in ESM output format) of leaving them as a static ESM `import`.
 *
 * Why: Electron's asar virtual filesystem transparently redirects `require()`
 * reads of an `asarUnpack`'d path to the real, unpacked file — that support
 * was built for the CJS loader. It does not reliably extend to Node's ESM
 * resolver, which a static `import "better-sqlite3"` goes through instead.
 * Symptom observed packaging this app: `utilityProcess.fork()`-ing the ESM
 * bundle threw "NODE_MODULE_VERSION 137 ... requires 145" for better-sqlite3
 * — i.e. dlopen loaded a stale/wrong binary — even though the exact same
 * unpacked file loaded correctly via a plain CJS `require()` from a script
 * run the same way. Routing these specific packages through `require()`
 * (via the banner's `createRequire` shim) sidesteps the ESM path entirely.
 * Only applied to packages that actually `dlopen` a native `.node` binary —
 * pure-JS externals (express, zod, cors, ...) aren't subject to this and
 * bundle as plain ESM imports.
 *
 * The shim's named exports come from the STATIC map below rather than a
 * build-time `require()` probe of the real package: probing would dlopen
 * the native binary under whatever ABI it currently carries, so a build run
 * after `rebuild-natives.ts` (Electron ABI) would crash the build script
 * (system Node) — build order must not be able to wedge the build. The
 * lists mirror `Object.keys(require(pkg))` under a healthy system-Node
 * binary; a missing name would surface as a bundle-time "No matching
 * export" esbuild error at the importing call site, not a silent runtime
 * undefined.
 *
 * @param packages - Bare specifier -> named exports to re-export from the shim.
 * @returns The configured esbuild plugin.
 */
function requireExternalNativesPlugin(packages: Record<string, string[]>): Plugin {
  const packageNames = Object.keys(packages);
  return {
    name: 'require-external-natives',
    setup(build) {
      const filter = new RegExp(
        `^(${packageNames.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
      );
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'require-external' }));
      build.onLoad({ filter: /.*/, namespace: 'require-external' }, (args) => {
        const namedExports = packages[args.path]
          .map((k) => `export const ${k} = __mod[${JSON.stringify(k)}];`)
          .join('\n');
        return {
          contents: `
            import { createRequire as __cr } from 'module';
            const __mod = __cr(import.meta.url)(${JSON.stringify(args.path)});
            export default __mod;
            ${namedExports}
          `,
          loader: 'js',
          resolveDir: DESKTOP_PKG,
        };
      });
    },
  };
}

async function buildServer() {
  console.log('[1/2] Bundling server...');
  rmSync(path.join(OUT, 'server'), { recursive: true, force: true });

  // ESM, not CJS, and `.mjs` (not `.js`): apps/server's source is ESM
  // throughout and much of it computes its own `__dirname` via
  // `path.dirname(fileURLToPath(import.meta.url))` — esbuild leaves
  // `import.meta` empty when targeting the "cjs" output format (it warns
  // "import.meta is not available with the cjs output format"), which would
  // make every one of those computed paths throw at runtime. `.mjs` makes
  // Node treat the file as ESM unambiguously, independent of
  // apps/desktop/package.json's (CommonJS-default, unset) "type" field —
  // which stays untouched so electron-vite's CJS main-process output is
  // unaffected. The `banner` below shims `require`/`__filename`, the two
  // CJS globals real ESM lacks that a handful of bundled dependencies still
  // reach for — same as packages/cli/scripts/build.ts's server bundle.
  //
  // Output lands at dist/server/server-entry.mjs — nested one level under
  // dist/, not flat — because two runtime consumers resolve sibling
  // directories relative to this bundle's own `__dirname` (which, for a
  // single-file esbuild bundle, is wherever the OUTPUT file lives, not
  // wherever the source lived):
  //   - @dorkos/db's runMigrations: path.join(__dirname, '../drizzle')
  //   - ensureCoreExtensions's CORE_SOURCE_DIR: path.resolve(__dirname, '../../core-extensions')
  // Nesting under dist/server/ makes those land at dist/drizzle/ and
  // <desktop pkg root>/core-extensions/ respectively — both copied below —
  // exactly mirroring packages/cli/scripts/build.ts's dist/server/index.js
  // layout (DOR-245) instead of leaking build output outside the package.
  await build({
    entryPoints: [path.join(DESKTOP_PKG, 'src/server-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(OUT, 'server/server-entry.mjs'),
    banner: {
      js: "import { createRequire as __cjsRequire } from 'module'; import { fileURLToPath as __fup } from 'url'; const require = __cjsRequire(import.meta.url); const __filename = __fup(import.meta.url);",
    },
    external: [
      // Runtime SDKs — each ships a native/vendored binary that can't be
      // inlined, so keep them external (resolved at runtime from this
      // package's node_modules, unpacked from app.asar where needed). Kept
      // in sync with packages/cli/scripts/build.ts's identical server-bundle
      // external list; both bundle the exact same apps/server/src/index.ts
      // module graph.
      '@anthropic-ai/claude-agent-sdk',
      '@openai/codex-sdk',
      '@opencode-ai/sdk',
      '@ngrok/ngrok',
      '@scalar/express-api-reference',
      '@asteasolutions/zod-to-openapi',
      'better-sqlite3',
      'node-pty',
      'esbuild',
      'express',
      'cors',
      'dotenv',
      'gray-matter',
      'uuid',
      'zod',
      'conf',
    ],
    plugins: [
      dorkosSourcePlugin(),
      // Only the two externals with real native `.node` binaries — see the
      // plugin's own doc comment for why. Everything else on the external
      // list above is pure JS and unaffected. Named-export lists mirror
      // `Object.keys(require(pkg))` under system Node: better-sqlite3
      // exports a class (default import only in this module graph), node-pty
      // is consumed as `import * as pty` so its names must be re-exported.
      requireExternalNativesPlugin({
        'better-sqlite3': ['SqliteError'],
        'node-pty': ['spawn', 'fork', 'createTerminal', 'open', 'native'],
      }),
    ],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    sourcemap: true,
  });

  // Copy Drizzle migration files alongside the bundled server — see the
  // dist/server/ layout note above.
  rmSync(path.join(OUT, 'drizzle'), { recursive: true, force: true });
  cpSync(path.join(ROOT, 'packages/db/drizzle'), path.join(OUT, 'drizzle'), { recursive: true });
  console.log('  ✓ Copied Drizzle migrations to dist/drizzle/');

  // Copy bundled core-extension source (hello-world, linear-issues,
  // marketplace) to the desktop package root — NOT inside dist/ — matching
  // ensureCoreExtensions's CORE_SOURCE_DIR resolution (see the layout note
  // above) and packages/cli/scripts/build.ts's identical copy step.
  const coreExtensionsSource = path.join(ROOT, 'apps/server/src/core-extensions');
  const coreExtensionsDest = path.join(DESKTOP_PKG, 'core-extensions');
  rmSync(coreExtensionsDest, { recursive: true, force: true });
  cpSync(coreExtensionsSource, coreExtensionsDest, { recursive: true });
  const stagedExtensions = readdirSync(coreExtensionsDest, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory()
  );
  if (stagedExtensions.length === 0) {
    throw new Error(
      `Core extensions copy produced an empty directory: ${coreExtensionsDest} ` +
        `(source: ${coreExtensionsSource}). Refusing to ship a build with no bundled core extensions.`
    );
  }
  console.log(`  ✓ Copied ${stagedExtensions.length} core extensions to ${coreExtensionsDest}`);

  console.log('[2/2] Server bundle complete.');
}

buildServer();
