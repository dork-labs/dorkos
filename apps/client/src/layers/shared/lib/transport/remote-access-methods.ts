/**
 * Remote access Transport methods factory (DOR-2086): the one report every
 * remote-access surface reads, and the person's actions on DorkOS managed
 * remote access, under `/api/remote-access`. Every write answers with the full
 * report. The person's own ngrok tunnel keeps `startTunnel`/`stopTunnel` in
 * `system-methods.ts`. Documented calls go through the generated API client
 * (DOR-5473).
 *
 * @module shared/lib/transport/remote-access-methods
 */
import type { LanAccessStatus, RemoteAccessReport } from '@dorkos/shared/types';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * Create the remote access methods bound to a base URL.
 *
 * @param baseUrl - The API base, e.g. `/api`.
 */
export function createRemoteAccessMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // Stays hand-written: `GET /api/remote-access/report` has no operationId (DOR-5473).
    getRemoteAccessReport(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/report');
    },

    async startRemoteEnrolment(): Promise<RemoteAccessReport> {
      return (await api.call('remoteAccess.createEnrolment', {})) as RemoteAccessReport;
    },

    async setRemoteAccessMode(mode: RemoteAccessMode): Promise<RemoteAccessReport> {
      const answer = await api.call('remoteAccess.createMode', { body: { mode } });
      // The document does not describe this answer yet, so the cast keeps today's type.
      return answer as RemoteAccessReport;
    },

    // Stays hand-written: `POST /api/remote-access/close` has no operationId (DOR-5473).
    closeRemoteAccess(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/close', { method: 'POST' });
    },

    // Stays hand-written: `POST /api/remote-access/withdraw` has no operationId (DOR-5473).
    withdrawRemoteAccess(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/withdraw', {
        method: 'POST',
      });
    },

    // Stays hand-written: `GET /api/lan-access` has no operationId (DOR-5473).
    getLanAccess(): Promise<LanAccessStatus> {
      return fetchJSON<LanAccessStatus>(baseUrl, '/lan-access');
    },

    async setLanAccess(enabled: boolean): Promise<LanAccessStatus> {
      const answer = await api.call('lanAccess.create', { body: { enabled } });
      // The document does not describe this answer yet, so the cast keeps today's type.
      return answer as LanAccessStatus;
    },
  };
}
