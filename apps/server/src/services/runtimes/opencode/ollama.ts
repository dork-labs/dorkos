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
 * The guided pull (T2, task 3.5) also lives here — it triggers a single streamed
 * `POST /api/pull` for a curated coding model and reports download progress.
 * DorkOS still never owns or manages Ollama's process or its full library: it only
 * detects and triggers one pull. The curated catalog + hardware-fit heuristic live
 * in the sibling `ollama-catalog.ts`.
 *
 * @module services/runtimes/opencode/ollama
 */
import type {
  OllamaPullProgress,
  OllamaPullResult,
  OllamaStatus,
} from '@dorkos/shared/runtime-connect';

/** Local Ollama base origin (loopback only — never a remote host). */
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** Local Ollama tags endpoint. */
const OLLAMA_TAGS_URL = `${OLLAMA_BASE_URL}/api/tags`;

/** Local Ollama pull endpoint (streamed). */
const OLLAMA_PULL_URL = `${OLLAMA_BASE_URL}/api/pull`;

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

// --- Guided pull (T2, task 3.5) --------------------------------------------

/** One decoded line of Ollama's streamed pull response. */
interface OllamaPullLine {
  status?: string;
  error?: string;
  completed?: number;
  total?: number;
}

/**
 * Condense a pull failure into an honest, non-raw message for the Connect
 * surface. `detail` is a short reason (never a raw stack); pass it without a
 * trailing period.
 */
function honestPullError(model: string, detail: string): string {
  const firstLine = detail
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not pull ${model}${suffix}. Check that Ollama is running and try again.`;
}

/** Map one parsed pull line to a client progress frame (with a convenience percent). */
function toProgress(line: OllamaPullLine): OllamaPullProgress {
  const progress: OllamaPullProgress = { status: line.status ?? '' };
  if (typeof line.completed === 'number') progress.completed = line.completed;
  if (typeof line.total === 'number') progress.total = line.total;
  if (typeof line.completed === 'number' && typeof line.total === 'number' && line.total > 0) {
    progress.percent = Math.min(100, Math.round((line.completed / line.total) * 100));
  }
  return progress;
}

/**
 * Trigger a single Ollama model pull and stream its download progress.
 *
 * POSTs `{ model, stream: true }` to Ollama's local `/api/pull`, reads the
 * streamed NDJSON, and forwards each line as an {@link OllamaPullProgress} frame.
 * DorkOS neither owns nor manages Ollama — it only triggers this one pull. Never
 * throws: an unreachable Ollama, a non-2xx response, an in-stream `{ error }`
 * line, or an interrupted stream all resolve to an honest `{ ok: false }` result.
 * The caller is expected to have already restricted `model` to a curated coding
 * model (see {@link ../ollama-catalog}).
 *
 * @param model - The Ollama model id/tag to pull (e.g. `qwen2.5-coder:7b`).
 * @param onProgress - Optional callback for streamed download-progress frames.
 * @param deps - Injectable `fetch` seam.
 * @returns The terminal pull result.
 */
export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  deps: { fetchImpl?: FetchFn } = {}
): Promise<OllamaPullResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(OLLAMA_PULL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
  } catch {
    return { ok: false, model, error: honestPullError(model, 'Could not reach Ollama') };
  }

  if (!res.ok) {
    return {
      ok: false,
      model,
      error: honestPullError(model, `Ollama returned HTTP ${res.status}`),
    };
  }
  if (!res.body) {
    return { ok: false, model, error: honestPullError(model, 'Ollama sent no download stream') };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawError: string | null = null;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: OllamaPullLine;
    try {
      parsed = JSON.parse(trimmed) as OllamaPullLine;
    } catch {
      // A single unparseable line should not fail the whole pull — skip it.
      return;
    }
    if (parsed.error) {
      sawError = parsed.error;
      return;
    }
    onProgress?.(toProgress(parsed));
  };

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handleLine(buffer); // flush a trailing line with no newline
  } catch {
    return {
      ok: false,
      model,
      error: honestPullError(model, 'the download stream was interrupted'),
    };
  }

  if (sawError) {
    return { ok: false, model, error: honestPullError(model, sawError) };
  }
  return { ok: true, model };
}
