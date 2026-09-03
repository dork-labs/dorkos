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
import { parse as parseYaml } from 'yaml';

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

/** The declared dependency versions this build reads pins against. */
type DeclaredDependencies = Record<string, string>;

/**
 * The parts of `apps/desktop/package.json` the gates below read. Everything
 * electron-builder packs is derived from these two maps.
 */
interface DesktopManifest {
  dependencies?: DeclaredDependencies;
  optionalDependencies?: DeclaredDependencies;
}

/**
 * Read `apps/desktop/package.json`, the source of truth for what ships.
 *
 * @returns The parsed manifest.
 */
function readDesktopManifest(): DesktopManifest {
  return JSON.parse(
    readFileSync(path.join(DESKTOP_PKG, 'package.json'), 'utf-8')
  ) as DesktopManifest;
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
  const pkg = readDesktopManifest();
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

/**
 * The version `name` actually resolves to in this checkout — read from the copy
 * under the desktop package's own `node_modules`, which is the copy
 * electron-builder packs.
 *
 * Used by families whose parent is declared as a RANGE: comparing a
 * per-platform pin against `"^1.7.0"` compares it against something that is not
 * a version at all, so the pin is compared against what that range resolved to
 * instead. (Reading a sibling package's manifest rather than importing it is
 * the same trick `scripts/rebuild-natives.ts` uses to learn Electron's version,
 * and it never evaluates the package — see {@link verifyBundleLoadable} for why
 * this build must not.)
 *
 * @param name - Package name to look up.
 * @returns The installed version.
 * @throws If the package is not installed, since the pin cannot then be judged.
 */
function installedVersionOf(name: string): string {
  const manifest = path.join(DESKTOP_PKG, 'node_modules', name, 'package.json');
  try {
    return (JSON.parse(readFileSync(manifest, 'utf-8')) as { version: string }).version;
  } catch (err) {
    throw new Error(
      `Cannot read ${manifest}, so the per-platform binary pins for ${name} cannot be ` +
        `checked. Run pnpm install.`,
      { cause: err }
    );
  }
}

/**
 * The four families of per-platform native binary the packaged app ships, and
 * what each one's `optionalDependencies` pin has to equal.
 *
 * All four are the same shape of hazard: a package whose only job is to carry
 * one platform's binary, kept in step with a parent package by nothing but
 * somebody remembering. A skewed pin does not fail to install and does not fail
 * to package — it produces an app that starts and then cannot do one particular
 * thing:
 *
 * - **Claude Code** — the SDK spawns a binary from a different release than the
 *   protocol it speaks.
 * - **Codex** — same, one runtime over.
 * - **esbuild** — the loudest of the four: esbuild passes its own version to the
 *   binary and refuses outright when they differ, so every extension in the app
 *   stops compiling.
 * - **ngrok** — the odd one out, because it is `dlopen`ed rather than spawned:
 *   `@ngrok/ngrok` is a napi-rs addon whose JS loader `require`s the platform
 *   package for its `.node` file. napi keeps it ABI-stable across Node and
 *   Electron (so `scripts/rebuild-natives.ts` leaves it alone), but a JS loader
 *   and a binary from different releases still have to agree.
 *
 * esbuild and ngrok are pinned against the version their parent RESOLVED to
 * rather than the range `package.json` declares, because both parents are
 * declared as carets here and in the two other workspace packages that use them
 * — matching those keeps one copy of each in the tree, and the desktop app runs
 * the same server source `apps/server` does.
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
  {
    // Covers both spellings of ngrok's platform packages: darwin-arm64, and
    // win32-x64-msvc with the toolchain suffix napi-rs gives Windows targets.
    prefix: '@ngrok/ngrok-',
    expected: () => installedVersionOf('@ngrok/ngrok'),
    lockedTo: 'the @ngrok/ngrok version this install resolved',
  },
];

/**
 * The `asarUnpack` glob a per-platform binary package needs, verbatim.
 *
 * Compared by exact string equality, deliberately: electron-builder accepts
 * other spellings that unpack the same files, and teaching this gate to judge
 * glob equivalence would mean reimplementing its matcher. A functionally
 * equivalent glob written some other way therefore fails the build and asks
 * for this one — an error that costs a one-line edit, in the direction where
 * being wrong is safe. Silently accepting a glob that turns out not to match
 * is the direction that ships a broken app.
 *
 * @param name - The package name.
 * @returns The glob electron-builder.yml must contain for it.
 */
function unpackGlobFor(name: string): string {
  return `**/node_modules/${name}/**`;
}

/**
 * The package a `**\/node_modules/<name>/**` glob unpacks, or undefined for any
 * other glob (`dist/renderer/**`, `core-extensions/**`).
 *
 * The same verbatim-only reading as {@link unpackGlobFor}: this recognises the
 * one spelling this file writes, so an unrecognised glob is simply not judged
 * rather than judged wrongly.
 *
 * @param glob - One entry from electron-builder.yml's `asarUnpack` list.
 */
function packageNameFromUnpackGlob(glob: string): string | undefined {
  return /^\*\*\/node_modules\/(.+)\/\*\*$/.exec(glob)?.[1];
}

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
  const pkg = readDesktopManifest();
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
        `from the parent they carry a binary for:\n\n${problems.join('\n')}\n\n` +
        `Update the optionalDependencies pins (and run pnpm install), or roll the parent back. ` +
        `A skewed pin packages green and only breaks in an installed app.`
    );
  }
  console.log(`  ✓ All ${checked} per-platform binary packages are version-locked`);
}

