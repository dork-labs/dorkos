import type { ToolDescriptor } from '../contracts.js';
import { textResult, toolError } from './local.js';
/** URL policy belongs to the host and runs for the requested URL and each redirect destination. */
export interface WebFetchOptions {
  allowUrl: (url: URL, signal: AbortSignal) => boolean | Promise<boolean>;
  maxResponseBytes?: number;
  maxOutputBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}
function limit(value: number | undefined, fallback: number, minimum = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error('Invalid fetch limit');
  return result;
}
async function approved(options: WebFetchOptions, url: URL, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => options.allowUrl(new URL(url), signal))
      .then(
        (result) => {
          signal.removeEventListener('abort', aborted);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        }
      );
  });
}
/** Create a bounded Node-fetch descriptor; import and construction make no requests. */
export function createWebFetchTool(options: WebFetchOptions): ToolDescriptor {
  const maxResponse = limit(options.maxResponseBytes, 1024 * 1024);
  const maxOutput = limit(options.maxOutputBytes, 16 * 1024);
  const maxRedirects = limit(options.maxRedirects, 5, 0);
  const timeout = limit(options.timeoutMs, 30_000);
  return {
    name: 'web_fetch',
    description: 'Fetch bounded text from a host-approved URL.',
    initialLoad: true,
    schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (value, context) => {
      try {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.url !== 'string' ||
          Object.keys(value).some((key) => key !== 'url')
        )
          throw new Error('url must be a string');
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
        let url = new URL(value.url);
        for (let redirect = 0; ; redirect++) {
          signal.throwIfAborted();
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            !(await approved(options, url, signal))
          )
            throw new Error('URL denied by host policy');
          signal.throwIfAborted();
          const response = await fetch(url, { signal, redirect: 'manual' });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (redirect >= maxRedirects) throw new Error('Redirect limit exceeded');
            const location = response.headers.get('location');
            if (!location) throw new Error('Redirect missing location');
            url = new URL(location, url);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP fetch failed: ${response.status}`);
          }
          const length = Number(response.headers.get('content-length'));
          if (length > maxResponse) {
            await response.body?.cancel();
            throw new Error('Response exceeds byte limit');
          }
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            if (reader)
              for (;;) {
                signal.throwIfAborted();
                const { done, value: chunk } = await reader.read();
                if (done) break;
                bytes += chunk.byteLength;
                if (bytes > maxResponse) throw new Error('Response exceeds byte limit');
                chunks.push(chunk);
              }
          } finally {
            await reader?.cancel();
          }
          return textResult(Buffer.concat(chunks).toString('utf8'), maxOutput, {
            url: url.href,
            status: response.status,
            responseBytes: bytes,
          });
        }
      } catch (error) {
        return toolError(error);
      }
    },
  };
}
