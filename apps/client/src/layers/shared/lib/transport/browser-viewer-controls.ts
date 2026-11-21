import { z } from 'zod';
import { viewerMetadataSchema, viewerOutcomeSchema } from '@dorkos/shared/browser-viewer-control';
import type {
  BrowserViewerTransport,
  BrowserViewerSubscription,
  BrowserViewerControlResult,
} from '@dorkos/shared/transport-local-browser';
import { fetchJSON } from './http-client';

const answer = z
  .object({
    metadata: viewerMetadataSchema,
    outcome: viewerOutcomeSchema.optional(),
    text: z.string().max(65_536).optional(),
  })
  .strict();
type Controls = Pick<
  BrowserViewerTransport,
  | 'takeBrowserViewerControl'
  | 'sendBrowserViewerInput'
  | 'endBrowserViewerControl'
  | 'copyBrowserViewerSelection'
  | 'pasteBrowserViewerText'
  | 'uploadBrowserViewerFiles'
  | 'cancelBrowserViewerFiles'
>;

/** Fixed person verbs. No URLs, selection contents or file bytes enter persistent client state. */
export function createBrowserViewerControls(baseUrl: string, clientId: () => string): Controls {
  const request = async (
    viewer: BrowserViewerSubscription,
    verb: string,
    body: unknown,
    signal?: AbortSignal,
    multipart?: FormData
  ): Promise<BrowserViewerControlResult> => {
    const result = answer.parse(
      await fetchJSON(baseUrl, `/browser-viewers/${encodeURIComponent(viewer.viewerId)}/${verb}`, {
        method: 'POST',
        cache: 'no-store',
        signal,
        timeout: multipart ? 15_000 : 8_000,
        headers: {
          'X-Client-Id': clientId(),
          ...(multipart ? { 'X-Viewer-Control': JSON.stringify(body) } : {}),
        },
        body: multipart ?? JSON.stringify(body),
      })
    );
    viewer.metadata = result.metadata;
    return result;
  };
  return {
    takeBrowserViewerControl: (v, signal) => request(v, 'take-over', { nonce: v.nonce }, signal),
    sendBrowserViewerInput: (v, op, input, signal) =>
      request(v, 'input', { ...op, nonce: v.nonce, input }, signal),
    endBrowserViewerControl: (v, controllerId, controlEpoch, action) =>
      request(v, 'hand-back', { nonce: v.nonce, controllerId, controlEpoch, action }),
    copyBrowserViewerSelection: (v, op, signal) =>
      request(v, 'copy', { ...op, nonce: v.nonce }, signal),
    pasteBrowserViewerText: (v, op, text, signal) =>
      request(v, 'paste', { ...op, nonce: v.nonce, text }, signal),
    uploadBrowserViewerFiles: (v, op, ticketId, files, signal) => {
      const data = new FormData();
      for (const file of files) data.append('files', file, file.name);
      return request(v, 'files', { ...op, nonce: v.nonce, ticketId }, signal, data);
    },
    cancelBrowserViewerFiles: (v, controllerId, controlEpoch, ticketId) =>
      request(v, 'files', {
        nonce: v.nonce,
        controllerId,
        controlEpoch,
        ticketId,
        action: 'cancel',
      }),
  };
}