/**
 * Names that read as "this package carries one platform's binary": a platform
 * token next to an architecture token, the same shape app-builder-lib itself
 * matches when it reports a platform package it could not bundle.
 *
 * `darwin-universal` is here because ngrok publishes a fat Mach-O under that
 * name; it carries no arch token and is deliberately never selected for a
 * specific target below.
 */
const PLATFORM_PACKAGE_NAME =
  /(linux|win32|darwin|freebsd|android)[-_](x64|arm64|ia32|arm|ppc64|s390x|loong64|riscv64|universal)/;

/** One platform/arch pair electron-builder.yml says this app is packaged for. */
interface PackagedTarget {
  /** Node's name for the platform (`darwin`, `win32`, `linux`). */
  platform: string;
  /** Architecture as electron-builder spells it (`arm64`, `x64`). */
  arch: string;
}

/** electron-builder.yml's platform keys, mapped to Node's platform names. */
const TARGET_PLATFORMS = [
  { key: 'mac', platform: 'darwin' },
  { key: 'win', platform: 'win32' },
  { key: 'linux', platform: 'linux' },
] as const;

/**
 * The shape of electron-builder.yml this build reads. Only the two keys the
 * gates below need — everything else in that file is electron-builder's.
 */
interface BuilderConfig {
  asarUnpack?: string[];
  mac?: { target?: { arch?: string[] }[] };
  win?: { target?: { arch?: string[] }[] };
  linux?: { target?: { arch?: string[] }[] };
}

/**
 * Read `electron-builder.yml`.
 *
 * @returns The parsed packaging config.
 */
function readBuilderConfig(): BuilderConfig {
  return parseYaml(
    readFileSync(path.join(DESKTOP_PKG, 'electron-builder.yml'), 'utf-8')
  ) as BuilderConfig;
}

/**
 * Every platform/arch this app is actually packaged for, read from the same
 * `target` blocks electron-builder builds from.
 *
 * Derived rather than hardcoded so that adding an arch (mac x64, win32-arm64,
 * a linux target) immediately demands that arch's binary from every family,
 * instead of packaging green and shipping a target with no tools in it.
 *
 * @param config - The parsed electron-builder config.
 * @returns One entry per platform/arch pair.
 */
