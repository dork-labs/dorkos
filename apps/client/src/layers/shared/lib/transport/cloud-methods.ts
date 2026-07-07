/**
 * Cloud-link Transport methods factory — links this instance to a DorkOS account
 * via the local `/api/cloud/*` routes (accounts-and-auth P2). These are
 * independent of local login: the panel that drives them is always available.
 *
 * @module shared/lib/transport/cloud-methods
 */
import type {
  CloudLinkStatus,
  CloudLinkSummary,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the cloud-account-link methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createCloudMethods(baseUrl: string) {
  return {
    startCloudLink(): Promise<StartLinkResult> {
      return fetchJSON<StartLinkResult>(baseUrl, '/cloud/link/start', { method: 'POST' });
    },

    getCloudLinkStatus(): Promise<CloudLinkStatus> {
      return fetchJSON<CloudLinkStatus>(baseUrl, '/cloud/link/status');
    },

    unlinkCloud(): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, '/cloud/unlink', { method: 'POST' });
    },

    getCloudStatus(): Promise<CloudLinkSummary> {
      return fetchJSON<CloudLinkSummary>(baseUrl, '/cloud/status');
    },
  };
}
