import { build, formatMessages, type Message, type Plugin } from 'esbuild';
import { execSync } from 'child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { buildNativeObserver } from '../../browser/scripts/build-native-observer.ts';
import { importBrowserNativeArtifact } from './browser-native-artifact.ts';
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

function communityMigrationCompatibilityId(): string {
  const migrations = path.join(ROOT, 'apps/community/migrations');
  const hash = createHash('sha256');
  for (const filename of readdirSync(migrations)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    hash.update(filename);
    hash.update('\0');
    hash.update(readFileSync(path.join(migrations, filename)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const communityMigrationId = communityMigrationCompatibilityId();

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

/**
 * Workspace packages published to npm under `@dork-labs/` that the bundles
 * still inline from SOURCE. `@dork-labs/connector-providers` holds the connector
 * schemas `@dorkos/shared` used to own, and the server reaches it both directly
 * and through those shared re-exports, so it keeps the vintage-consistency
 * invariant above. A published package's `types` condition points at built
 * `dist/*.d.ts`, so its source path is derived from `default` or `import` instead
 * (`./dist/x.js` -> `./src/x.ts`).
 */
const PUBLISHED_SOURCE_PACKAGES = new Set(['@dork-labs/connector-providers']);

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
function loadWorkspacePackages(packagesDirectory = PACKAGES_DIR): Map<string, WorkspacePackage> {
  const registry = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDirectory, entry.name);
    let pkg: { name?: string; exports?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    } catch {
      continue; // Directory without a readable package.json (e.g. a build dir).
    }
    if (!pkg.name || !pkg.exports) continue;
    if (!pkg.name.startsWith('@dorkos/') && !PUBLISHED_SOURCE_PACKAGES.has(pkg.name)) continue;
    registry.set(pkg.name, { dir, exports: pkg.exports });
  }
  return registry;
}

/**
 * Resolve a single `exports` entry to its relative source path. Conditional
 * entries (`{ types, default }`) colocate `types` at the `.ts` source while
 * `default` points at compiled `dist`; we deliberately pick `types` so the
 * bundle embeds source (see the vintage-consistency invariant above). String
 * entries already point at source and are used as-is. A published package's
 * `types` is a built `.d.ts`, so its source is derived from `default` or `import`.
 *
 * @param entry - The value of an `exports` subpath key.
 * @returns The package-relative source path, or undefined if unresolvable.
 */
function sourcePathFromExportsEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>;
    if (typeof conditions.types === 'string' && conditions.types.endsWith('.d.ts')) {
      // A published package: map its compiled entry back to the source file.
      const built = conditions.default ?? conditions.import;
      if (typeof built !== 'string' || !/^\.\/dist\/.+\.js$/.test(built)) return undefined;
      return built.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts');
    }
    const source = conditions.types ?? conditions.default;
    if (typeof source === 'string') return source;
  }
  return undefined;
}

/**
 * esbuild plugin that resolves every `@dorkos/*` workspace import, and those
 * of {@link PUBLISHED_SOURCE_PACKAGES}, (root and subpath) to the package's TypeScript source instead of its compiled dist,
 * enforcing the vintage-consistency invariant documented above. Applied to
 * BOTH the server and CLI bundles.
 *
 * Unknown packages or unknown subpaths return undefined so esbuild falls back
 * to its default resolution (and surfaces a genuine error if the import is
 * bogus) rather than silently masking a problem.
 *
 * @returns The configured esbuild plugin.
 */
export function dorkosSourcePlugin(root = ROOT): Plugin {
  const registry = loadWorkspacePackages(path.join(root, 'packages'));
  return {
    name: 'resolve-dorkos-source',
    setup(build) {
      build.onResolve(
        { filter: /^@(?:dorkos\/|dork-labs\/connector-providers(?:\/|$))/ },
        (args) => {
          // `@<scope>/<pkg>` (scope + name), then an optional subpath remainder.
          const segments = args.path.split('/');
          const pkgName = `${segments[0]}/${segments[1]}`;
          const pkg = registry.get(pkgName);
          if (!pkg) return undefined;
          const remainder = segments.slice(2).join('/');
          const subpathKey = remainder ? `./${remainder}` : '.';
          const relativeSource = sourcePathFromExportsEntry(pkg.exports[subpathKey]);
          if (!relativeSource) return undefined;
          return { path: path.resolve(pkg.dir, relativeSource) };
        }
      );
    },
  };
}

