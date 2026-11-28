/**
 * The Transport method for sending another chat's queued message now (DOR-3060).
 *
 * @module shared/lib/transport/queued-chat-methods
 */
import {
  SteerQueuedChatMessageResponseSchema,
  type SteerQueuedChatMessageResponse,
} from '@dorkos/shared/schemas';
import { createTransportApiClient } from './api-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 * @param getClientId - This window's client id.
 */
export function createQueuedChatMethods(baseUrl: string, getClientId: () => string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async steerQueuedChatMessage(
      sessionId: string,
      messageId: string
    ): Promise<SteerQueuedChatMessageResponse> {
      const data = await api.call('sessions.createQueueSteer', {
        path: { id: sessionId, messageId },
        headers: { 'X-Client-Id': getClientId() },
      });
      return SteerQueuedChatMessageResponseSchema.parse(data);
    },
  };
}
