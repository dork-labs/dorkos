/**
 * Remote access Transport methods factory (DOR-2086): the one report every
 * remote-access surface reads, and the person's actions on DorkOS managed
 * remote access, under `/api/remote-access`. Every write answers with the full
 * report. The person's own ngrok tunnel keeps `startTunnel`/`stopTunnel` in
 * `system-methods.ts`.
 *
 * @module shared/lib/transport/remote-access-methods
 */
import type { RemoteAccessReport } from '@dorkos/shared/types';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import { fetchJSON } from './http-client';

/**
 * Create the remote access methods bound to a base URL.
 *
 * @param baseUrl - The API base, e.g. `/api`.
 */
export function createRemoteAccessMethods(baseUrl: string) {
  return {
    getRemoteAccessReport(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/report');
    },

    startRemoteEnrolment(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/enrolment', {
        method: 'POST',
      });
    },

    setRemoteAccessMode(mode: RemoteAccessMode): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    },

    closeRemoteAccess(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/close', { method: 'POST' });
    },

    withdrawRemoteAccess(): Promise<RemoteAccessReport> {
      return fetchJSON<RemoteAccessReport>(baseUrl, '/remote-access/withdraw', {
        method: 'POST',
      });
    },
  };
}
