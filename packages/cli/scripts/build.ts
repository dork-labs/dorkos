import { build, type Plugin } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { cpSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const CLI_PKG = path.resolve(__dirname, '..');
const OUT = path.resolve(CLI_PKG, 'dist');
const PACKAGES_DIR = path.join(ROOT, 'packages');

// Read CLI package version for injection into the binary
const { version } = JSON.parse(readFileSync(path.join(CLI_PKG, 'package.json'), 'utf-8'));

// --- Vintage-consistency invariant -----------------------------------------
//
// Both bundles (server + CLI) are compiled from the working tree's SOURCE, but
// a naive esbuild resolves every `@dorkos/*` workspace import through
// node_modules -> the package's `exports` map -> its compiled `dist/`. That
// splits a bundle across two vintages: the entrypoint reflects the current
// source while the workspace packages reflect whatever dist happened to be on
// disk when the last `pnpm build` ran for that package.
//
// Real incident (2026-07-06): a `cli:dev` build raced a `git pull`. The server
// bundle embedded the PRE-merge `@dorkos/harness` dist while the server source
// was post-merge, producing a cockpit whose new server code drove an old
// harness engine that silently mis-projected marketplace plugins. Diagnostic:
// `grep -c _dorkosHarness dist/bin/cli.js` was 1 while `dist/server/index.js`
// was 0 (torn across the merge boundary).
//
// The `dorkosSourcePlugin` below fixes this by construction: every `@dorkos/*`
// import (root and subpath, in BOTH bundles) resolves to the package's
// TypeScript SOURCE, never its dist. A bundle is therefore always internally
// consistent with the working tree, regardless of dist freshness. Because the
// packages colocate their `types` condition at the .ts source (dist is the
// compiled artifact), we resolve through each package's own `exports` map and
// select the `types` path. That single rule handles every edge case the naive
// `src/<sub>.ts` convention misses (for example `@dorkos/harness/scan` points
// at `src/scan/scanner.ts`, and `@dorkos/relay/testing` at `src/testing/
// index.ts`), and it stays correct as packages add or rename subpaths.
// ---------------------------------------------------------------------------

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
 * package's TypeScript source. Runs once at build start; the working tree it
 * reads is the exact vintage the bundle is built from.
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
 * `default` points at compiled `dist`; we deliberately pick `types` so the
 * bundle embeds source (see the vintage-consistency invariant above). String
 * entries already point at source and are used as-is.
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
 * subpath) to the package's TypeScript source instead of its compiled dist,
 * enforcing the vintage-consistency invariant documented above. Applied to
 * BOTH the server and CLI bundles.
 *
 * Unknown packages or unknown subpaths return undefined so esbuild falls back
 * to its default resolution (and surfaces a genuine error if the import is
 * bogus) rather than silently masking a problem.
 *
 * @returns The configured esbuild plugin.
 */
