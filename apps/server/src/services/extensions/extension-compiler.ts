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
 * The prose esbuild's native binary writes when it fails to READ a file
 * because of the local environment, rather than anything about the
 * extension's source. esbuild formats every one of these identically —
 * `Cannot read file %q: %s`, where `%s` is Go's raw `strerror()` text for
 * the underlying OS error — so it never uses an OS errno symbol
 * (`EMFILE`, `ENOSPC`, ...) in a message, only the human text it maps to.
 *
 * Verified against esbuild 0.25.12 two ways, both reproduced in
 * `__tests__/extension-compiler-real-esbuild.test.ts`:
 *
 * - An unreadable ENTRY point (`chmod 000`) rejects with a `BuildFailure`
 *   carrying a populated, single-entry `errors[]` with `location: null` —
 *   there is nothing to point at, since esbuild never got to open the file
 *   that would anchor a position.
 * - An unreadable file the entry point IMPORTS rejects with the same text
 *   template, but this time `location` points at the `import` statement in
 *   the (perfectly readable) file that referenced it — esbuild has a real
 *   source position for *that* failure, it just can't read what's on the
 *   other end.
 *
 * So `location` is present in one case and absent in the other for the
 * identical underlying problem: matching MUST NOT require its absence, or
 * the second case — a transient failure reached while resolving any file
 * the extension imports, not just its own entry point — quietly falls
 * through to being cached as a permanent compile error, which is exactly
 * the defect this pattern exists to close.
 */
const ESBUILD_IO_FAILURE_PATTERNS: RegExp[] = [
  /Cannot read file .*: (too many open files( in system)?|permission denied|no space left on device|cannot allocate memory|input\/output error)/,
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
 * 1. **Before esbuild's binary even starts** (the `@esbuild/<platform>`
 *    package is missing, `child_process.spawn` itself fails): rejects with
 *    a plain `Error` that has no `errors` array at all. Caught by the
 *    shape check below.
 * 2. **While esbuild's binary is running but can't read a file** — the
 *    entry point itself, or anything it imports — because of `EMFILE`,
 *    `ENOSPC`, `ENOMEM`, `EACCES`, or similar: rejects with a real
 *    `BuildFailure` carrying a POPULATED `errors[]` — the same shape a
 *    genuine compile error has, with or without a `location` depending on
 *    which file could not be read (see {@link ESBUILD_IO_FAILURE_PATTERNS}).
 *    Shape alone cannot tell this apart from a real error; only the
 *    message text can.
 *
 * Either way, the failure is not a deterministic property of the
 * extension's content hash, so caching it would brick the extension on
 * every future start — including after the environment recovers — for a
 * problem the extension author never had a chance to cause.
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
 * {@link ESBUILD_IO_FAILURE_PATTERNS}, for the file-read-failure case a
 * plain shape check cannot catch even on a *live* classification — plus
 * {@link LEGACY_NODE_THROWN_ERROR_PATTERNS} for the Node-thrown case,
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
    const source = await fs.readFile(entryPath, 'utf-8');
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

    const source = await fs.readFile(record.serverEntryPath, 'utf-8');
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
   * @returns Number of entries cleaned
   */
  async cleanStaleCache(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const subDir of [this.cacheDir, path.join(this.cacheDir, 'server')]) {
      try {
        await fs.access(subDir);
      } catch {
        continue;
      }

      const entries = await fs.readdir(subDir);
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

  /** Handle a pre-compiled JS extension — cache for consistent serving. */
  private async handlePrecompiled(
    extId: string,
    source: string,
    sourceHash: string
  ): Promise<{ code: string; sourceHash: string }> {
    await this.ensureCacheDir();
    const cachedPath = path.join(this.cacheDir, `${extId}.${sourceHash}.js`);

    try {
      await fs.access(cachedPath);
      const cached = await fs.readFile(cachedPath, 'utf-8');
      return { code: cached, sourceHash };
    } catch {
      await fs.writeFile(cachedPath, source, 'utf-8');
      return { code: source, sourceHash };
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
    await fs.mkdir(serverCacheDir, { recursive: true });

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

  /** Run esbuild compilation for client-side extensions and cache the result. */
  private async runEsbuild(
    extId: string,
    entryPath: string,
    sourceHash: string,
    cachedJsPath: string,
    cachedErrorPath: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
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

      const code = result.outputFiles?.[0]?.text ?? '';

      // Bundle size warning
      const sizeKb = Buffer.byteLength(code, 'utf-8') / 1024;
      if (sizeKb > BUNDLE_SIZE_WARNING_KB) {
        logger.warn(
          `[Extensions] Bundle for ${extId} is ${sizeKb.toFixed(0)}KB (exceeds ${BUNDLE_SIZE_WARNING_KB}KB guideline)`
        );
      }

      // Write to cache, delete any stale error
      await fs.writeFile(cachedJsPath, code, 'utf-8');
      try {
        await fs.unlink(cachedErrorPath);
      } catch {
        /* no stale error */
      }

      logger.info(`[Extensions] Compiled ${extId} (${sizeKb.toFixed(1)}KB)`);
      return { code, sourceHash };
    } catch (err) {
      return this.handleEsbuildError(extId, err, cachedErrorPath, sourceHash);
    }
  }

  /** Run esbuild compilation for server-side extensions and cache the result. */
  private async runServerEsbuild(
    extId: string,
    entryPath: string,
    sourceHash: string,
    cachedJsPath: string,
    cachedErrorPath: string
  ): Promise<
    { code: string; sourceHash: string } | { error: CompilationError; sourceHash: string }
  > {
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

      const code = result.outputFiles?.[0]?.text ?? '';

      const sizeKb = Buffer.byteLength(code, 'utf-8') / 1024;
      if (sizeKb > BUNDLE_SIZE_WARNING_KB) {
        logger.warn(
          `[Extensions] Server bundle for ${extId} is ${sizeKb.toFixed(0)}KB (exceeds ${BUNDLE_SIZE_WARNING_KB}KB guideline)`
        );
      }

      await fs.writeFile(cachedJsPath, code, 'utf-8');
      try {
        await fs.unlink(cachedErrorPath);
      } catch {
        /* no stale error */
      }

      logger.info(`[Extensions] Compiled server bundle for ${extId} (${sizeKb.toFixed(1)}KB)`);
      return { code, sourceHash };
    } catch (err) {
      return this.handleEsbuildError(extId, err, cachedErrorPath, sourceHash, 'Server ');
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

    await fs.writeFile(cachedErrorPath, JSON.stringify(compilationError, null, 2), 'utf-8');

    logger.error(
      `[Extensions] ${prefix}Compilation failed for ${extId}: ${compilationError.errors[0]?.text}`
    );
    return { error: compilationError, sourceHash };
  }

  /** Compute SHA-256 content hash (first 16 hex chars). */
  private computeSourceHash(source: string): string {
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
  }

  /** Ensure the client-side cache directory exists. */
  private async ensureCacheDir(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }
}
