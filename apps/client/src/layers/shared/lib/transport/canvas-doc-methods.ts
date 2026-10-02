/** Thin document event calls. Scope and caller identity are resolved by the server. */
import type {
  PageEvent,
  CanvasChannelEventReceipt,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { fetchJSON } from './http-client';
/** Bind document event methods to an API URL. */
export function createCanvasDocMethods(baseUrl: string) {
  const documentPath = (id: string) => `/canvas/docs/${encodeURIComponent(id)}`;
  return {
    ingestCanvasEvent(documentId: string, event: PageEvent): Promise<CanvasChannelEventReceipt> {
      return fetchJSON(baseUrl, `${documentPath(documentId)}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
      });
    },
    getCanvasChannel(
      documentId: string,
      query?: { since?: number; limit?: number }
    ): Promise<CanvasChannelReplayResponse> {
      const params = new URLSearchParams();
      if (query?.since !== undefined) params.set('since', String(query.since));
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size ? `?${params}` : '';
      return fetchJSON(baseUrl, `${documentPath(documentId)}/channel${suffix}`);
    },
    getCanvasEventReceipt(documentId: string, eventId: string): Promise<CanvasChannelEventReceipt> {
      return fetchJSON(
        baseUrl,
        `${documentPath(documentId)}/events/${encodeURIComponent(eventId)}`
      );
    },
  };
}
