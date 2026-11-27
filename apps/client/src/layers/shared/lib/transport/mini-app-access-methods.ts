/**
 * Which mini apps may read which connected apps (DOR-3547). No approve here:
 * a yes is given only on its own page, outside the app. The list goes through
 * the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/mini-app-access-methods
 */
import type {
  MiniAppAccessList,
  MiniAppAccessRevokeResponse,
} from '@dorkos/shared/mini-app-access-schemas';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/** Create the mini app access methods bound to a base URL. */
export function createMiniAppAccessMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getMiniAppAccess(): Promise<MiniAppAccessList> {
      return api.call('connectors.getMiniAppAccess', {});
    },

    // Stays hand-written: sends a `{}` body the document does not describe (DOR-5473).
    revokeMiniAppAccess(approvalId: string): Promise<MiniAppAccessRevokeResponse> {
      return fetchJSON<MiniAppAccessRevokeResponse>(
        baseUrl,
        `/connectors/mini-app-access/${encodeURIComponent(approvalId)}/revoke`,
        { method: 'POST', body: '{}' }
      );
    },
  };
}
