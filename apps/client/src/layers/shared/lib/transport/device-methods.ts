/**
 * Signed-in devices Transport method factory (F4 part 2, DOR-2969): the
 * person's own sign-ins, and signing them out (`/api/devices`). Also the Wi-Fi
 * sign-in requests this computer approves, and what one Wi-Fi device may do
 * (DOR-4744).
 *
 * @module shared/lib/transport/device-methods
 */
import {
  PASSKEY_CHECK_CODE,
  PASSKEY_NEEDED_CODE,
  type SignedInDeviceList,
  type SignOutEverywhereElseResult,
  type WifiSignInApprovalStep,
  type WifiSignInRequestList,
} from '@dorkos/shared/signed-in-devices';
import { fetchJSON, fetchNoContent } from './http-client';

/** The fields of an error `http-client` throws that these methods read. */
type HttpError = Error & { code?: string; status?: number; body?: { options?: unknown } };

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
    setDeviceRunsAgents(id: string, on: boolean): Promise<void> {
      return fetchNoContent(baseUrl, `/devices/sessions/${encodeURIComponent(id)}/runs-agents`, {
        method: 'PUT',
        body: JSON.stringify({ on }),
      });
    },
    listWifiSignInRequests(): Promise<WifiSignInRequestList> {
      return fetchJSON(baseUrl, '/devices/sign-in-requests');
    },
    async approveWifiSignIn(id: string, passkey?: unknown): Promise<WifiSignInApprovalStep> {
      try {
        const approved = await fetchJSON<{ code: string; expiresAt: string }>(
          baseUrl,
          `/devices/sign-in-requests/${encodeURIComponent(id)}/approve`,
          { method: 'POST', body: JSON.stringify(passkey === undefined ? {} : { passkey }) }
        );
        return { kind: 'approved', ...approved };
      } catch (error) {
        const { status, code, body } = error as HttpError;
        if (status === 428 && code === PASSKEY_CHECK_CODE && body?.options) {
          return { kind: 'passkey-check', options: body.options };
        }
        if (status === 409 && code === PASSKEY_NEEDED_CODE) return { kind: 'needs-passkey' };
        throw error;
      }
    },
    declineWifiSignIn(id: string): Promise<void> {
      return fetchNoContent(
        baseUrl,
        `/devices/sign-in-requests/${encodeURIComponent(id)}/decline`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );
    },
  };
}