function dorkosSourcePlugin(): Plugin {
  const registry = loadWorkspacePackages();
  return {
    name: 'resolve-dorkos-source',
    setup(build) {
      build.onResolve({ filter: /^@dorkos\// }, (args) => {
        // `@dorkos/<pkg>` (scope + name), then an optional subpath remainder.
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
 * esbuild plugin that redirects the CLI entry's `../server/services/*` imports
 * to the server source tree. Those specifiers only exist relative to the
 * compiled dist layout (`dist/bin/` next to `dist/server/`), so during bundling
 * they must point at `apps/server/src/services/*`. CLI bundle only.
 *
 * @returns The configured esbuild plugin.
 */
function serverServicesRedirectPlugin(): Plugin {
  return {
    name: 'redirect-server-services',
    setup(build) {
      build.onResolve({ filter: /\.\.\/server\/services\// }, (args) => {
        const match = args.path.match(/\.\.\/server\/services\/(.+)/);
        if (!match) return undefined;
        const relativePath = match[1].replace(/\.js$/, '.ts');
        return { path: path.join(ROOT, 'apps/server/src/services', relativePath) };
      });
    },
  };
}

async function buildCLI() {
  // Clean
  await fs.rm(OUT, { recursive: true, force: true });

  // 1. Build client (Vite)
  console.log('[1/3] Building client...');
  execSync('pnpm turbo build --filter=@dorkos/client', { cwd: ROOT, stdio: 'inherit' });
  await fs.cp(path.join(ROOT, 'apps/client/dist'), path.join(OUT, 'client'), { recursive: true });

  // 2. Bundle server (esbuild) — inlines @dorkos/shared, externalizes node_modules
  console.log('[2/3] Bundling server...');
  await build({
    entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'server/index.js'),
    external: [
      // Runtime SDKs — each ships a native/vendored binary that can't be
      // inlined, so keep them external (resolved at runtime from the CLI's
      // node_modules), exactly like the Claude SDK. They MUST also be listed in
      // packages/cli/package.json dependencies so a published CLI installs them.
      '@anthropic-ai/claude-agent-sdk',
      '@openai/codex-sdk',
      '@opencode-ai/sdk',
      '@ngrok/ngrok',
      '@scalar/express-api-reference',
      '@asteasolutions/zod-to-openapi',
      'better-sqlite3',
      // node-pty is a native addon (.node + a spawn-helper binary) that esbuild
      // cannot bundle — keep it external so it resolves at runtime from the
      // CLI's node_modules, exactly like better-sqlite3. Pulled in via
      // services/terminal/ (the embedded workbench terminal, ADR 260708-185521).
      'node-pty',
      // esbuild's JS API cannot be bundled: it spawns a per-platform native
      // binary that it locates via a relative path from its OWN on-disk package
      // location. Inlined into this single-file bundle, that path is wrong and
      // esbuild throws ("The esbuild JavaScript API cannot be bundled..."), so
      // every server-capable extension (marketplace is defaultEnabled) fails to
      // compile at runtime (DOR-256). Keep it external — resolved at runtime
      // from the CLI's node_modules — and ship it as a real dependency of
      // packages/cli, exactly like better-sqlite3 and node-pty. Used by
      // services/extensions/extension-compiler.ts to tsx-transpile extensions.
      'esbuild',
      'express',
      'cors',
      'dotenv',
      'gray-matter',
      'uuid',
      'zod',
      'conf',
      '@inquirer/prompts',
    ],
    plugins: [dorkosSourcePlugin()],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    sourcemap: true,
    banner: {
      js: "import { createRequire as __cjsRequire } from 'module'; import { fileURLToPath as __fup } from 'url'; const require = __cjsRequire(import.meta.url); const __filename = __fup(import.meta.url);",
    },
  });

  // 2.5: Copy Drizzle migration files alongside bundled server.
  // At runtime, runMigrations() resolves migrations via path.join(__dirname, '../drizzle').
  // In the CLI bundle, __dirname is dist/server/, so ../drizzle resolves to dist/drizzle/.
  cpSync(path.join(ROOT, 'packages/db/drizzle'), path.join(OUT, 'drizzle'), { recursive: true });
  console.log('  ✓ Copied Drizzle migrations to dist/drizzle/');

  // 2.6: Copy bundled core-extension source (hello-world, linear-issues,
  // marketplace) alongside the CLI package — NOT inside dist/.
  //
  // ensure-core-extensions.ts resolves its source dir via
  // `path.resolve(__dirname, '../../core-extensions')`, relative to the
  // COMPILED module. In the esbuild-bundled server, every inlined module
  // shares one `__dirname`: the bundle's own output location, dist/server/.
  // Two `..` from dist/server lands at the CLI package root (sibling of
  // dist/), not inside it — confirmed by the ENOENT path in DOR-245's
  // evidence (`node_modules/dorkos/core-extensions`, not
  // `node_modules/dorkos/dist/core-extensions`). Copy raw TypeScript source
  // (not compiled — ExtensionCompiler tsx-transpiles it at stage time,
  // mirroring apps/server's own `cpSync src/core-extensions dist/core-extensions`
  // build step) to that exact location so the bundled server finds it.
  const coreExtensionsSource = path.join(ROOT, 'apps/server/src/core-extensions');
  const coreExtensionsDest = path.join(CLI_PKG, 'core-extensions');
  await fs.rm(coreExtensionsDest, { recursive: true, force: true });
  await fs.cp(coreExtensionsSource, coreExtensionsDest, { recursive: true });
  const stagedExtensions = (await fs.readdir(coreExtensionsDest, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory()
  );
  if (stagedExtensions.length === 0) {
    throw new Error(
      `Core extensions copy produced an empty directory: ${coreExtensionsDest} ` +
        `(source: ${coreExtensionsSource}). Refusing to ship a build with no ` +
        'bundled core extensions — see DOR-245.'
    );
  }
  console.log(`  ✓ Copied ${stagedExtensions.length} core extensions to ${coreExtensionsDest}`);

  // 3. Compile CLI entry
  // The CLI imports ../server/services/core/config-manager.js which doesn't exist
  // relative to packages/cli/src/. The redirect plugin points it at server source;
  // the source plugin inlines every @dorkos/* import from source (see invariant).
  console.log('[3/3] Compiling CLI...');
  await build({
    entryPoints: [path.join(ROOT, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'bin/cli.js'),
    external: [
      'dotenv',
      '../server/index.js',
      'conf',
      '@inquirer/prompts',
      '@ngrok/ngrok',
      // better-sqlite3 is a native addon (.node) that esbuild cannot bundle.
      // Pulled into this bundle via `@dorkos/db` → the `dorkos auth` commands
      // (auth-instance.ts opens the local DB); resolves at runtime from the
      // CLI's node_modules like the other native/CJS externals.
      'better-sqlite3',
      // node-pty is a native addon (.node) esbuild cannot bundle. Kept external
      // here too so any server-source path the CLI entry inlines (via the
      // redirect plugin) that transitively reaches services/terminal/ resolves
      // it at runtime from the CLI's node_modules, mirroring better-sqlite3.
      'node-pty',
      // gray-matter uses CommonJS `require('fs')` which esbuild's ESM output
      // cannot inline — keep it external so it resolves at runtime via the
      // CLI's node_modules. Pulled in transitively by `@dorkos/skills/parser`
      // → `@dorkos/marketplace/package-validator` → `dorkos package validate`.
      'gray-matter',
    ],
    plugins: [dorkosSourcePlugin(), serverServicesRedirectPlugin()],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    banner: { js: '#!/usr/bin/env node' },
  });

  // Make executable
  await fs.chmod(path.join(OUT, 'bin/cli.js'), 0o755);

  console.log('Build complete.');
}

buildCLI();