/**
 * esbuild plugin that redirects the CLI entry's `../server/services/*` and
 * `../server/lib/*` imports to the server source tree. Those specifiers only
 * exist relative to the compiled dist layout (`dist/bin/` next to
 * `dist/server/`), so during bundling they must point at
 * `apps/server/src/{services,lib}/*`. CLI bundle only.
 *
 * `lib/` joined `services/` when `dorkos config set` started writing the config
 * audit line (DOR-1247): the line goes through the server's own logger, so the
 * CLI has to call `lib/logger.js`'s `initLogger` to point it at the same
 * `~/.dork/logs/dorkos.log` the server writes. Anything else under
 * `apps/server/src` is still unreachable, which is deliberate — the CLI reaches
 * for narrow, side-effect-free modules, not for the server's composition root
 * (`../server/index.js` stays external and is the whole server).
 *
 * tsc needs the same rewrite and cannot reuse this plugin, so
 * `packages/cli/server/**.d.ts` mirrors it in declarations. Change the mapping
 * here and that mirror has to move with it — `src/__tests__/server-shims.test.ts`
 * fails if the two disagree, because a mirror that drifts means the typecheck
 * quietly stops describing the bundle this function produces.
 *
 * @returns The configured esbuild plugin.
 */
function serverServicesRedirectPlugin(): Plugin {
  return {
    name: 'redirect-server-services',
    setup(build) {
      build.onResolve({ filter: /\.\.\/server\/(services|lib)\// }, (args) => {
        const match = args.path.match(/\.\.\/server\/((?:services|lib)\/.+)/);
        if (!match) return undefined;
        const relativePath = match[1].replace(/\.js$/, '.ts');
        return { path: path.join(ROOT, 'apps/server/src', relativePath) };
      });
    },
  };
}

/**
 * esbuild warning texts tolerated in these bundles, matched as substrings of
 * `Message.text`.
 *
 * Deliberately EMPTY. esbuild reports the failure modes that survive a build
 * and only break at a user's install as *warnings*, not errors — an
 * unresolvable dynamic `require`, `import.meta` in the wrong output format, an
 * external that never resolves. Both bundles here are warning-free today, so
 * the strongest gate is also the free one.
 *
 * Every entry added here must quote the exact warning and say why it is safe.
 * "It's noisy" is not a reason — fix the cause instead.
 *
 * Deliberately duplicated from `apps/desktop/scripts/build-server.ts` rather
 * than shared, matching how `dorkosSourcePlugin` is already duplicated between
 * these two scripts (see the invariant note above): they are otherwise
 * unrelated, and a shared build-tooling package for ~20 lines would cost more
 * than it saves. Keep the two copies in step.
 */
const ALLOWED_WARNING_TEXTS: readonly string[] = [];

/**
 * Fail the build on any esbuild warning outside {@link ALLOWED_WARNING_TEXTS}.
 *
 * @param label - Which bundle produced them, for the error message.
 * @param warnings - `BuildResult.warnings` from that bundle.
 * @throws If any warning is not allowlisted.
 */
async function assertNoUnexpectedWarnings(label: string, warnings: Message[]): Promise<void> {
  const unexpected = warnings.filter(
    (warning) => !ALLOWED_WARNING_TEXTS.some((allowed) => warning.text.includes(allowed))
  );
  if (unexpected.length === 0) return;

  // Reuse esbuild's own renderer so the failure reads exactly like the
  // warnings it prints on the success path (file, line, source excerpt).
  const rendered = await formatMessages(unexpected, {
    kind: 'warning',
    color: true,
    terminalWidth: 100,
  });
  throw new Error(
    `esbuild emitted ${unexpected.length} warning(s) building the ${label} bundle; ` +
      `refusing to publish a bundle nobody has looked at.\n\n${rendered.join('\n')}\n` +
      `Fix the cause, or — if the warning is genuinely safe here — add it to ` +
      `ALLOWED_WARNING_TEXTS in this file with a comment saying why.`
  );
}

