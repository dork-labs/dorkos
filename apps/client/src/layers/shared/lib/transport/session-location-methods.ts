/**
 * HTTP transport for a private chat source and its acknowledged draft, through
 * the generated API client (DOR-5473).
 */
import type {
  SessionAllocationReceipt,
  SessionAllocationSource,
  Transport,
} from '@dorkos/shared/transport';
import { z } from 'zod';
import { createTransportApiClient } from './api-client';

const allocationReceipt = z.object({ sessionId: z.uuid(), launchRef: z.uuid().optional() });

/** Bind the local server's existing source operations to the active transport. */
export function createSessionLocationMethods(
  baseUrl: string
): Pick<Transport, 'allocateSession' | 'createSessionLocation' | 'getSessionLocation'> {
  const api = createTransportApiClient(baseUrl);
  return {
    createSessionLocation(cwd: string): Promise<{ id: string }> {
      return api.call('sessionLocations.create', { body: { cwd } });
    },

    async allocateSession(source: SessionAllocationSource): Promise<SessionAllocationReceipt> {
      const result =
        source.kind === 'location'
          ? await api.call('sessionLocations.createChats', {
              path: { id: source.launchRef },
              body: {},
            })
          : await api.call('sessionLocations.createAgentChat', {
              body: { kind: 'registered-agent', agentId: source.agentId },
            });
      return allocationReceipt.parse(result);
    },

    getSessionLocation(id: string): Promise<{ cwd: string }> {
      return api.call('sessionLocations.get', { path: { id } });
    },
  };
}
