/** HTTP transport for a private chat source and its acknowledged draft. */
import type {
  SessionAllocationReceipt,
  SessionAllocationSource,
  Transport,
} from '@dorkos/shared/transport';
import { z } from 'zod';
import { fetchJSON } from './http-client';

const allocationReceipt = z.object({ sessionId: z.uuid(), launchRef: z.uuid().optional() });

/** Bind the local server's existing source operations to the active transport. */
export function createSessionLocationMethods(
  baseUrl: string
): Pick<Transport, 'allocateSession' | 'createSessionLocation' | 'getSessionLocation'> {
  return {
    // Stays hand-written: `POST /api/session-locations` has no operationId (DOR-5473).
    createSessionLocation(cwd: string): Promise<{ id: string }> {
      return fetchJSON(baseUrl, '/session-locations', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      });
    },

    // Stays hand-written: the `/api/session-locations/.../chats` paths have no
    // operationId (DOR-5473).
    async allocateSession(source: SessionAllocationSource): Promise<SessionAllocationReceipt> {
      const savedFolder = source.kind === 'location';
      const path = savedFolder
        ? `/session-locations/${encodeURIComponent(source.launchRef)}/chats`
        : '/session-locations/chats';
      const result = await fetchJSON<unknown>(baseUrl, path, {
        method: 'POST',
        body: JSON.stringify(
          savedFolder ? {} : { kind: 'registered-agent', agentId: source.agentId }
        ),
      });
      return allocationReceipt.parse(result);
    },

    // Stays hand-written: `GET /api/session-locations/{id}` has no operationId (DOR-5473).
    getSessionLocation(id: string): Promise<{ cwd: string }> {
      return fetchJSON(baseUrl, `/session-locations/${encodeURIComponent(id)}`);
    },
  };
}
