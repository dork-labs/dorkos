import {
  CanvasChannelPresenceRequestSchema,
  CanvasChannelPresenceResponseSchema,
  type CanvasChannelPresenceRequest,
  type CanvasChannelPresenceResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  CanvasChannelSelectionRequestSchema,
  CanvasChannelEventReceiptSchema,
  type CanvasChannelSelectionRequest,
} from '@dorkos/shared/canvas-channel-schemas';
/** Thin document event calls. Scope and caller identity are resolved by the server. */
import type {
  CanvasChannelDeclaration,
  CanvasChannelBatchReplayRequest,
  CanvasChannelBatchReplayResult,
  CanvasChannelRouteGrantRequest,
  CanvasChannelRouteApprovalResult,
  CanvasChannelManagementSnapshot,
  CanvasChannelTokenRequest,
  CanvasChannelTokenResponse,
  CanvasChannelCheckboxRequest,
  CanvasChannelCheckboxReceipt,
  PageEvent,
  CanvasChannelEventReceipt,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  CanvasChannelRouteApprovalResultSchema,
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelTokenResponseSchema,
  CanvasChannelCheckboxReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { fetchJSON, fetchResponse } from './http-client';
/** Bind document event methods to an API URL. */
export function createCanvasDocMethods(baseUrl: string) {
  const documentPath = (id: string) => `/canvas/docs/${encodeURIComponent(id)}`;
  return {
    async updateCanvasDocPresence(
      documentId: string,
      raw: CanvasChannelPresenceRequest
    ): Promise<CanvasChannelPresenceResponse> {
      const request = CanvasChannelPresenceRequestSchema.parse(raw);
      return CanvasChannelPresenceResponseSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(documentId)}/presence`, {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
    },

    async askCanvasDocSelection(
      raw: CanvasChannelSelectionRequest
    ): Promise<CanvasChannelEventReceipt> {
      const request = CanvasChannelSelectionRequestSchema.parse(raw);
      const result = CanvasChannelEventReceiptSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(request.documentId)}/editor/selection`, {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
      if (result.receipt.id !== request.eventId)
        throw new Error('Selection receipt belongs to another original operation.');
      return result;
    },
    async replayCanvasDocBatch(
      raw: CanvasChannelBatchReplayRequest
    ): Promise<CanvasChannelBatchReplayResult> {
      const request = CanvasChannelBatchReplayRequestSchema.parse(raw);
      const response = CanvasChannelBatchReplayResultSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(request.documentId)}/manage/replay`, {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
      if (
        response.documentId !== request.documentId ||
        response.eventId !== request.eventId ||
        response.previousBatchId !== request.batchId
      )
        throw new Error('The replay receipt belongs to another reviewed operation.');
      return response;
    },
    async configureCanvasDocChannel(
      documentId: string,
      channel: CanvasChannelDeclaration,
      openerAgentId?: string
    ): Promise<{ configured: true }> {
      const response = await fetchJSON<{ configured: true }>(
        baseUrl,
        `${documentPath(documentId)}/manage/configure`,
        {
          method: 'POST',
          body: JSON.stringify({
            documentId,
            channel,
            ...(openerAgentId ? { openerAgentId } : {}),
          }),
        }
      );
      if (response.configured !== true) throw new Error('Document declaration was not confirmed.');
      return response;
    },
    async approveCanvasDocRoute(
      request: CanvasChannelRouteGrantRequest,
      routeApprovalToken?: string
    ): Promise<CanvasChannelRouteApprovalResult> {
      return CanvasChannelRouteApprovalResultSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(request.documentId)}/manage/approve`, {
          method: 'POST',
          body: JSON.stringify({
            ...request,
            ...(routeApprovalToken ? { routeApprovalToken } : {}),
          }),
        })
      );
    },
    async revokeCanvasDocRoute(documentId: string, grantId: string): Promise<{ revoked: true }> {
      const response = await fetchJSON<{ revoked: true }>(
        baseUrl,
        `${documentPath(documentId)}/manage/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({ documentId, grantId }),
        }
      );
      if (response.revoked !== true)
        throw new Error('Document route revocation was not confirmed.');
      return response;
    },
    async getCanvasDocManagement(documentId: string): Promise<CanvasChannelManagementSnapshot> {
      const response = CanvasChannelManagementSnapshotSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(documentId)}/management`)
      );
      if (response.documentId !== documentId)
        throw new Error('Document controls belong to another document.');
      return response;
    },
    async issueCanvasDocToken(
      request: CanvasChannelTokenRequest,
      approvedGrantIds: readonly string[]
    ): Promise<CanvasChannelTokenResponse> {
      const response = CanvasChannelTokenResponseSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(request.documentId)}/tokens`, {
          method: 'POST',
          body: JSON.stringify({ request, approvedGrantIds }),
        })
      );
      if (
        response.documentId !== request.documentId ||
        response.expiresAt !== request.expiresAt ||
        JSON.stringify(response.allowedTypes) !== JSON.stringify(request.allowedTypes) ||
        JSON.stringify(response.directions) !== JSON.stringify(request.directions) ||
        JSON.stringify(response.permissions) !== JSON.stringify(request.permissions)
      )
        throw new Error('The issued document token does not match the requested scope.');
      return response;
    },
    async revokeCanvasDocToken(
      documentId: string,
      tokenId: string
    ): Promise<{ tokenId: string; revokedAt: string }> {
      const response = await fetchJSON<{ tokenId: string; revokedAt: string }>(
        baseUrl,
        `${documentPath(documentId)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
        { method: 'POST', body: '{}' }
      );
      if (
        response.tokenId !== tokenId ||
        typeof response.revokedAt !== 'string' ||
        !Number.isFinite(Date.parse(response.revokedAt))
      )
        throw new Error('The document token revocation does not match the request.');
      return response;
    },
    async toggleCanvasCheckbox(
      request: CanvasChannelCheckboxRequest
    ): Promise<CanvasChannelCheckboxReceipt> {
      const receipt = CanvasChannelCheckboxReceiptSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(request.documentId)}/checkbox`, {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
      const eventId = receipt.status === 'changed' ? receipt.receipt.id : receipt.eventId;
      if (eventId !== request.eventId)
        throw new Error('The checkbox receipt does not match the pending event.');
      return receipt;
    },
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
