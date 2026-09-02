import { execFileSync } from 'child_process';
import {
  build,
  formatMessages,
  version as esbuildVersion,
  type Message,
  type Metafile,
  type Plugin,
} from 'esbuild';
import { cpSync, readFileSync, readdirSync, rmSync } from 'fs';
import { isBuiltin } from 'module';
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

/**
 * The externals whose runtime resolution {@link requireExternalNativesPlugin}
 * routes through CJS `require`: bare specifier -> the named exports its shim
 * re-exports. Only packages that actually `dlopen` a native `.node` binary
 * belong here — see that plugin's doc comment.
 *
 * Named rather than inlined at the call site because the post-build check
 * needs the same list: a `createRequire(import.meta.url)(...)` call is opaque
 * to esbuild, so these specifiers never appear in the metafile and would
 * otherwise be the only runtime imports nothing verifies.
 */
const NATIVE_REQUIRE_EXTERNALS: Record<string, string[]> = {
  // Named-export lists mirror `Object.keys(require(pkg))` under a healthy
  // system-Node binary: better-sqlite3 exports a class (default import only in
  // this module graph), node-pty is consumed as `import * as pty` so its names
  // must be re-exported.
  'better-sqlite3': ['SqliteError'],
  'node-pty': ['spawn', 'fork', 'createTerminal', 'open', 'native'],
};

/**
 * esbuild warning texts tolerated in this bundle, matched as substrings of
 * `Message.text`.
 *
 * Deliberately EMPTY. esbuild reports this app's most expensive failure class
 * — a bundle that builds green and only dies in a real packaged install — as
 * *warnings*, not errors: an unresolvable dynamic `require`, `import.meta` in
 * the wrong output format, an external that never resolves. Left unread (as
 * they were until DOR-536), each of those ships.
 *
 * Every entry added here must quote the exact warning and say why it is safe
 * in THIS bundle. "It's noisy" is not a reason — fix the cause instead.
 */
const ALLOWED_WARNING_TEXTS: readonly string[] = [];

/**
 * Fail the build on any esbuild warning outside {@link ALLOWED_WARNING_TEXTS}.
 *
 * @param warnings - `BuildResult.warnings` from the server bundle.
 * @throws If any warning is not allowlisted.
 */
async function assertNoUnexpectedWarnings(warnings: Message[]): Promise<void> {
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
    `esbuild emitted ${unexpected.length} warning(s) while bundling the server; ` +
      `refusing to ship a bundle nobody has looked at.\n\n${rendered.join('\n')}\n` +
      `Fix the cause, or — if the warning is genuinely safe here — add it to ` +
      `ALLOWED_WARNING_TEXTS in this file with a comment saying why.`
  );
}

/**
 * Source of the child process that checks every specifier the bundle will ask
 * Node for at load time. Runs as ESM with its CWD set to the bundle's own
 * directory, so `import.meta.resolve` starts the same walk the packaged app's
 * `utilityProcess.fork()` of `dist/server/server-entry.mjs` starts
 * (`dist/server/` -> `dist/` -> the desktop package's `node_modules`).
 *
 * It is a SUPERSET of that walk, not an equal: at build time `dist/server/`
 * sits inside the source tree, so resolution continues past
 * `apps/desktop/node_modules` — which also holds devDependencies electron-
 * builder never packs — and on up to the repo root. A devDependency would
 * therefore resolve here and still be missing from a real install. That gap is
 * what {@link assertExternalsArePackaged} closes; the two checks are only
 * complete together.
 *
 * Resolution only: `import.meta.resolve` locates a package's entry file
 * without loading it. That is the whole point — see
 * {@link verifyBundleLoadable} for why this must never evaluate anything.
 * Deliberately written without template literals so it survives being embedded
 * in one here.
 */
const RESOLVE_SPECIFIERS_HARNESS = `
const specifiers = JSON.parse(process.env.DORKOS_BUNDLE_SPECIFIERS);
const unresolved = [];
for (const specifier of specifiers) {
  try {
    import.meta.resolve(specifier);
  } catch (err) {
    unresolved.push('  ' + specifier + ' — ' + (err && err.code ? err.code : String(err)));
  }
}
if (unresolved.length > 0) {
  console.error('Unresolvable from the emitted bundle:\\n' + unresolved.join('\\n'));
  process.exit(1);
}
`;