function packagedTargets(config: BuilderConfig): PackagedTarget[] {
  // De-duplicated: mac lists arm64 twice (once for dmg, once for the zip
  // electron-updater installs from), and that is one target to check, not two.
  const pairs = new Set<string>();
  for (const { key, platform } of TARGET_PLATFORMS) {
    for (const target of config[key]?.target ?? []) {
      for (const arch of target.arch ?? []) pairs.add(`${platform}/${arch}`);
    }
  }
  return [...pairs].map((pair) => {
    const [platform, arch] = pair.split('/');
    return { platform, arch };
  });
}

/**
 * Every dependency that delegates its native binary to per-platform optional
 * packages, discovered by reading what each direct dependency declares about
 * itself rather than from a list maintained here.
 *
 * This is the half the prefix list in {@link PLATFORM_BINARY_FAMILIES} cannot
 * do. That list only describes packages someone already thought to add, so it
 * can police a family that is half-wired but is blind to one that is not wired
 * at all — which is the state BOTH shipped bugs were actually in (#1458 and
 * DOR-1335 each added the package.json entry and the asarUnpack glob in one
 * commit, because neither existed). Reading the dependency's own manifest
 * finds the family the moment it enters the tree, before anyone has written
 * anything here about it.
 *
 * What it can see: a parent whose own `optionalDependencies` name its platform
 * packages. All four families do (verified: claude-agent-sdk 8, ngrok 13,
 * codex 6, esbuild 18) — and today no other direct dependency does, so this
 * discovers exactly the four and nothing else.
 *
 * What it cannot see: a parent that resolves its binary some other way — a
 * postinstall download, a hardcoded sibling, a transitive package's optional
 * deps (only DIRECT dependencies are read; every family so far is one, because
 * the package holding the binary is what has to be declared here anyway). A
 * dependency that is not installed for this platform is skipped: it is a
 * platform leaf we already declare, never a parent, because a parent has to be
 * installed for the bundle to build at all.
 *
 * @param manifest - apps/desktop's own manifest.
 * @returns Parent package name -> the platform packages it names.
 */
function discoverPlatformFamilies(manifest: DesktopManifest): Map<string, string[]> {
  const families = new Map<string, string[]>();
  const direct = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  for (const name of direct) {
    let parent: { optionalDependencies?: Record<string, string> };
    try {
      parent = JSON.parse(
        readFileSync(path.join(DESKTOP_PKG, 'node_modules', name, 'package.json'), 'utf-8')
      ) as typeof parent;
    } catch {
      continue; // Not installed for this platform — a leaf we declare, not a parent.
    }
    const members = Object.keys(parent.optionalDependencies ?? {}).filter((member) =>
      PLATFORM_PACKAGE_NAME.test(member)
    );
    if (members.length > 0) families.set(name, members);
  }
  return families;
}

/**
 * Families whose per-platform binary this app deliberately does NOT ship.
 *
 * Deliberately EMPTY, and the same bar as {@link ALLOWED_WARNING_TEXTS}: an
 * entry here silences a real "this target ships without that tool" finding, so
 * it needs a comment saying why the packaged app does not need that binary —
 * a runtime that is provisioned on demand rather than bundled, say. "The build
 * went red" is not a reason; wiring the family up is the fix.
 */
const FAMILIES_NOT_SHIPPED: readonly string[] = [];

/**
 * Assert every per-platform binary family is wired all the way through, in
 * every direction that can silently ship a broken app:
 *
 * 1. **Every packaged target has a binary from every family** — the check that
 *    would have caught both historical bugs, and the reason the families are
 *    discovered ({@link discoverPlatformFamilies}) rather than listed.
 * 2. **Everything declared is also unpacked** — a package inside `app.asar` can
 *    be neither spawned nor `dlopen`ed, so declaring alone ships a binary
 *    nothing can open.
 * 3. **Everything unpacked is also declared** — a glob for a package that is
 *    not in the production tree unpacks nothing at all.
 * 4. **Everything declared has a pin rule** — otherwise
 *    {@link assertPlatformBinariesLocked} skips it in silence and its version
 *    is free to drift from the parent it carries the binary for.
 *
 * All four package green and fail only in an installed app.
 *
 * @throws If any family has a gap.
 */
