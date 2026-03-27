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
   * Compile an extension (or return cached bundle).
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
   * Read a cached bundle by extension ID and source hash.
   * Used by the bundle serving endpoint.
   *
   * @param extId - Extension identifier
   * @param sourceHash - Content hash of the source file
   */
  async readBundle(extId: string, sourceHash: string): Promise<string | null> {
    const cachedPath = path.join(this.cacheDir, `${extId}.${sourceHash}.js`);
    try {
      return await fs.readFile(cachedPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Clean stale cache entries not accessed in 7+ days.
   * Called on server startup.
   *
   * @returns Number of entries cleaned
   */
  async cleanStaleCache(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    try {
      await fs.access(this.cacheDir);
    } catch {
      return 0;
    }

    const entries = await fs.readdir(this.cacheDir);
    for (const entry of entries) {
      const filePath = path.join(this.cacheDir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.atimeMs > STALE_THRESHOLD_MS) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat
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

  /** Handle TypeScript compilation with cache hit/miss logic. */
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
      logger.debug(`[Extensions] Cached error for ${extId} (${sourceHash})`);
      return { error: cachedError, sourceHash };
    } catch {
      // Cache miss — compile
    }

    return this.runEsbuild(extId, entryPath, sourceHash, cachedJsPath, cachedErrorPath);
  }

  /** Run esbuild compilation and cache the result. */
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
      const esbuildErr = err as {
        errors?: Array<{
          text: string;
          location?: { file: string; line: number; column: number };
        }>;
      };

      const compilationError: CompilationError = {
        code: 'compilation_failed',
        message: `Compilation failed for ${extId}`,
        errors: esbuildErr.errors?.map((e) => ({
          text: e.text,
          location: e.location
            ? { file: e.location.file, line: e.location.line, column: e.location.column }
            : undefined,
        })) ?? [{ text: err instanceof Error ? err.message : 'Unknown compilation error' }],
      };

      // Write error to cache
      await fs.writeFile(cachedErrorPath, JSON.stringify(compilationError, null, 2), 'utf-8');

      logger.error(
        `[Extensions] Compilation failed for ${extId}: ${compilationError.errors[0]?.text}`
      );
      return { error: compilationError, sourceHash };
    }
  }

  /** Compute SHA-256 content hash (first 16 hex chars). */
  private computeSourceHash(source: string): string {
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
  }

  /** Ensure the cache directory exists. */
  private async ensureCacheDir(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }
}