/**
 * Specifiers the emitted bundle references but is allowed NOT to resolve.
 *
 * `ws` (transitively bundled, behind the terminal WebSocket channel) reaches
 * for two optional native accelerators inside a `try`/`catch`, falling back to
 * its pure-JS mask/UTF-8 paths when the `require` throws — which is exactly
 * what happens here, since neither is installed. esbuild leaves such a guarded
 * `require` alone with no diagnostic, so the bundle is correct as emitted.
 *
 * Only genuinely optional-at-runtime packages belong here. Anything the server
 * cannot boot without must resolve.
 */
const OPTIONAL_RUNTIME_SPECIFIERS: readonly string[] = ['bufferutil', 'utf-8-validate'];

/**
 * Every bare specifier the emitted bundle resolves at runtime: the externals
 * esbuild left in the output (authoritative — read from the metafile, so a
 * package on the `external` list that nothing actually imports is not checked)
 * plus the `require`-routed natives esbuild cannot see, minus
 * {@link OPTIONAL_RUNTIME_SPECIFIERS}.
 *
 * Node builtins are kept in rather than filtered out: they resolve for free,
 * and a rule for excluding them is one more thing to get wrong.
 *
 * @param metafile - `BuildResult.metafile` from the server bundle.
 * @returns Sorted, de-duplicated specifiers.
 */
function collectRuntimeSpecifiers(metafile: Metafile): string[] {
  const specifiers = new Set<string>(Object.keys(NATIVE_REQUIRE_EXTERNALS));
  // Union across outputs rather than looking up one key: the bundle is the only
  // JS output, and its metafile key is CWD-relative (so it would depend on
  // where this script was invoked from).
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !OPTIONAL_RUNTIME_SPECIFIERS.includes(imported.path)) {
        specifiers.add(imported.path);
      }
    }
  }
  return [...specifiers].sort();
}

/**
 * The package name a specifier resolves through: `zod/v4` -> `zod`,
 * `@scope/pkg/sub` -> `@scope/pkg`.
 *
 * @param specifier - A bare import specifier.
 */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

/**
 * Assert every package the bundle imports is one electron-builder will pack.
 *
 * The resolution check alone cannot see this: it runs against the source tree,
 * where `node_modules` also contains devDependencies (see
 * {@link RESOLVE_SPECIFIERS_HARNESS}). electron-builder copies only the
 * PRODUCTION dependency tree into `app.asar`, so an external that is merely a
 * devDependency resolves cleanly at build time and is simply absent from the
 * installed app — the same `ERR_MODULE_NOT_FOUND` at fork time, from the one
 * direction the other gate is blind to.
 *
 * Nothing trips this today (all externals are real dependencies); it exists so
 * that stays true by construction rather than by luck.
 *
 * @param specifiers - Runtime specifiers from {@link collectRuntimeSpecifiers}.
 * @throws If a specifier's package is not a declared runtime dependency.
 */
function assertExternalsArePackaged(specifiers: string[]): void {
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP_PKG, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  // optionalDependencies count: electron-builder packs them, and that is how
  // the per-platform Claude Code binary ships (see electron-builder.yml).
  const packaged = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const missing = specifiers
    .filter((specifier) => !isBuiltin(specifier))
    .map(packageNameOf)
    .filter((name) => !packaged.has(name));
  if (missing.length === 0) return;
  throw new Error(
    `The bundle imports ${[...new Set(missing)].join(', ')} at runtime, but ` +
      `apps/desktop/package.json does not list it under dependencies or ` +
      `optionalDependencies. It resolves from the source tree (probably as a ` +
      `devDependency or a hoisted transitive) and would be ABSENT from the packaged ` +
      `app — electron-builder packs only the production dependency tree.`
  );
}