/** Compile the fresh verifier from this checkout and bind it to the actual CLI output. */
export async function buildBrowserRuntimeAssets(root = ROOT, output = OUT): Promise<void> {
  const controller = path.join(output, 'bin/cli.js');
  const controllerBytes = await fs.readFile(controller);
  const verifier = path.join(output, 'browser/fresh-verifier.mjs');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'packages/browser/src/runtime/installation/fresh-verifier.ts')],
    outfile: verifier,
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'esm',
    external: ['zod'],
    plugins: [dorkosSourcePlugin(root)],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  await assertNoUnexpectedWarnings('browser verifier', result.warnings);
  const allowed = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    'zod',
  ]);
  for (const record of [
    ...Object.values(result.metafile!.inputs),
    ...Object.values(result.metafile!.outputs),
  ]) {
    for (const dependency of record.imports) {
      if (dependency.external && !allowed.has(dependency.path))
        throw new Error(`Browser verifier dependency is not packaged: ${dependency.path}`);
    }
  }
  if (
    result.outputFiles.length !== 1 ||
    path.resolve(result.outputFiles[0].path) !== path.resolve(verifier)
  )
    throw new Error('Browser verifier output is missing or unexpected.');
  const verifierBytes = result.outputFiles[0].contents;
  const manifest = {
    schemaVersion: 1,
    controllerSHA256: createHash('sha256').update(controllerBytes).digest('hex'),
    verifierSHA256: createHash('sha256').update(verifierBytes).digest('hex'),
  };
  await fs.mkdir(path.dirname(verifier), { recursive: true });
  await fs.writeFile(verifier, verifierBytes);
  await fs.writeFile(
    path.join(output, 'browser/source-manifest.json'),
    JSON.stringify(manifest) + '\n'
  );
}

/** Package actual original native workers/helper; unsupported build hosts remain unavailable.
 * No runtime compiler/download, fixture path, or source-only ready callback is emitted. */
