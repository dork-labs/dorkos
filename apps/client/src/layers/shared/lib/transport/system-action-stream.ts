import { fetchJSON, buildQueryString } from './http-client';
import type { OpenRouterOAuthStatus } from '@dorkos/shared/runtime-connect';
import { parseSSEStream } from './sse-parser';

/**
 * POST an SSE-streaming action and fold its frames into a single terminal result.
 *
 * The shared shape for every streamed install/pull endpoint (runtime provision,
 * Ollama pull, Ollama install): `progress` frames drive `onProgress` while a
 * terminal `result` frame carries the outcome. A non-2xx opening response throws
 * an honest error; a stream that ends with no `result` frame resolves to
 * `fallback`.
 *
 * @param url - The absolute endpoint URL to POST.
 * @param body - Optional JSON body (omit for a bodyless trigger).
 * @param fallback - The result returned when the stream carries no terminal frame.
 * @param onProgress - Optional callback for streamed progress frames.
 */
export async function postSseAction<TProgress, TResult>(
  url: string,
  body: Record<string, unknown> | undefined,
  fallback: TResult,
  onProgress?: (progress: TProgress) => void
): Promise<TResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({
      error: response.statusText,
    }))) as { error?: string };
    throw new Error(errBody.error ?? `HTTP ${response.status}`);
  }

  const reader = response.body!.getReader();
  let result = fallback;
  for await (const event of parseSSEStream<TProgress | TResult>(reader)) {
    if (event.type === 'result') {
      result = event.data as TResult;
    } else if (event.type === 'progress') {
      onProgress?.(event.data as TProgress);
    }
  }
  return result;
}

/** Read the existing streamed provider login status without changing its URL or fetch policy. */
export function readOpenRouterOAuthStatus(
  baseUrl: string,
  state: string
): Promise<OpenRouterOAuthStatus> {
  const qs = buildQueryString({ state });
  return fetchJSON<OpenRouterOAuthStatus>(
    baseUrl,
    `/runtimes/opencode/openrouter/oauth/status${qs}`
  );
}