/**
 * Verify the emitted bundle would actually load, so a missing or misspelled
 * external fails the BUILD rather than the release. Three gates:
 *
 * 1. `node --check` parses the output as ESM (it is `.mjs`), catching a
 *    malformed emit before it reaches a packaged app.
 * 2. Every specifier the bundle will hand to Node resolves from the bundle's
 *    own directory — the failure mode this exists for (`ERR_MODULE_NOT_FOUND`
 *    at `utilityProcess.fork()` time, i.e. a windowless app in a real install).
 *
 * It stops short of EVALUATING the module graph, on purpose, twice over:
 *
 * - Evaluating the entry runs `main()`, which imports `@dorkos/server` — that
 *   binds a port, creates the SQLite store under `DORK_HOME`, and starts
 *   schedulers. A build step must not do any of that. (There is no way to bail
 *   between the two: esbuild inlines that dynamic import into this bundle.)
 * - Evaluation would also `dlopen` better-sqlite3/node-pty through the
 *   `createRequire` shim. A build run after `scripts/rebuild-natives.ts` would
 *   then load an Electron-ABI binary under system Node and wedge the build —
 *   exactly the hazard {@link requireExternalNativesPlugin} avoids by not
 *   probing those packages. Resolution reaches a package's entry `.js`, never
 *   its `.node` binary, so this check is ABI-blind by construction.
 *
 * The packaged runtime is exercised for real by the desktop-smoke workflow
 * (`.github/workflows/desktop-smoke.yml`), which is where a boot failure
 * belongs — not in every developer's `pnpm build`.
 *
 * @param outfile - Absolute path to the emitted server bundle.
 * @param metafile - `BuildResult.metafile` from the same build.
 * @throws If the bundle does not parse, a specifier fails to resolve, or a
 *   specifier resolves only because of a dependency that is not packaged.
 */
function verifyBundleLoadable(outfile: string, metafile: Metafile): void {
  try {
    execFileSync(process.execPath, ['--check', outfile], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`Emitted bundle is not parseable as ESM: ${outfile} (see the error above).`, {
      cause: err,
    });
  }

  const specifiers = collectRuntimeSpecifiers(metafile);
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', RESOLVE_SPECIFIERS_HARNESS], {
      cwd: path.dirname(outfile),
      stdio: 'inherit',
      env: { ...process.env, DORKOS_BUNDLE_SPECIFIERS: JSON.stringify(specifiers) },
    });
  } catch (err) {
    throw new Error(
      'The emitted bundle imports packages that do not resolve from its own directory ' +
        '(listed above). A packaged app would die at fork() time with ERR_MODULE_NOT_FOUND. ' +
        `Add the package to apps/desktop/package.json's dependencies, or fix the spelling in ` +
        `this script's \`external\` list.`,
      { cause: err }
    );
  }
  assertExternalsArePackaged(specifiers);
  console.log(
    `  ✓ Bundle parses as ESM; all ${specifiers.length} runtime specifiers resolve and ship`
  );
}

/** The declared dependency versions this build reads pins against. */
type DeclaredDependencies = Record<string, string>;

/**
 * The three families of per-platform native binary the packaged app ships, and
 * what each one's `optionalDependencies` pin has to equal.
 *
 * All three are the same shape of hazard: a package whose only job is to carry
 * an executable for one platform, kept in step with a parent package by nothing
 * but somebody remembering. A skewed pin does not fail to install and does not
 * fail to package — it produces an app that starts and then cannot do one
 * particular thing:
 *
 * - **Claude Code** — the SDK spawns a binary from a different release than the
 *   protocol it speaks.
 * - **Codex** — same, one runtime over.
 * - **esbuild** — the loudest of the three: esbuild passes its own version to
 *   the binary and refuses outright when they differ, so every extension in the
 *   app stops compiling. Its pin is compared against the version esbuild
 *   actually resolves to rather than the range in `package.json`, because the
 *   repo root pins `esbuild` through a pnpm override — `^0.25.0`, which is what
 *   `apps/desktop` now declares too, so this package reads honestly on its own.
 *   (`apps/server` and `packages/cli` still say `^0.28.0` and are still
 *   overridden to 0.25.x; neither packages a binary, so neither is checked
 *   here.)
 *
 * Anything outside these prefixes is left alone: this is a rule about
 * per-platform binaries, not about optional dependencies in general.
 */
const PLATFORM_BINARY_FAMILIES: ReadonlyArray<{
  /** Package-name prefix the family's members share. */
  prefix: string;
  /** The pin a member must carry, given the name's platform suffix. */
  expected: (suffix: string, dependencies: DeclaredDependencies) => string | undefined;
  /** What the pin has to stay locked to, for the failure message. */
  lockedTo: string;
}> = [
  {
    prefix: '@anthropic-ai/claude-agent-sdk-',
    expected: (_suffix, dependencies) => dependencies['@anthropic-ai/claude-agent-sdk'],
    lockedTo: 'the @anthropic-ai/claude-agent-sdk dependency',
  },
  {
    prefix: '@openai/codex-',
    // Published as one package with per-platform versions rather than per-
    // platform packages, so these are npm aliases: `@openai/codex-darwin-arm64`
    // is `@openai/codex@<version>-darwin-arm64`.
    expected: (suffix, dependencies) => {
      const codex = dependencies['@openai/codex'];
      return codex ? `npm:@openai/codex@${codex}-${suffix}` : undefined;
    },
    lockedTo: 'the @openai/codex dependency',
  },
  {
    prefix: '@esbuild/',
    expected: () => esbuildVersion,
    lockedTo: 'the esbuild version this build resolved',
  },
];