export async function buildBrowserNativeAssets(root = ROOT, output = OUT): Promise<void> {
  const assets = path.join(output, 'browser/native');
  await fs.mkdir(assets, { recursive: true });
  const artifactDirectory = process.env.DORKOS_BROWSER_DARWIN_ARTIFACT_DIRECTORY;
  const artifactSHA256 = process.env.DORKOS_BROWSER_DARWIN_ARTIFACT_SHA256;
  if (Boolean(artifactDirectory) !== Boolean(artifactSHA256))
    throw new Error(
      'The browser native release artifact requires both its directory and pinned manifest hash.'
    );
  let native:
    | Awaited<ReturnType<typeof buildNativeObserver>>
    | Awaited<ReturnType<typeof importBrowserNativeArtifact>>
    | undefined = artifactDirectory
    ? undefined
    : await buildNativeObserver({ outputDirectory: assets });
  const workers: { name: string; sha256: string; bytes: number }[] = [];
  for (const worker of ['darwin-journal-worker', 'darwin-supervisor-worker'] as const) {
    const name = `${worker}.mjs`,
      outfile = path.join(assets, name);
    const result = await build({
      absWorkingDir: root,
      entryPoints: [path.join(root, `packages/browser/src/runtime/${worker}.ts`)],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22.22',
      format: 'esm',
      external: ['zod', 'playwright-core'],
      plugins: [dorkosSourcePlugin(root)],
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    await assertNoUnexpectedWarnings(`browser ${worker}`, result.warnings);
    const allowed = new Set([
      ...builtinModules,
      ...builtinModules.map((value) => `node:${value}`),
      'zod',
      'playwright-core',
    ]);
    for (const record of [
      ...Object.values(result.metafile!.inputs),
      ...Object.values(result.metafile!.outputs),
    ])
      for (const dependency of record.imports)
        if (dependency.external && !allowed.has(dependency.path))
          throw new Error(`Browser native worker dependency is not packaged: ${dependency.path}`);
    if (
      result.outputFiles.length !== 1 ||
      path.resolve(result.outputFiles[0].path) !== path.resolve(outfile)
    )
      throw new Error('Browser native worker output is missing or unexpected.');
    const bytes = result.outputFiles[0].contents;
    if (bytes.length > 16 * 1024 * 1024)
      throw new Error('Browser native worker exceeds its packaged bound.');
    await fs.writeFile(outfile, bytes);
    workers.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  if (artifactDirectory)
    native = await importBrowserNativeArtifact(root, assets, artifactDirectory, artifactSHA256!);
  if (!native) throw new Error('Browser native producer is missing.');
  const controller = await fs.readFile(path.join(output, 'bin/cli.js'));
  const nativeManifest = await fs.readFile(
    path.join(assets, 'darwin-process-observer.manifest.json')
  );
  const manifest = {
    version: 1,
    controllerSHA256: createHash('sha256').update(controller).digest('hex'),
    nativeManifestSHA256: createHash('sha256').update(nativeManifest).digest('hex'),
    platform: native.platform,
    arch: native.arch,
    availability: native.availability,
    workers,
  };
  await fs.writeFile(path.join(assets, 'package-manifest.json'), JSON.stringify(manifest) + '\n');
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
  const serverBundle = await build({
    entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'esm',
    outfile: path.join(OUT, 'server/index.js'),
    external: [
      // Runtime SDKs — each ships a native/vendored binary that can't be
      // inlined, so keep them external (resolved at runtime from the CLI's
      // node_modules), exactly like the Claude SDK. They MUST also be listed in
      // packages/cli/package.json dependencies so a published CLI installs them.
      '@anthropic-ai/claude-agent-sdk',
      '@composio/core',
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
      'uuid',
      'zod',
      'conf',
      '@inquirer/prompts',
    ],
    plugins: [dorkosSourcePlugin()],
    define: {
      __CLI_VERSION__: JSON.stringify(version),
      __COMMUNITY_MIGRATION_COMPATIBILITY_ID__: JSON.stringify(communityMigrationId),
    },
    sourcemap: true,
    banner: {
      js: "import { createRequire as __cjsRequire } from 'module'; import { fileURLToPath as __fup } from 'url'; const require = __cjsRequire(import.meta.url); const __filename = __fup(import.meta.url);",
    },
  });

  // 2.1: The extension child (DOR-2686). DorkOS forks this file, not the
  // server bundle, for every extension that runs separately, with Node's
  // permission model on and read access to nothing but this file and the
  // extension's own. So it must be ONE self-contained file: express and the
  // extension API are inlined (the server bundle keeps them external, and the
  // child could not read node_modules anyway). CommonJS, as `.cjs`, because
  // this package is `"type": "module"`. The server finds it beside its own
  // bundle (`isolation/child-entry.ts`, CHILD_ENTRY_FILE); the name and the
  // entry are pinned by scripts/__tests__/extension-child-build-entry.test.ts.
  const childBundle = await build({
    entryPoints: [
      path.join(ROOT, 'apps/server/src/services/extensions/isolation/child/bootstrap.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'cjs',
    outfile: path.join(OUT, 'server/extension-child.cjs'),
    plugins: [dorkosSourcePlugin()],
  });
  await assertNoUnexpectedWarnings('extension child', childBundle.warnings);

  // 2.5: Copy Drizzle migration files alongside bundled server.
  // At runtime, `migrationsFolder()` (packages/db/src/migrations-folder.ts) resolves them via
  // path.join(dirname(fileURLToPath(import.meta.url)), '../drizzle'). In the CLI bundle that
  // directory is dist/server/, so ../drizzle resolves to dist/drizzle/. Both the migrator and
  // the pre-migration snapshot (which reads meta/_journal.json) go through that one function.
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
  // esbuild's default logLevel PRINTS warnings and exits 0. Everything this
  // bundle can get wrong in a way that only shows up at a user's install
  // arrives as a warning, so read them (DOR-536).
  await assertNoUnexpectedWarnings('server', serverBundle.warnings);

  console.log('[3/3] Compiling CLI...');
  const cliBundle = await build({
    entryPoints: [path.join(ROOT, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
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
    ],
    plugins: [dorkosSourcePlugin(), serverServicesRedirectPlugin()],
    define: {
      __CLI_VERSION__: JSON.stringify(version),
      __COMMUNITY_MIGRATION_COMPATIBILITY_ID__: JSON.stringify(communityMigrationId),
    },
    banner: { js: '#!/usr/bin/env node' },
  });

  await assertNoUnexpectedWarnings('CLI', cliBundle.warnings);
  await buildBrowserRuntimeAssets();
  await buildBrowserNativeAssets();

  // Make executable
  await fs.chmod(path.join(OUT, 'bin/cli.js'), 0o755);

  console.log('Build complete.');
}

// Node ≥15 already exits non-zero on an unhandled rejection, but this build's
// failure semantics must not rest on a runtime default that a flag or a future
// Node can change — and the default's output buries the cause under an
// UnhandledPromiseRejection stack nobody reads.
//
// The rejected output is deleted rather than left behind: the warning gates
// above run AFTER esbuild has written their bundles, and `dist/` here is what
// `pnpm pack` publishes to npm. (The desktop's equivalent gate learned this the
// hard way — a rejected bundle got packaged and died at fork time.)
// Order matters: PRINT the real failure first, then clean up. A cleanup that
// throws (EPERM, a file locked by another process on Windows) must not be able
// to replace the diagnosis with a stack about the removal — which is the exact
// outcome this handler exists to prevent. Belt and braces: the removal is also
// caught, so it can only ever add a line, never take one away.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void buildCLI().catch(async (err: unknown) => {
    console.error(`\n[cli-build] Build FAILED:\n`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    await fs.rm(OUT, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      console.error(
        `\n[cli-build] Could not remove the rejected output at ${OUT} — delete it by hand ` +
          `before packing, it is what \`pnpm pack\` publishes:\n${String(cleanupErr)}`
      );
    });
    process.exit(1);
  });
}
