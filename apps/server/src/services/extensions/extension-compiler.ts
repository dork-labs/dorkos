import { build, version as esbuildVersion } from 'esbuild';
import type { BuildOptions } from 'esbuild';
import fs from 'fs/promises';
import path from 'path';

import { logger } from '../../lib/logger.js';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  buildStartTime,
  computeBuildKey,
  createInputRecorder,
  digestBuildInputs,
  digestFailedBuild,
  readCurrentManifest,
  snapshotSourceTree,
  shortHash,
  writeFileAtomic,
  writeBuildManifest,
  type BuildManifest,
  type CompilationError,
  type SourceDigest,
  type TreeSnapshot,
} from './extension-build-cache.js';

/** Bundle size threshold for warning log. Not a hard limit. */
const BUNDLE_SIZE_WARNING_KB = 500;

/** Stale cache entries older than 7 days are eligible for cleanup. */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The prose esbuild's native binary writes when it fails to READ a file OR
 * DIRECTORY because of the local environment, rather than anything about
 * the extension's source.
 *
 * This is **not** one template. esbuild's own string table (checked
 * directly against the `@esbuild/darwin-arm64` binary, and against its Go
 * source on GitHub for exactly which call sites are reachable) has four
 * read-failure openers that pair a verb (`Cannot`/`Failed to`) with a noun
 * (`file`/`directory`), each followed by `: ` and Go's raw `strerror()`
 * text for the underlying OS error — never an OS errno symbol like
 * `EMFILE`. The pattern below matches the opener and the noun
 * independently of the errno text, so it does not have to be extended
 * every time a fifth phrasing turns up.
 *
 * What's actually reachable in `errors[]` under our `build()` calls
 * (`logLevel: 'silent'`, no plugins), confirmed by reading esbuild's Go
 * source, not just its output:
 *
 * - `Cannot read file %q: %s` — the entry point itself. Empirically
 *   verified: `chmod 000` on the entry point (real esbuild, no mock) in
 *   `__tests__/extension-compiler-real-esbuild.test.ts`. `location: null`
 *   — nothing to point at, since esbuild never got to open the file that
 *   would anchor a position.
 * - `Cannot read file %q: %s` for a file the entry point IMPORTS —
 *   verified the same way. This time `location` points at the `import`
 *   statement in the (perfectly readable) file that referenced it: esbuild
 *   has a real source position for *that* failure, it just can't read
 *   what's on the other end. So `location` is present in one case and
 *   absent in the other for the identical message template — matching
 *   MUST NOT require its absence.
 * - `Cannot read directory %q: %s` — esbuild's resolver batches file-
 *   existence checks by reading a directory's listing once rather than
 *   `stat`-ing each candidate name (`resolver.go`'s `loadAsFile`, called
 *   while resolving the entry point itself — before opening any file).
 *   Empirically verified: `chmod 0111` (execute-only — the directory can
 *   still be traversed into by a known filename, so the test isolates
 *   esbuild's own directory read) on a ZERO-import
 *   entry point's own directory rejects with a `BuildFailure` carrying a
 *   POPULATED, two-entry `errors[]`: `Cannot read directory %q: %s`
 *   alongside a `Could not resolve %q` for the entry point itself (both
 *   `location: null`). A *second*, separately-cached directory read
 *   exists too — `resolver.go`'s `dirInfoUncached`, used for
 *   `package.json`/`node_modules`/tsconfig lookups — but it explicitly
 *   swallows `EACCES`/`EPERM` ("just pretend this directory is empty"),
 *   so it does not fire under this fixture's permission-based repro; it
 *   would under a real `EMFILE`/`ENOSPC`, which that swallow does not
 *   cover. Either way, a directory read happens before any file read,
 *   for every build, even one with zero imports — this is the likely
 *   shape of a real file-descriptor-exhaustion hit on a file the resolver
 *   still has an fd budget for, not an edge case.
 *
 * Two more openers exist in the binary but were traced through esbuild's
 * Go source rather than triggered live, and are matched here defensively:
 *
 * - `Failed to read file %q: %s` / `Failed to read directory %q: %s` —
 *   every call site found across `internal/resolver/resolver.go`,
 *   `package_json.go`, and `yarnpnp.go` reaches only
 *   `r.debugLogs.addNote(...)`, gated behind `r.debugLogs != nil`; two more
 *   in `internal/bundler/bundler.go` reach `s.log.AddID(..., logger.Debug,
 *   ...)` instead, gated by log *severity* rather than that nil check.
 *   Both mechanisms land on the same outcome under our usage: `logLevel:
 *   'silent'` means no debug logger is ever created and `Debug`-severity
 *   messages are always filtered, so this text cannot currently reach
 *   `errors[]` by either path — every corresponding user-facing error at
 *   those same call sites uses `Cannot read` instead. Included anyway in
 *   case a future esbuild version — or a call site this trace missed —
 *   promotes it to a real error.
 *
 * Deliberately NOT matched: `Cannot read file: %s` (no quoted path).
 * Traced to two call sites in `internal/bundler/bundler.go`, both firing
 * only for `err == syscall.ENOENT` with `%s` substituted with the file's
 * PATH, not `err.Error()` — there is no errno text to match here at all,
 * and one of the two is `MsgID_SourceMap_MissingSourceMap` at `Warning`
 * severity (never reaches `.errors`). ENOENT there means "this path,
 * already resolved once, no longer exists" — a different question from
 * the resource-exhaustion failures this pattern targets, and one an
 * errno-suffix regex cannot answer without also matching an ordinary
 * missing-file path.
 */
const ESBUILD_IO_FAILURE_PATTERNS: RegExp[] = [
  /(?:Cannot|Failed to) read (?:file|directory) ".*?": (?:too many open files(?: in system)?|permission denied|no space left on device|cannot allocate memory|input\/output error)/,
];

/**
 * Decide whether a thrown esbuild error reflects a problem with the local
 * environment — a missing native binary, exhausted file descriptors, a
 * full disk, an out-of-memory condition, a permission error — rather than
 * the extension's own source.
 *
 * This is a two-part test, because esbuild surfaces environment failures
 * two different ways depending on *when* they happen:
 *
 * 1. **Before esbuild's binary even starts, when `build()`'s promise still
 *    rejects cleanly** — the `@esbuild/<platform>` package is missing
 *    (`generateBinPath()` in esbuild's own `lib/main.js`): rejects with a
 *    plain `Error` that has no `errors` array at all. Caught by the shape
 *    check below.
 * 2. **While esbuild's binary is running but can't read a file OR
 *    directory** — the entry point itself, its containing directory (read
 *    before any file — see {@link ESBUILD_IO_FAILURE_PATTERNS}), or
 *    anything it imports — because of `EMFILE`, `ENOSPC`, `ENOMEM`,
 *    `EACCES`, or similar: rejects with a real `BuildFailure` carrying a
 *    POPULATED `errors[]` — the same shape a genuine compile error has,
 *    with or without a `location` depending on which path could not be
 *    read. Shape alone cannot tell this apart from a real error; only the
 *    message text can.
 *
 * Either way, the failure is not a deterministic property of the
 * extension's source, so caching it would brick the extension on
 * every future start — including after the environment recovers — for a
 * problem the extension author never had a chance to cause.
 *
 * **A suspected gap this function cannot close**, because it never runs
 * for it: when `child_process.spawn` itself fails — the calling process's
 * OWN file descriptors are exhausted, as opposed to the platform package
 * being absent — esbuild's `lib/main.js` calls `child.stdin.on('error',
 * ...)` before `child.on('error', ...)`. On the platforms where libuv
 * returns `UV_EMFILE`/`UV_ENFILE` from `uv_spawn`, Node returns early
 * without wiring the stdio streams, leaving `child.stdin` as `null`, so
 * that first line throws and the second never registers. The child's
 * async `error` event is then unhandled, which Node treats as fatal, and
 * this codebase's own `uncaughtException` handler
 * (`apps/server/src/index.ts`) answers with `process.exit(1)` — the whole
 * server, not just the extension subsystem.
 *
 * This path is reasoned from the sources, NOT reproduced: on macOS with
 * Node 24 and an exhausted descriptor table, the observed failure is a
 * *synchronous* `spawn EBADF`, which propagates out of the `build(...)`
 * call expression into `runBuild`'s own `try` and is handled here as an
 * ordinary environment failure. Treat the fatal variant as platform-
 * dependent and unverified rather than as established behavior. Per-
 * process fd limits mean the DorkOS server exhausting its own descriptors
 * does not also exhaust the esbuild child's (it gets a fresh table), so
 * this is specifically about the fd pressure at the moment of `spawn()`
 * itself, not pressure inside the compiled child process. No mitigation
 * for this ships in this file; a pre-flight warm build at server startup
 * (while descriptors are plentiful, to populate esbuild's cached
 * `longLivedService` before the pressure that would otherwise hit
 * `spawn()`) was considered and deliberately deferred rather than rushed
 * in alongside everything else here — tracked as a follow-up.
 *
 * A deliberate tradeoff on the part this function DOES cover: it also
 * classifies a PERMANENTLY unreadable file (a root-owned leftover from a
 * broken install, a `chmod 000` file shipped inside a package) as an
 * environment failure forever, since nothing here can tell "permanently
 * broken" apart from "broken right now." That extension pays a full
 * esbuild invocation (bounded, roughly 20-90ms) on every boot instead of
 * replaying a cached error — worse than ideal, but the right side to be
 * wrong on: the alternative is exactly the bricking bug this file exists
 * to fix, just for a narrower trigger.
 *
 * @param err - The value esbuild's `build()` rejected with.
 * @returns `true` when `err` describes the environment, not the source.
 */
function isEnvironmentFailure(err: unknown): boolean {
  const esbuildErr = err as { errors?: Array<{ text: string; location?: unknown }> };
  if (!Array.isArray(esbuildErr.errors) || esbuildErr.errors.length === 0) {
    return true;
  }
  return esbuildErr.errors.some((e) => ESBUILD_IO_FAILURE_PATTERNS.some((p) => p.test(e.text)));
}

/**
 * Build the error result for an unexpected filesystem failure outside of
 * esbuild itself — reading a pre-compiled entry file, persisting a compiled
 * or pre-compiled bundle to cache. `what` names the operation that failed
 * (e.g. `'read the entry point'`, `'cache the pre-compiled bundle'`) so the
 * message reflects what actually broke rather than always claiming
 * "compilation failed."
 *
 * Nothing here is ever cached: there is no point persisting an error about
 * a file that could not be read or a directory that just proved it can't
 * be written to.
 *
 * Reuses {@link isEnvironmentFailure} for the log framing rather than
 * assuming: a plain Node `fs` error (`EACCES`, `EMFILE`, `ENOENT`, ...) has
 * no `errors` array, so the shape check already classifies it as an
 * environment failure in every realistic case — asking the question
 * explicitly, instead of hardcoding the answer, keeps this on the same
 * decision {@link handleEsbuildError} makes rather than a second, silently
 * divergent one.
 *
 * @param extId - Extension identifier.
 * @param err - The value the failed filesystem operation rejected with.
 * @param what - What the compiler was trying to do (used in the message).
 * @param prefix - Optional prefix for log messages (e.g. `'Server '`).
 * @returns A structured error describing the failure.
 */
function buildIoFailureError(
  extId: string,
  err: unknown,
  what: string,
  prefix = ''
): CompilationError {
  const message = err instanceof Error ? err.message : String(err);
  const framing = isEnvironmentFailure(err) ? ' (not cached — will retry next compile)' : '';
  logger.error(`[Extensions] ${prefix}Could not ${what} for ${extId}${framing}: ${message}`);
  return {
    code: 'compilation_failed',
    message: `${prefix}Could not ${what} for ${extId}`,
    errors: [{ text: message }],
  };
}

/** The result of compiling one bundle: its code, or the error that stopped it. */
type CompileResult =
  { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string };

/**
 * One kind of bundle the compiler produces. The options object is the whole
 * build configuration apart from the entry point, and it is hashed into every
 * cache key, so changing any option here invalidates every cached build of
 * that kind.
 */
interface BuildTarget {
  /** Cache subdirectory under the cache root, or `null` for the root itself. */
  subDir: string | null;
  /** Log and error-message prefix (`''` or `'Server '`). */
  prefix: string;
  /** What the output is called in log lines. */
  noun: string;
  /** Every esbuild option except the entry point and working directory. */
  options: Omit<BuildOptions, 'entryPoints' | 'absWorkingDir' | 'metafile'>;
}

/** Browser ESM bundle the client `import()`s. */
const CLIENT_TARGET: BuildTarget = {
  subDir: null,
  prefix: '',
  noun: 'bundle',
  options: {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom', '@dorkos/extension-api'],
    write: false,
    minify: false,
    sourcemap: 'inline',
    logLevel: 'silent',
    // Allow JSX in .ts files — extensions commonly use JSX without .tsx rename
    loader: { '.ts': 'tsx' },
  },
};

/**
 * Node CJS bundle loaded with `require()`. Externals are provided by the host
 * process.
 */
const SERVER_TARGET: BuildTarget = {
  subDir: 'server',
  prefix: 'Server ',
  noun: 'server bundle',
  options: {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['express', '@dorkos/extension-api', '@dorkos/extension-api/server'],
    write: false,
    minify: false,
    sourcemap: 'inline',
    logLevel: 'silent',
    loader: { '.ts': 'tsx' },
  },
};

/** Where one build's cache entries live, and the key for its configuration. */
interface BuildContext {
  extId: string;
  entryPath: string;
  extRoot: string;
  target: BuildTarget;
  cacheDir: string;
  manifestPath: string;
  buildKey: string;
  cwd: string;
}

/** Per-build state: when it started, the tree before it, and what esbuild read. */
interface BuildRun {
  startedAt: number;
  snapshot: TreeSnapshot | null;
  recorder: ReturnType<typeof createInputRecorder>;
}

/**
 * Compiles TypeScript extensions with esbuild and serves pre-compiled JS extensions.
 *
 * A compiled bundle is cached as `{extensionId}.{hash}.js`, where the hash is
 * the first 16 hex characters of the SHA-256 of the bundle itself. Whether
 * that bundle is still current is decided by a manifest beside it
 * (`{extensionId}.{entryHash}.manifest.json`, see `extension-build-cache.ts`)
 * that lists every file the build read, so an update that only changes an
 * imported module is rebuilt too (DOR-2491). The returned `sourceHash` is the
 * bundle's hash: it changes exactly when the served code does.
 */
export class ExtensionCompiler {
  private cacheDir: string;

  constructor(dorkHome: string) {
    this.cacheDir = path.join(dorkHome, 'cache', 'extensions');
  }

  /**
   * Compile a client-side extension (or return cached bundle).
   *
   * @param record - Extension record with path to source directory
   * @returns Object with `code` (compiled JS string) on success, or `error` on failure.
   *          Also returns the `sourceHash` for cache keying.
   */
  async compile(record: ExtensionRecord): Promise<CompileResult> {
    const entryResult = await this.resolveEntryPoint(record.path);
    if ('error' in entryResult) {
      return { error: entryResult.error, sourceHash: '' };
    }

    const { entryPath, isPrecompiled } = entryResult;
    if (!isPrecompiled) {
      return this.compileCached(record.id, entryPath, record.path, CLIENT_TARGET);
    }

    let source: string;
    try {
      source = await fs.readFile(entryPath, 'utf-8');
    } catch (err) {
      return { error: buildIoFailureError(record.id, err, 'read the entry point'), sourceHash: '' };
    }
    return this.handlePrecompiled(record.id, source, shortHash(source));
  }

  /**
   * Compile a server-side extension entry point for Node.js.
   *
   * Uses CJS format for dynamic `require()` loading. Externals include express
   * and extension-api packages (provided by the host process).
   *
   * @param record - Extension record with serverEntryPath
   * @returns Compiled code and hash on success, or error on failure
   */
  async compileServer(record: ExtensionRecord): Promise<CompileResult> {
    if (!record.serverEntryPath) {
      return {
        error: {
          code: 'compilation_failed',
          message: 'No server entry point found',
          errors: [{ text: 'Extension has no serverEntryPath' }],
        },
        sourceHash: '',
      };
    }
    return this.compileCached(record.id, record.serverEntryPath, record.path, SERVER_TARGET);
  }

  /**
   * Read a cached bundle by extension ID and source hash.
   * Used by the bundle serving endpoint.
   *
   * @param extId - Extension identifier
   * @param sourceHash - The hash {@link compile} returned for this bundle
   */
  async readBundle(extId: string, sourceHash: string): Promise<string | null> {
    const cachedPath = path.join(this.cacheDir, `${extId}.${sourceHash}.js`);
    if (!cachedPath.startsWith(this.cacheDir + path.sep)) {
      throw new Error('Attempted path escape in cache lookup');
    }
    try {
      return await fs.readFile(cachedPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Clean stale cache entries not accessed in 7+ days.
   * Called on server startup. Cleans both client and server cache directories.
   *
   * This is also what retires cache files an older DorkOS wrote (bundles and
   * `.error.json` files keyed by the entry file alone): nothing reads them
   * any more, so they age out here like any other unused entry.
   *
   * A `readdir` failure — the directory doesn't exist yet (normal, nothing
   * to clean), or a transient EMFILE/EACCES under exactly the resource
   * pressure this whole file exists to tolerate — skips that subdirectory
   * for this pass rather than throwing: this runs first in
   * {@link ExtensionManager.initialize}, before discovery even starts, so
   * letting it throw would take the entire extension system down over a
   * best-effort cleanup step.
   *
   * @returns Number of entries cleaned
   */
  async cleanStaleCache(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const subDir of [this.cacheDir, path.join(this.cacheDir, 'server')]) {
      let entries: string[];
      try {
        entries = await fs.readdir(subDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            `[Extensions] Could not read ${subDir} for stale-cache cleanup: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
        continue;
      }

      for (const entry of entries) {
        const filePath = path.join(subDir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile() && now - stat.atimeMs > STALE_THRESHOLD_MS) {
            await fs.unlink(filePath);
            cleaned++;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }

    if (cleaned > 0) {
      logger.info(`[Extensions] Cleaned ${cleaned} stale cache entries`);
    }
    return cleaned;
  }

  /**
   * Resolve the entry point file for an extension directory.
   *
   * Priority: index.js (pre-compiled) > index.ts (compile) > error
   */
  private async resolveEntryPoint(
    extPath: string
  ): Promise<{ entryPath: string; isPrecompiled: boolean } | { error: CompilationError }> {
    const jsPath = path.join(extPath, 'index.js');
    const tsPath = path.join(extPath, 'index.ts');

    try {
      await fs.access(jsPath);
      return { entryPath: jsPath, isPrecompiled: true };
    } catch {
      // No pre-compiled JS, check for TypeScript
    }

    try {
      await fs.access(tsPath);
      return { entryPath: tsPath, isPrecompiled: false };
    } catch {
      return {
        error: {
          code: 'compilation_failed',
          message: 'No entry point found (index.js or index.ts)',
          errors: [{ text: 'No index.js or index.ts found in extension directory' }],
        },
      };
    }
  }

  /**
   * Handle a pre-compiled JS extension — cache for consistent serving.
   *
   * A pre-compiled `index.js` is served as-is, never bundled, so the file's
   * own bytes are everything the served code depends on and its content hash
   * is a complete key.
   *
   * Unlike TypeScript compilation, caching here is NOT an optimization:
   * `applyCompileResult` (`extension-manager.ts`) keeps only `sourceHash`
   * and `bundleReady` from a successful result and discards `code` — the
   * bundle is served later, from disk, by {@link readBundle}. Nothing else
   * ever holds onto the in-memory `source` this method was handed. So a
   * failed write here MUST be reported as an error, not swallowed into a
   * success: reporting success while the disk write failed would produce
   * an extension the UI shows as `compiled`/`bundleReady: true` whose
   * bundle then 404s the moment anything actually asks for it — silently
   * broken, worse than a visible `compile_error`.
   */
  private async handlePrecompiled(
    extId: string,
    source: string,
    sourceHash: string
  ): Promise<CompileResult> {
    await this.ensureCacheDir();
    const cachedPath = path.join(this.cacheDir, `${extId}.${sourceHash}.js`);

    try {
      await fs.access(cachedPath);
      const cached = await fs.readFile(cachedPath, 'utf-8');
      return { code: cached, sourceHash };
    } catch {
      // Cache miss — persist it. This IS the delivery mechanism.
    }

    try {
      await fs.writeFile(cachedPath, source, 'utf-8');
      return { code: source, sourceHash };
    } catch (err) {
      return {
        error: buildIoFailureError(extId, err, 'cache the pre-compiled bundle'),
        sourceHash,
      };
    }
  }

  /**
   * Return the cached build of `entryPath` when its manifest says it is still
   * current, or build it fresh.
   *
   * The manifest file is named by the entry point's path, so two copies of
   * one extension (an installed one and a marketplace staging copy, say)
   * never overwrite each other's record.
   */
  private async compileCached(
    extId: string,
    entryPath: string,
    extRoot: string,
    target: BuildTarget
  ): Promise<CompileResult> {
    const cacheDir = target.subDir ? path.join(this.cacheDir, target.subDir) : this.cacheDir;
    await this.ensureCacheDir(cacheDir);
    const cwd = process.cwd();
    const ctx: BuildContext = {
      extId,
      entryPath,
      extRoot,
      target,
      cacheDir,
      manifestPath: path.join(cacheDir, `${extId}.${shortHash(entryPath)}.manifest.json`),
      buildKey: computeBuildKey(esbuildVersion, cwd, target.options),
      cwd,
    };

    const check = await readCurrentManifest(ctx.manifestPath, ctx.buildKey, entryPath);
    if ('current' in check) {
      const { key, outcome } = check.current;
      if (outcome.kind === 'error') {
        logger.debug(`[Extensions] ${target.prefix}Cached error for ${extId} (${key})`);
        return { error: outcome.error, sourceHash: key };
      }
      try {
        const code = await fs.readFile(this.bundlePath(cacheDir, extId, key), 'utf-8');
        logger.debug(`[Extensions] ${target.prefix}Cache hit for ${extId} (${key})`);
        return { code, sourceHash: key };
      } catch {
        // The manifest outlived its bundle (stale-cache cleanup): rebuild.
      }
    } else {
      logger.debug(`[Extensions] ${target.prefix}Rebuilding ${extId}: ${check.stale}`);
    }

    return this.runBuild(ctx);
  }

  /**
   * Run esbuild, cache the bundle under its content hash, and record the
   * files it was built from.
   *
   * What gets recorded is what esbuild actually consumed: the input recorder
   * hashes each file's bytes as esbuild reads them, and the extension's tree
   * is snapshotted before the build starts. So an edit that lands while the
   * build runs leaves a manifest that no longer matches, and the next load
   * rebuilds, instead of vouching for the old bundle (DOR-2491 review).
   *
   * Two separate `try` blocks, deliberately: a failure from `build()`
   * itself goes through {@link handleEsbuildError} and is worded as a
   * compilation failure, because it is one. A failure writing the
   * already-successful result to cache is a DIFFERENT failure — esbuild
   * did its job — and must not be reported as "Compilation failed for
   * <id>" with a confusing `ENOENT: ... open '<cache path>'` underneath
   * it; {@link buildIoFailureError} words it as what it actually is.
   *
   * A manifest that cannot be written costs only speed: the bundle is on
   * disk and served, and the next load, finding no current manifest, builds
   * again.
   */
  private async runBuild(ctx: BuildContext): Promise<CompileResult> {
    const { extId, target } = ctx;
    const run: BuildRun = {
      startedAt: buildStartTime(),
      snapshot: await snapshotSourceTree(ctx.extRoot, this.cacheDir),
      recorder: createInputRecorder(),
    };
    let code: string;
    let inputs: Record<string, unknown> | undefined;
    try {
      const result = await build({
        ...target.options,
        entryPoints: [ctx.entryPath],
        absWorkingDir: ctx.cwd,
        metafile: true,
        plugins: [run.recorder.plugin],
      });
      code = result.outputFiles?.[0]?.text ?? '';
      inputs = result.metafile?.inputs;
    } catch (err) {
      return this.handleEsbuildError(ctx, run, err);
    }

    const sizeKb = Buffer.byteLength(code, 'utf-8') / 1024;
    if (sizeKb > BUNDLE_SIZE_WARNING_KB) {
      logger.warn(
        `[Extensions] ${target.prefix}Bundle for ${extId} is ${sizeKb.toFixed(0)}KB (exceeds ${BUNDLE_SIZE_WARNING_KB}KB guideline)`
      );
    }

    const key = shortHash(code);
    try {
      await writeFileAtomic(this.bundlePath(ctx.cacheDir, extId, key), code);
    } catch (err) {
      return {
        error: buildIoFailureError(extId, err, 'cache the compiled bundle', target.prefix),
        sourceHash: key,
      };
    }
    logger.info(`[Extensions] Compiled ${target.noun} for ${extId} (${sizeKb.toFixed(1)}KB)`);

    const digest = inputs
      ? await digestBuildInputs(inputs, ctx.cwd, run.recorder.hashes, run.snapshot)
      : null;
    if (digest) {
      await this.persistManifest(ctx, run, key, digest, { kind: 'bundle' });
    } else {
      logger.warn(
        `[Extensions] Could not record the files ${extId}'s ${target.noun} was built from; ` +
          `it will be rebuilt on the next load`
      );
    }
    return { code, sourceHash: key };
  }

  /**
   * Handle an esbuild compilation error: cache it and return a structured
   * error result — unless {@link isEnvironmentFailure} says the failure
   * describes the local environment rather than the extension's source, in
   * which case nothing is cached so the next compile attempt (the next
   * start, or the next `reload_extensions`) tries fresh instead of
   * replaying a one-time environment hiccup forever.
   *
   * A failed build has no metafile, so a genuine error is cached against the
   * extension's whole source tree as it was before the build
   * ({@link digestFailedBuild}): editing any file in it, or adding the module
   * an import was missing, rebuilds. A tree too large to snapshot is not
   * cached; the next compile simply runs esbuild again.
   */
  private async handleEsbuildError(
    ctx: BuildContext,
    run: BuildRun,
    err: unknown
  ): Promise<{ error: CompilationError; sourceHash: string }> {
    const { extId, target } = ctx;
    const prefix = target.prefix;
    const esbuildErr = err as {
      errors?: Array<{
        text: string;
        location?: { file: string; line: number; column: number } | null;
      }>;
    };

    const compilationError: CompilationError = {
      code: 'compilation_failed',
      message: `${prefix}Compilation failed for ${extId}`,
      errors: esbuildErr.errors?.map((e) => ({
        text: e.text,
        location: e.location
          ? { file: e.location.file, line: e.location.line, column: e.location.column }
          : undefined,
      })) ?? [{ text: err instanceof Error ? err.message : 'Unknown compilation error' }],
    };

    if (isEnvironmentFailure(err)) {
      logger.error(
        `[Extensions] ${prefix}Compilation failed for ${extId} (environment failure, not ` +
          `cached — will retry next compile): ${compilationError.errors[0]?.text}`
      );
      return { error: compilationError, sourceHash: '' };
    }

    const key = shortHash(JSON.stringify(compilationError));
    const digest = run.snapshot ? await digestFailedBuild(run.snapshot, run.recorder.hashes) : null;
    if (digest) {
      await this.persistManifest(ctx, run, key, digest, {
        kind: 'error',
        error: compilationError,
      });
    }

    logger.error(
      `[Extensions] ${prefix}Compilation failed for ${extId}: ${compilationError.errors[0]?.text}`
    );
    return { error: compilationError, sourceHash: key };
  }

  /**
   * Write a build's manifest. Never throws: a manifest that fails to write
   * (a full disk) only means the next load rebuilds. A manifest from a build
   * that started later than this one is left in place.
   */
  private async persistManifest(
    ctx: BuildContext,
    run: BuildRun,
    key: string,
    digest: SourceDigest,
    outcome: BuildManifest['outcome']
  ): Promise<void> {
    try {
      const written = await writeBuildManifest(ctx.manifestPath, {
        buildKey: ctx.buildKey,
        entryPath: ctx.entryPath,
        startedAt: run.startedAt,
        key,
        files: digest.files,
        dirs: digest.dirs,
        absent: digest.absent,
        outcome,
      });
      if (!written) {
        logger.debug(`[Extensions] Kept the record of a newer build of ${ctx.extId}`);
      }
    } catch (err) {
      logger.warn(
        `[Extensions] Could not record the build of ${ctx.extId}; it will be rebuilt on the ` +
          `next load: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Path of a cached bundle. */
  private bundlePath(cacheDir: string, extId: string, key: string): string {
    return path.join(cacheDir, `${extId}.${key}.js`);
  }

  /**
   * Ensure a cache directory exists (the client-side root by default, or an
   * explicit `dir` — used for the `server/` subdirectory). Never throws: a
   * failure (a full disk, exhausted file descriptors) is logged and
   * swallowed rather than propagated, so callers degrade to operating
   * without a persistent cache for this attempt instead of crashing. A
   * downstream read against a still-missing directory reports a harmless
   * cache miss; a downstream write fails the same way and is handled as
   * its own clearly-worded failure by whichever caller made it — see
   * {@link buildIoFailureError} and its use in {@link handlePrecompiled}
   * and {@link runBuild}.
   *
   * @param dir - The directory to create. Defaults to the client-side cache root.
   */
  private async ensureCacheDir(dir: string = this.cacheDir): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      logger.warn(
        `[Extensions] Could not prepare cache directory ${dir}; continuing without a ` +
          `persistent cache for this attempt: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
