import { build } from 'esbuild';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { logger } from '../../lib/logger.js';
import type { ExtensionRecord } from '@dorkos/extension-api';

/** Structured compilation error written to cache as `.error.json`. */
interface CompilationError {
  code: 'compilation_failed';
  message: string;
  errors: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
}

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
 *   still be traversed into by a known filename, so this does not confound
 *   the two `fs.readFile` calls `compile()`/`compileServer()` make before
 *   esbuild runs, which need no `readdir` permission) on a ZERO-import
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
 * Text a *Node-thrown* error (not esbuild's own `BuildFailure`) could have
 * carried before {@link isEnvironmentFailure} existed and this file always
 * cached whatever it caught. Node's own errors — a failed `spawn()` when
 * launching esbuild's helper process, `generateBinPath()`'s "package could
 * not be found" when `@esbuild/<platform>` is missing — use OS errno
 * symbols and different prose than esbuild's Go binary does.
 *
 * These never fire on a *live* classification: a Node-thrown error has no
 * `errors` array at all, so {@link isEnvironmentFailure}'s shape check
 * already keeps it out of the cache before any text is examined. They
 * exist solely to evict a `.error.json` a pre-fix build wrote for one of
 * these — the file has no shape signal left once serialized to JSON, only
 * text. Unlike {@link ESBUILD_IO_FAILURE_PATTERNS}, matching still requires
 * an absent `location`: a raw errno symbol like `EMFILE` is common enough
 * in arbitrary text that a genuine compile error's source position is
 * worth keeping as a corroborating signal here.
 */
const LEGACY_NODE_THROWN_ERROR_PATTERNS: RegExp[] = [
  /could not be found, and is needed by esbuild/i,
  /installed esbuild for another platform/i,
  /\bEMFILE\b/,
  /\bENFILE\b/,
  /\bENOENT\b/,
  /\bENOMEM\b/,
  /\bENOSPC\b/,
  /\bEACCES\b/,
];

/**
 * Test a set of esbuild-shaped error entries for a message matching any of
 * `patterns`, irrespective of `location`.
 *
 * @param errors - Error entries from either a raw esbuild rejection or a
 *   parsed `.error.json` cache file.
 * @param patterns - Regexes to test each entry's text against.
 * @returns `true` when at least one entry matches.
 */
function hasTextMatch(errors: Array<{ text: string }>, patterns: RegExp[]): boolean {
  return errors.some((e) => patterns.some((p) => p.test(e.text)));
}

/**
 * Test a set of esbuild-shaped error entries for a LOCATION-LESS message
 * matching any of `patterns`.
 *
 * @param errors - Error entries from either a raw esbuild rejection or a
 *   parsed `.error.json` cache file.
 * @param patterns - Regexes to test each location-less entry's text against.
 * @returns `true` when at least one entry matches.
 */
function hasLocationlessTextMatch(
  errors: Array<{ text: string; location?: unknown }>,
  patterns: RegExp[]
): boolean {
  return errors.some((e) => !e.location && patterns.some((p) => p.test(e.text)));
}

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
 * extension's content hash, so caching it would brick the extension on
 * every future start — including after the environment recovers — for a
 * problem the extension author never had a chance to cause.
 *
 * **A known gap this function cannot close**, because it never runs for
 * it: when `child_process.spawn` itself fails — the calling process's OWN
 * file descriptors are exhausted, as opposed to the platform package
 * being absent — esbuild's `lib/main.js` calls `child.stdin.on('error',
 * ...)` on a `ChildProcess` whose stdio streams were never wired up
 * (`child.stdin` is `undefined` when `spawn()` fails), which throws
 * synchronously rather than producing a normal promise rejection. That
 * becomes an unhandled `error` event, which Node treats as fatal, which
 * this codebase's own `uncaughtException` handler
 * (`apps/server/src/index.ts`) currently answers with `process.exit(1)` —
 * the whole server, not just the extension subsystem, before `build()`'s
 * promise ever settles and before this file gets a chance to run. Per-
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
  return hasTextMatch(esbuildErr.errors, ESBUILD_IO_FAILURE_PATTERNS);
}

/**
 * Detect a cached compile error, written before {@link isEnvironmentFailure}
 * existed, that actually describes an environment problem rather than a
 * defect in the extension's own source.
 *
 * Checks the cached entries' text against both pattern sets
 * {@link isEnvironmentFailure} would now classify live —
 * {@link ESBUILD_IO_FAILURE_PATTERNS}, for the file/directory-read-failure
 * case a plain shape check cannot catch even on a *live* classification —
 * plus {@link LEGACY_NODE_THROWN_ERROR_PATTERNS} for the Node-thrown case,
 * whose shape signal (no `errors` array) does not survive being written to
 * and re-read from JSON.
 *
 * @param cached - The parsed contents of a cached `.error.json` file.
 * @returns `true` when the cached error looks like a stale environment
 *   failure rather than a real, still-current compile error.
 */
function isLegacyTransientCachedError(cached: CompilationError): boolean {
  return (
    hasTextMatch(cached.errors, ESBUILD_IO_FAILURE_PATTERNS) ||
    hasLocationlessTextMatch(cached.errors, LEGACY_NODE_THROWN_ERROR_PATTERNS)
  );
}

/**
 * Build the error result for an unexpected filesystem failure outside of
 * esbuild itself — reading the entry file before esbuild ever runs,
 * persisting a compiled or pre-compiled bundle to cache. `what` names the
 * operation that failed (e.g. `'read the entry point'`,
 * `'cache the pre-compiled bundle'`) so the message reflects what actually
 * broke rather than always claiming "compilation failed."
 *
 * The `sourceHash` a caller attaches separately decides whether this is
 * cacheable: a pre-read failure has none to key a `.error.json` by (see
 * {@link resolveEntryPoint}'s identical "no entry point" case), so it is
 * uncacheable by construction; a write-after-successful-compile failure
 * DOES have one, but nothing here writes anything under it either —
 * there is no point persisting an error about a directory that just
 * proved it can't be written to.
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

/**
 * Compiles TypeScript extensions with esbuild and serves pre-compiled JS extensions.
 *
 * Uses content-hash-based caching to avoid redundant compilations. Cache entries
 * are keyed by `{extensionId}.{sha256Hash}.js` where the hash is the first 16 hex
 * characters of the SHA-256 of the source content.
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
  async compile(
    record: ExtensionRecord
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
    const entryResult = await this.resolveEntryPoint(record.path);
    if ('error' in entryResult) {
      return { error: entryResult.error, sourceHash: '' };
    }

    const { entryPath, isPrecompiled } = entryResult;
    let source: string;
    try {
      source = await fs.readFile(entryPath, 'utf-8');
    } catch (err) {
      return { error: buildIoFailureError(record.id, err, 'read the entry point'), sourceHash: '' };
    }
    const sourceHash = this.computeSourceHash(source);

    if (isPrecompiled) {
      return this.handlePrecompiled(record.id, source, sourceHash);
    }

    return this.handleCompilation(record.id, entryPath, sourceHash);
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
  async compileServer(
    record: ExtensionRecord
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
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

    let source: string;
    try {
      source = await fs.readFile(record.serverEntryPath, 'utf-8');
    } catch (err) {
      return {
        error: buildIoFailureError(record.id, err, 'read the entry point', 'Server '),
        sourceHash: '',
      };
    }
    const sourceHash = this.computeSourceHash(source);

    return this.handleServerCompilation(record.id, record.serverEntryPath, sourceHash);
  }

  /**
   * Read a cached bundle by extension ID and source hash.
   * Used by the bundle serving endpoint.
   *
   * @param extId - Extension identifier
   * @param sourceHash - Content hash of the source file
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
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
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

  /** Handle client-side TypeScript compilation with cache hit/miss logic. */
  private async handleCompilation(
    extId: string,
    entryPath: string,
    sourceHash: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
    await this.ensureCacheDir();
    const cachedJsPath = path.join(this.cacheDir, `${extId}.${sourceHash}.js`);
    const cachedErrorPath = path.join(this.cacheDir, `${extId}.${sourceHash}.error.json`);

    // Cache hit: compiled JS
    try {
      await fs.access(cachedJsPath);
      const cached = await fs.readFile(cachedJsPath, 'utf-8');
      logger.debug(`[Extensions] Cache hit for ${extId} (${sourceHash})`);
      return { code: cached, sourceHash };
    } catch {
      // Cache miss
    }

    // Cache hit: previous compilation error
    try {
      await fs.access(cachedErrorPath);
      const cachedError = JSON.parse(
        await fs.readFile(cachedErrorPath, 'utf-8')
      ) as CompilationError;
      if (isLegacyTransientCachedError(cachedError)) {
        logger.info(
          `[Extensions] Discarding a stale cached error for ${extId} (${sourceHash}) — it ` +
            `looks like an environment failure from a previous run, not a real problem with ` +
            `the extension; recompiling`
        );
        await fs.unlink(cachedErrorPath).catch(() => {});
      } else {
        logger.debug(`[Extensions] Cached error for ${extId} (${sourceHash})`);
        return { error: cachedError, sourceHash };
      }
    } catch {
      // Cache miss — compile
    }

    return this.runEsbuild(extId, entryPath, sourceHash, cachedJsPath, cachedErrorPath);
  }

  /** Handle server-side TypeScript compilation with cache hit/miss logic. */
  private async handleServerCompilation(
    extId: string,
    entryPath: string,
    sourceHash: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
    const serverCacheDir = path.join(this.cacheDir, 'server');
    await this.ensureCacheDir(serverCacheDir);

    const cachedJsPath = path.join(serverCacheDir, `${extId}.${sourceHash}.js`);
    const cachedErrorPath = path.join(serverCacheDir, `${extId}.${sourceHash}.error.json`);

    // Cache hit: compiled JS
    try {
      await fs.access(cachedJsPath);
      const cached = await fs.readFile(cachedJsPath, 'utf-8');
      logger.debug(`[Extensions] Server cache hit for ${extId} (${sourceHash})`);
      return { code: cached, sourceHash };
    } catch {
      // Cache miss
    }

    // Cache hit: previous compilation error
    try {
      await fs.access(cachedErrorPath);
      const cachedError = JSON.parse(
        await fs.readFile(cachedErrorPath, 'utf-8')
      ) as CompilationError;
      if (isLegacyTransientCachedError(cachedError)) {
        logger.info(
          `[Extensions] Discarding a stale server cached error for ${extId} (${sourceHash}) — ` +
            `it looks like an environment failure from a previous run, not a real problem with ` +
            `the extension; recompiling`
        );
        await fs.unlink(cachedErrorPath).catch(() => {});
      } else {
        logger.debug(`[Extensions] Server cached error for ${extId} (${sourceHash})`);
        return { error: cachedError, sourceHash };
      }
    } catch {
      // Cache miss — compile
    }

    return this.runServerEsbuild(extId, entryPath, sourceHash, cachedJsPath, cachedErrorPath);
  }

  /**
   * Run esbuild compilation for client-side extensions and cache the result.
   *
   * Two separate `try` blocks, deliberately: a failure from `build()`
   * itself goes through {@link handleEsbuildError} and is worded as a
   * compilation failure, because it is one. A failure writing the
   * already-successful result to cache is a DIFFERENT failure — esbuild
   * did its job — and must not be reported as "Compilation failed for
   * <id>" with a confusing `ENOENT: ... open '<cache path>'` underneath
   * it; {@link buildIoFailureError} words it as what it actually is.
   */
  private async runEsbuild(
    extId: string,
    entryPath: string,
    sourceHash: string,
    cachedJsPath: string,
    cachedErrorPath: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
    let code: string;
    let sizeKb: number;
    try {
      const result = await build({
        entryPoints: [entryPath],
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
      });

      code = result.outputFiles?.[0]?.text ?? '';
      sizeKb = Buffer.byteLength(code, 'utf-8') / 1024;
      if (sizeKb > BUNDLE_SIZE_WARNING_KB) {
        logger.warn(
          `[Extensions] Bundle for ${extId} is ${sizeKb.toFixed(0)}KB (exceeds ${BUNDLE_SIZE_WARNING_KB}KB guideline)`
        );
      }
    } catch (err) {
      return this.handleEsbuildError(extId, err, cachedErrorPath, sourceHash);
    }

    try {
      await fs.writeFile(cachedJsPath, code, 'utf-8');
      await fs.unlink(cachedErrorPath).catch(() => {
        /* no stale error */
      });
      logger.info(`[Extensions] Compiled ${extId} (${sizeKb.toFixed(1)}KB)`);
      return { code, sourceHash };
    } catch (err) {
      return { error: buildIoFailureError(extId, err, 'cache the compiled bundle'), sourceHash };
    }
  }

  /**
   * Run esbuild compilation for server-side extensions and cache the result.
   * See {@link runEsbuild} for why compile failures and cache-write
   * failures are handled in separate `try` blocks.
   */
  private async runServerEsbuild(
    extId: string,
    entryPath: string,
    sourceHash: string,
    cachedJsPath: string,
    cachedErrorPath: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
    let code: string;
    let sizeKb: number;
    try {
      const result = await build({
        entryPoints: [entryPath],
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
      });

      code = result.outputFiles?.[0]?.text ?? '';
      sizeKb = Buffer.byteLength(code, 'utf-8') / 1024;
      if (sizeKb > BUNDLE_SIZE_WARNING_KB) {
        logger.warn(
          `[Extensions] Server bundle for ${extId} is ${sizeKb.toFixed(0)}KB (exceeds ${BUNDLE_SIZE_WARNING_KB}KB guideline)`
        );
      }
    } catch (err) {
      return this.handleEsbuildError(extId, err, cachedErrorPath, sourceHash, 'Server ');
    }

    try {
      await fs.writeFile(cachedJsPath, code, 'utf-8');
      await fs.unlink(cachedErrorPath).catch(() => {
        /* no stale error */
      });
      logger.info(`[Extensions] Compiled server bundle for ${extId} (${sizeKb.toFixed(1)}KB)`);
      return { code, sourceHash };
    } catch (err) {
      return {
        error: buildIoFailureError(extId, err, 'cache the compiled bundle', 'Server '),
        sourceHash,
      };
    }
  }

  /**
   * Handle an esbuild compilation error: cache it and return a structured
   * error result — unless {@link isEnvironmentFailure} says the failure
   * describes the local environment rather than the extension's source, in
   * which case the cache write is skipped so the next compile attempt (the
   * next start, or the next `reload_extensions`) tries fresh instead of
   * replaying a one-time environment hiccup forever.
   *
   * @param extId - Extension identifier
   * @param err - Error thrown by esbuild
   * @param cachedErrorPath - Path to write the cached error JSON
   * @param sourceHash - Content hash of the source file
   * @param prefix - Optional prefix for log messages (e.g. 'Server ')
   */
  private async handleEsbuildError(
    extId: string,
    err: unknown,
    cachedErrorPath: string,
    sourceHash: string,
    prefix = ''
  ): Promise<{ error: CompilationError; sourceHash: string }> {
    const esbuildErr = err as {
      errors?: Array<{
        text: string;
        location?: { file: string; line: number; column: number };
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
      return { error: compilationError, sourceHash };
    }

    try {
      await fs.writeFile(cachedErrorPath, JSON.stringify(compilationError, null, 2), 'utf-8');
    } catch (writeErr) {
      // The error itself is genuine and still returned below — only
      // persisting it failed (a full disk while writing the cache entry
      // for a real compile error). It will be re-detected, and the write
      // re-attempted, on the next compile; nothing crashes over it either way.
      logger.warn(
        `[Extensions] Could not cache the compile error for ${extId}: ` +
          `${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
      );
    }

    logger.error(
      `[Extensions] ${prefix}Compilation failed for ${extId}: ${compilationError.errors[0]?.text}`
    );
    return { error: compilationError, sourceHash };
  }

  /** Compute SHA-256 content hash (first 16 hex chars). */
  private computeSourceHash(source: string): string {
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
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
   * {@link buildIoFailureError} and its use in {@link handlePrecompiled},
   * {@link runEsbuild}, and {@link runServerEsbuild}.
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
