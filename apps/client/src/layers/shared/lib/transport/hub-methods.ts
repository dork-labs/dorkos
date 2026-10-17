/**
 * Hub Transport method factory (step B3, DOR-2946): a hub owner's linked
 * computers. Off a hub every call rejects with the `/api` 404.
 *
 * @module shared/lib/transport/hub-methods
 */
import type { HubComputerList, HubLinkCode } from '@dorkos/shared/session-relay-link';
import { fetchJSON, fetchNoContent } from './http-client';

/**
 * Create the hub methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createHubMethods(baseUrl: string) {
  return {
    listHubComputers(): Promise<HubComputerList> {
      return fetchJSON(baseUrl, '/hub/computers');
    },
    createHubLinkCode(): Promise<HubLinkCode> {
      return fetchJSON(baseUrl, '/hub/computers/link-code', { method: 'POST' });
    },
    removeHubComputer(computerId: string): Promise<void> {
      return fetchNoContent(baseUrl, `/hub/computers/${encodeURIComponent(computerId)}`, {
        method: 'DELETE',
      });
    },
  };
}
