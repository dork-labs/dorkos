/** Thin document event calls. Scope and caller identity are resolved by the server. */
import type {
  PageEvent,
  CanvasChannelEventReceipt,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { fetchJSON, fetchResponse } from './http-client';
/** Bind document event methods to an API URL. */
export function createCanvasDocMethods(baseUrl: string) {
  const documentPath = (id: string) => `/canvas/docs/${encodeURIComponent(id)}`;
  return {
    // Bound Doc operations own one deadline on this exact controller. The HTTP helper must
    // not replace its signal with a second timeout signal; replay retains the normal timeout.
    async ingestCanvasEvent(
      documentId: string,
      event: PageEvent,
      condition: { readonly expectedGeneration: string },
      signal: AbortSignal
    ): Promise<CanvasChannelEventReceipt> {
      const response = await fetchResponse(baseUrl, `${documentPath(documentId)}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'X-DorkOS-Doc-Generation': condition.expectedGeneration },
        signal,
        timeout: null,
      });
      return response.json() as Promise<CanvasChannelEventReceipt>;
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
    // Inspection uses the original operation lifetime too, including ambiguous acceptance.
    async getCanvasEventReceipt(
      documentId: string,
      eventId: string,
      condition: { readonly expectedGeneration: string },
      signal: AbortSignal
    ): Promise<CanvasChannelEventReceipt> {
      const response = await fetchResponse(
        baseUrl,
        `${documentPath(documentId)}/events/${encodeURIComponent(eventId)}`,
        {
          headers: { 'X-DorkOS-Doc-Generation': condition.expectedGeneration },
          signal,
          timeout: null,
        }
      );
      return response.json() as Promise<CanvasChannelEventReceipt>;
    },
  };
}
