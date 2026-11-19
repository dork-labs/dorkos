import { z } from 'zod';
import type { BrowserViewerTransport } from '@dorkos/shared/transport-local-browser';
import { fetchJSON, fetchNoContent, fetchResponse } from './http-client';

/** A fixed refusal; never retain pixel bytes or untrusted response metadata as an error cause. */
class InvalidViewerFrame extends Error {
  readonly code = 'viewer_frame_invalid';
  constructor() {
    super('viewer_frame_invalid');
  }
}

const secret = z.string().regex(/^[\w-]{43}$/);
const subscription = z
  .object({
    viewerId: secret,
    nonce: secret,
    binding: z
      .object({
        chatId: z.string(),
        profileId: z.string().nullable(),
        connectionId: z.string(),
        tabId: z.string(),
      })
      .strict(),
  })
  .strict();
const metadata = z
  .object({
    sequence: z.number().int().positive(),
    generation: z.number().int().positive(),
    width: z.number().int().min(1).max(1280),
    height: z.number().int().min(1).max(960),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 * 1024),
  })
  .strict();

async function readFrameBytes(response: Response, length: number, signal?: AbortSignal) {
  if (!response.body) throw new InvalidViewerFrame();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(length);
  let offset = 0;
  const aborted = () => {
    void reader.cancel().catch(() => undefined);
  };
  try {
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) throw new InvalidViewerFrame();
    while (true) {
      const result = await reader.read();
      if (signal?.aborted) throw new InvalidViewerFrame();
      if (result.done) break;
      if (offset + result.value.length > length) throw new InvalidViewerFrame();
      bytes.set(result.value, offset);
      offset += result.value.length;
    }
    if (offset !== length) throw new InvalidViewerFrame();
    return bytes;
  } catch {
    bytes.fill(0);
    await reader.cancel().catch(() => undefined);
    throw new InvalidViewerFrame();
  } finally {
    signal?.removeEventListener('abort', aborted);
    reader.releaseLock();
  }
}

/** Authorized JPEG delivery using the app's existing cookie/proof fetch path. */
export function createBrowserViewerMethods(
  baseUrl: string,
  clientId: () => string
): BrowserViewerTransport {
  const options = (signal?: AbortSignal) => ({
    signal,
    cache: 'no-store' as const,
    headers: { 'X-Client-Id': clientId() },
    timeout: 8_000,
  });
  return {
    subscribeBrowserViewer: async (chatId, signal) =>
      subscription.parse(
        await fetchJSON(baseUrl, '/browser-viewers', {
          ...options(signal),
          method: 'POST',
          body: JSON.stringify({ chatId }),
        })
      ),
    nextBrowserViewerFrame: async (viewer, receipt, signal) => {
      const response = await fetchResponse(
        baseUrl,
        `/browser-viewers/${encodeURIComponent(viewer.viewerId)}/frame`,
        {
          ...options(signal),
          timeout: 5_000,
          method: 'POST',
          body: JSON.stringify({ nonce: viewer.nonce, ...(receipt ? { receipt } : {}) }),
        }
      );
      if (response.status === 204) return null;
      try {
        if (response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg')
          throw new InvalidViewerFrame();
        const rawMetadata = response.headers.get('x-frame-metadata');
        if (!rawMetadata || rawMetadata.length > 1024) throw new InvalidViewerFrame();
        const description = metadata.parse(JSON.parse(rawMetadata));
        const receipt = secret.parse(response.headers.get('x-frame-receipt'));
        const bytes = await readFrameBytes(response, description.byteLength, signal);
        return { ...description, receipt, bytes };
      } catch {
        if (!response.body?.locked) await response.body?.cancel().catch(() => undefined);
        throw new InvalidViewerFrame();
      }
    },
    closeBrowserViewer: (viewer) =>
      fetchNoContent(baseUrl, `/browser-viewers/${encodeURIComponent(viewer.viewerId)}`, {
        ...options(),
        method: 'DELETE',
        body: JSON.stringify({ nonce: viewer.nonce }),
      }),
  };
}
