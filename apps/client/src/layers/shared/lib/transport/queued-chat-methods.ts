/**
 * The Transport method for sending another chat's queued message now (DOR-3060).
 *
 * @module shared/lib/transport/queued-chat-methods
 */
import {
  SteerQueuedChatMessageResponseSchema,
  type SteerQueuedChatMessageResponse,
} from '@dorkos/shared/schemas';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 * @param getClientId - This window's client id.
 */
export function createQueuedChatMethods(baseUrl: string, getClientId: () => string) {
  return {
    async steerQueuedChatMessage(
      sessionId: string,
      messageId: string
    ): Promise<SteerQueuedChatMessageResponse> {
      const data = await fetchJSON<unknown>(
        baseUrl,
        `/sessions/${sessionId}/queue/${encodeURIComponent(messageId)}/steer`,
        { method: 'POST', headers: { 'X-Client-Id': getClientId() } }
      );
      return SteerQueuedChatMessageResponseSchema.parse(data);
    },
  };
}
