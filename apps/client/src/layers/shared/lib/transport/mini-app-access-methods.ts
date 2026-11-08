/**
 * Which mini apps may read which connected apps (DOR-3547). No approve here:
 * a yes is given only on its own page, outside the app.
 *
 * @module shared/lib/transport/mini-app-access-methods
 */
import type {
  MiniAppAccessList,
  MiniAppAccessRevokeResponse,
} from '@dorkos/shared/mini-app-access-schemas';
import { fetchJSON } from './http-client';

/** Create the mini app access methods bound to a base URL. */
export function createMiniAppAccessMethods(baseUrl: string) {
  return {
    getMiniAppAccess(): Promise<MiniAppAccessList> {
      return fetchJSON<MiniAppAccessList>(baseUrl, '/connectors/mini-app-access');
    },

    revokeMiniAppAccess(approvalId: string): Promise<MiniAppAccessRevokeResponse> {
      return fetchJSON<MiniAppAccessRevokeResponse>(
        baseUrl,
        `/connectors/mini-app-access/${encodeURIComponent(approvalId)}/revoke`,
        { method: 'POST', body: '{}' }
      );
    },
  };
}