/**
 * Assert every per-platform binary package is pinned to its parent's version.
 *
 * Checked here, in the build, because there is nowhere later that would notice:
 * `pnpm install` is happy to install a skewed pair, electron-builder packages
 * whatever it finds, and the symptom only appears in an installed app.
 *
 * @throws If any pin has drifted from what it is locked to.
 */
function assertPlatformBinariesLocked(): void {
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP_PKG, 'package.json'), 'utf-8')) as {
    dependencies?: DeclaredDependencies;
    optionalDependencies?: DeclaredDependencies;
  };
  const dependencies = pkg.dependencies ?? {};
  const problems: string[] = [];
  let checked = 0;

  for (const [name, pin] of Object.entries(pkg.optionalDependencies ?? {})) {
    const family = PLATFORM_BINARY_FAMILIES.find(({ prefix }) => name.startsWith(prefix));
    if (!family) continue;
    checked++;
    const expected = family.expected(name.slice(family.prefix.length), dependencies);
    if (expected === undefined) {
      problems.push(`  ${name} is pinned to "${pin}", but ${family.lockedTo} is not declared.`);
    } else if (pin !== expected) {
      problems.push(`  ${name} is pinned to "${pin}", but ${family.lockedTo} says "${expected}".`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `apps/desktop/package.json ships per-platform binaries whose versions have drifted ` +
        `from what they carry the executable for:\n\n${problems.join('\n')}\n\n` +
        `Update the optionalDependencies pins (and run pnpm install), or roll the parent back. ` +
        `A skewed pin packages green and only breaks in an installed app.`
    );
  }
  console.log(`  ✓ All ${checked} per-platform binary packages are version-locked`);
}

async function buildServer() {
  console.log('[1/2] Bundling server...');
  assertPlatformBinariesLocked();
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
  const outfile = path.join(OUT, 'server/server-entry.mjs');
  const result = await build({
    entryPoints: [path.join(DESKTOP_PKG, 'src/server-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
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
      // list above is pure JS and unaffected.
      requireExternalNativesPlugin(NATIVE_REQUIRE_EXTERNALS),
    ],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    sourcemap: true,
    // Consumed by verifyBundleLoadable below — the authoritative list of what
    // the emitted bundle still resolves at runtime.
    metafile: true,
  });

  // esbuild resolves by default (logLevel 'warning') to PRINT warnings and
  // exit 0. Everything this bundle can get wrong in a way that only shows up
  // in a packaged install arrives as a warning, so read them.
  //
  // Both gates run AFTER esbuild has already written the output, so a failure
  // must delete it: electron-builder packages whatever is in dist/, and a
  // rejected bundle sitting there is one `pnpm --filter @dorkos/desktop pack`
  // away from shipping. (Confirmed the hard way while building this gate — a
  // rejected bundle got packaged and died with "module is not defined in ES
  // module scope" at fork time, which is exactly the failure class here.)
  try {
    await assertNoUnexpectedWarnings(result.warnings);
    verifyBundleLoadable(outfile, result.metafile);
  } catch (err) {
    // The cleanup must never be able to replace the diagnosis: `rmSync` can
    // throw (EPERM, a file locked by another process — this build also runs on
    // the Windows release runner), and rethrowing THAT would bury which gate
    // actually failed. Swallow-and-report, then rethrow the original.
    try {
      rmSync(path.join(OUT, 'server'), { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(
        `[build-server] Could not remove the rejected bundle at ${path.join(OUT, 'server')} — ` +
          `delete it by hand before packaging, electron-builder would ship it:\n${String(cleanupErr)}`
      );
    }
    throw err;
  }

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

// Node ≥15 already exits non-zero on an unhandled rejection, but this build's
// failure semantics must not rest on a runtime default that a flag or a future
// Node can change — and the default's output (an UnhandledPromiseRejection
// dump) buries the actual cause under a stack nobody reads.
buildServer().catch((err: unknown) => {
  console.error(`\n[build-server] Server bundle FAILED:\n`);
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
