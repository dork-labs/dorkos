/**
 * Signed-in devices Transport method factory (F4 part 2, DOR-2969): the
 * person's own sign-ins, and signing them out (`/api/devices`).
 *
 * @module shared/lib/transport/device-methods
 */
import type {
  SignedInDeviceList,
  SignOutEverywhereElseResult,
} from '@dorkos/shared/signed-in-devices';
import { fetchJSON, fetchNoContent } from './http-client';

/**
 * Create the signed-in devices methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createDeviceMethods(baseUrl: string) {
  return {
    listSignedInDevices(): Promise<SignedInDeviceList> {
      return fetchJSON(baseUrl, '/devices/sessions');
    },
    signOutDevice(id: string): Promise<void> {
      return fetchNoContent(baseUrl, `/devices/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    signOutEverywhereElse(): Promise<SignOutEverywhereElseResult> {
      return fetchJSON(baseUrl, '/devices/sign-out-all', { method: 'POST' });
    },
  };
}
