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
 * Decide whether a thrown esbuild error reflects a problem with the local
 * environment — a missing native binary, exhausted file descriptors, disk
 * or memory pressure — rather than the extension's own source.
 *
 * esbuild reports a genuine compile failure (a syntax error, an unresolved
 * import, a type error) by rejecting with a `BuildFailure` that carries a
 * populated `errors` array of source-mapped messages — every internal
 * failure path builds that array with at least one entry before throwing.
 * Every other failure — a missing `@esbuild/<platform>` package, a spawn
 * error, a Node-level `EMFILE`/`ENOENT` while esbuild starts its helper
 * process — rejects with a plain `Error` that has no `errors` array at
 * all, because esbuild never got far enough to evaluate the source.
 *
 * That absence is the signal this function keys on: it means the failure
 * is not a deterministic property of the extension's content hash, so
 * caching it would brick the extension on every future start — including
 * after the environment recovers — for a problem the extension author
 * never had a chance to cause.
 *
 * @param err - The value esbuild's `build()` rejected with.
 * @returns `true` when `err` is not a `BuildFailure` with real errors.
 */
function isEnvironmentFailure(err: unknown): boolean {
  const esbuildErr = err as { errors?: unknown[] };
  return !Array.isArray(esbuildErr.errors) || esbuildErr.errors.length === 0;
}

/**
 * Text signatures of environment failures — a missing native binary, an
 * install mismatch, or an OS-level resource error — that a build predating
 * {@link isEnvironmentFailure} could have written to a `.error.json` cache
 * file as if they were permanent compile errors.
 */
const LEGACY_TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /could not be found, and is needed by esbuild/i,
  /installed esbuild for another platform/i,
  /\bEMFILE\b/,
  /\bENFILE\b/,
  /\bENOENT\b/,
  /\bENOMEM\b/,
  /\bENOSPC\b/,
  /\bEACCES\b/,
  /out of memory/i,
];

/**
 * Detect a cached compile error, written before {@link isEnvironmentFailure}
 * existed, that actually describes an environment problem rather than a
 * defect in the extension's own source.
 *
 * Every error {@link isEnvironmentFailure} would now keep out of the cache
 * was written the same way: a single `errors[]` entry with no `location`,
 * wrapping a bare `Error.message` (a genuine esbuild message almost always
 * carries a source `location`). Matching that shape against known
 * environment-failure text is a reliable enough signal to evict a legacy
 * cache entry — one written before this classification shipped — rather
 * than replay it as a permanent verdict on every future start.
 *
 * @param cached - The parsed contents of a cached `.error.json` file.
 * @returns `true` when the cached error looks like a stale environment
 *   failure rather than a real, still-current compile error.
 */
function isLegacyTransientCachedError(cached: CompilationError): boolean {
  return cached.errors.some(
    (e) => !e.location && LEGACY_TRANSIENT_ERROR_PATTERNS.some((p) => p.test(e.text))
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
