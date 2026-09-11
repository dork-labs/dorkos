/**
 * Read effective context windows from Codex's own bounded model cache.
 *
 * @module services/runtimes/codex/model-context-windows
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MAX_MODELS_CACHE_BYTES = 2 * 1024 * 1024;
// Codex 0.154.0 uses this exact 300-second freshness window and rewrites
// `fetched_at` after an ETag revalidation once half that lifetime has elapsed:
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/src/manager.rs
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/src/cache.rs
const MODELS_CACHE_MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;

const CachedModelSchema = z.object({
  slug: z.string().min(1),
  context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  effective_context_window_percent: z.number().gt(0).lte(100),
});

const ModelsCacheSchema = z.object({
  fetched_at: z.string(),
  client_version: z.string().min(1),
  models: z.array(CachedModelSchema),
});

/** Options for one bounded Codex model-cache read. */
export interface ReadCodexModelContextWindowsOptions {
  /** Codex home used by the app-server process. */
  codexHome: string;
  /** Version reported by that same app-server process. */
  clientVersion: string;
  /** Clock seam for deterministic freshness tests. */
  now?: number;
  /** Maximum accepted cache age. Defaults to the catalog's five-minute stale limit. */
  maxAgeMs?: number;
  /** Maximum file size accepted before reading. */
  maxBytes?: number;
}

/**
 * Parse the Codex version from the app-server initialization response.
 *
 * App-server prefixes its own version with the initializing client's name.
 * DorkOS therefore receives `dorkos/0.154.0 (...)`, while a desktop originator
 * can receive `Codex Desktop/0.154.0 (...)`. An unknown format produces no
 * version and therefore no cache enrichment.
 *
 * @param userAgent - `initialize.result.userAgent` from the running app-server.
 * @returns The semantic version, or `null` when the process did not identify itself.
 */
export function parseCodexAppServerVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null;
  return (
    /^[0-9A-Za-z][0-9A-Za-z._ -]{0,63}\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(
      userAgent
    )?.[1] ?? null
  );
}

/** Read at most `maxBytes` from a file that may change while it is open. */
async function readBoundedFile(file: string, maxBytes: number): Promise<string | null> {
  // O_NONBLOCK keeps a replaced cache path such as a FIFO from trapping model
  // discovery before fstat can reject it as a non-regular file.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) return null;

    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }

    // A growing file cannot evade the pre-read size check. Treat it as an
    // unstable snapshot and wait for the next catalog refresh.
    const extra = Buffer.alloc(1);
    const tail = await handle.read(extra, 0, 1, offset);
    if (tail.bytesRead > 0) return null;
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read the effective context windows for models cached by this Codex version.
 *
 * Codex stores a raw window plus an effective percentage. The effective value
 * is what live rollouts report as `model_context_window` (for example,
 * 272,000 × 95% = 258,400 for GPT-6-Astra), so that is the denominator the UI
 * needs. Missing, stale, future-dated, malformed, or version-mismatched cache
 * data returns an empty map and leaves the catalog honest but less detailed.
 *
 * @param options - Cache location, process version, and bounded-read seams.
 * @returns Effective context windows keyed by exact Codex model slug.
 */
export async function readCodexModelContextWindows(
  options: ReadCodexModelContextWindowsOptions
): Promise<ReadonlyMap<string, number>> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MODELS_CACHE_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? MAX_MODELS_CACHE_BYTES;

  try {
    const raw = await readBoundedFile(path.join(options.codexHome, 'models_cache.json'), maxBytes);
    if (raw === null) return new Map();
    const parsed = ModelsCacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.client_version !== options.clientVersion) return new Map();

    const fetchedAt = Date.parse(parsed.data.fetched_at);
    if (!Number.isFinite(fetchedAt)) return new Map();
    if (fetchedAt > now + MAX_FUTURE_CLOCK_SKEW_MS || now - fetchedAt > maxAgeMs) {
      return new Map();
    }

    const windows = new Map<string, number>();
    for (const model of parsed.data.models) {
      if (windows.has(model.slug)) return new Map();
      const effective = Math.floor(
        model.context_window * (model.effective_context_window_percent / 100)
      );
      if (!Number.isSafeInteger(effective) || effective <= 0) return new Map();
      windows.set(model.slug, effective);
    }
    return windows;
  } catch {
    return new Map();
  }
}
