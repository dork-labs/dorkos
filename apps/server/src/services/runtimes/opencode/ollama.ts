/**
 * Zero-auth local Ollama detection (effortless-runtime-switching T1, task 2.7) —
 * the frictionless hero of the OpenCode Local path. DorkOS DETECTS Ollama; it
 * never owns or manages the process or its model library (the guided pull is T2,
 * task 3.5).
 *
 * The probe hits Ollama's local HTTP API (`GET http://127.0.0.1:11434/api/tags`)
 * bounded by a short timeout, so an absent Ollama (connection refused) fails fast
 * and a hung one is aborted rather than blocking the request. A short-TTL cache
 * fronts the probe so repeated picker opens do not re-hit it. No account, no
 * secret, ever.
 *
 * @module services/runtimes/opencode/ollama
 */
import type { OllamaStatus } from '@dorkos/shared/runtime-connect';

/** Local Ollama tags endpoint (loopback only — never a remote host). */
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';

/** Hard bound on the probe so a hung Ollama degrades fast instead of blocking. */
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

/** How long a detection result is served from cache before a re-probe. */
const OLLAMA_CACHE_TTL_MS = 5_000;

/** Injectable `fetch` seam (defaults to global `fetch`); tests pass a mock. */
export type FetchFn = typeof fetch;

interface DetectCache {
  status: OllamaStatus;
  probedAt: number;
}
let detectCache: DetectCache | null = null;

/** Reset the detection cache — test-only seam. */
export function resetOllamaCache(): void {
  detectCache = null;
}

/** Shape of an entry in Ollama's `/api/tags` response. */
interface OllamaTag {
  name?: string;
  size?: number;
}

/**
 * Detect a local Ollama: whether it is running and which models are pulled.
 *
 * Bounded and throw-free. Connection refused (Ollama absent) or a probe timeout
 * resolves to `{ running: false, models: [] }` fast; a reachable-but-unparseable
 * response resolves to `{ running: true, models: [] }` (it answered, but no
 * readable model list). Results are cached for {@link OLLAMA_CACHE_TTL_MS}.
 *
 * @param deps - Injectable `fetch` seam.
 */
export async function detectOllama(deps: { fetchImpl?: FetchFn } = {}): Promise<OllamaStatus> {
  if (detectCache && Date.now() - detectCache.probedAt < OLLAMA_CACHE_TTL_MS) {
    return detectCache.status;
  }
  const status = await probeOllama(deps.fetchImpl ?? fetch);
  detectCache = { status, probedAt: Date.now() };
  return status;
}

/** One bounded probe of the local Ollama tags endpoint. */
async function probeOllama(fetchImpl: FetchFn): Promise<OllamaStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OLLAMA_TAGS_URL, { signal: controller.signal });
    if (!res.ok) return { running: false, models: [] };
    try {
      const body = (await res.json()) as { models?: OllamaTag[] };
      const models = (body.models ?? [])
        .filter((m): m is OllamaTag & { name: string } => typeof m.name === 'string')
        .map((m) =>
          typeof m.size === 'number' ? { name: m.name, size: m.size } : { name: m.name }
        );
      return { running: true, models };
    } catch {
      // Reachable but the body was not the expected JSON — honest degrade.
      return { running: true, models: [] };
    }
  } catch {
    // Connection refused, aborted (timeout), or any network error — Ollama absent.
    return { running: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