function assertPlatformBinariesWired(): void {
  const manifest = readDesktopManifest();
  const declared = manifest.optionalDependencies ?? {};
  const config = readBuilderConfig();
  const asarUnpack = config.asarUnpack ?? [];
  const globs = new Set(asarUnpack);
  const families = discoverPlatformFamilies(manifest);
  const targets = packagedTargets(config);
  const problems: string[] = [];

  for (const [parent, members] of families) {
    if (FAMILIES_NOT_SHIPPED.includes(parent)) continue;
    for (const { platform, arch } of targets) {
      // Match the target against the member's NAME rather than constructing
      // one: every family spells its members differently (@esbuild/darwin-arm64,
      // @ngrok/ngrok-win32-x64-msvc with a toolchain suffix, @openai/codex-*
      // as an npm alias), and `<platform>-<arch>` as an adjacent, delimited
      // pair is the one thing all four agree on. Delimited so that an `arm`
      // target could never be answered by an `arm64` package, and adjacent so
      // `-darwin-universal` is not offered for a specific arch.
      const target = new RegExp(`${platform}[-_]${arch}([-_]|$)`);
      const candidates = members.filter((member) => target.test(member));
      // No candidate means the family publishes nothing for this target — a
      // real case (nobody builds freebsd here). It would also be how a family
      // that spelled its names the other way round read, which is one of the
      // things the packaged smoke exists to catch below this gate.
      if (candidates.length === 0) continue;
      if (candidates.some((m) => m in declared)) continue;
      problems.push(
        `  ${platform}-${arch} is packaged, but nothing from ${parent}'s per-platform family is ` +
          `declared for it. Add one of: ${candidates.join(', ')}.`
      );
    }
  }

  // Judged by NAME SHAPE, not by the prefix list: a member of a family nobody
  // has written a pin rule for yet is exactly the case that needs catching,
  // and filtering by the prefix list here would make the pin-rule check below
  // unreachable — it could only ever run on names that already matched one.
  for (const name of Object.keys(declared).filter((n) => PLATFORM_PACKAGE_NAME.test(n))) {
    if (!globs.has(unpackGlobFor(name))) {
      problems.push(
        `  ${name} is declared in package.json but electron-builder.yml has no ` +
          `'${unpackGlobFor(name)}' under asarUnpack — it would ship trapped inside app.asar.`
      );
    }
    if (!PLATFORM_BINARY_FAMILIES.some(({ prefix }) => name.startsWith(prefix))) {
      problems.push(
        `  ${name} is declared but matches no entry in PLATFORM_BINARY_FAMILIES, so nothing ` +
          `checks its version against the parent it carries a binary for. Add a pin rule.`
      );
    }
  }

  for (const glob of asarUnpack) {
    const name = packageNameFromUnpackGlob(glob);
    if (name === undefined || !PLATFORM_PACKAGE_NAME.test(name) || name in declared) continue;
    problems.push(
      `  '${glob}' unpacks ${name}, which package.json does not list under ` +
        `optionalDependencies — nothing would be there to unpack.`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `apps/desktop's per-platform binaries are not fully wired:\n\n${problems.join('\n')}\n\n` +
        `Every one of them needs BOTH an os/cpu-guarded optionalDependencies entry (which is ` +
        `what puts it where electron-builder's copier finds it) AND an asarUnpack glob (which ` +
        `is what makes it a real file on disk).`
    );
  }
  console.log(
    `  ✓ All ${families.size} per-platform binary families are wired for all ` +
      `${targets.length} packaged targets`
  );
}

async function buildServer() {
  console.log('[1/2] Bundling server...');
  assertPlatformBinariesLocked();
  assertPlatformBinariesWired();
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
