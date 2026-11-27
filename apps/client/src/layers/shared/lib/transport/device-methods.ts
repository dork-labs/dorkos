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
  type AuthenticatorStartStep,
  type OwnerFactorList,
  type PasskeyCheckedStep,
  type PasskeyStartStep,
  type PendingAuthenticator,
  type SignedInDeviceList,
  type SignOutEverywhereElseResult,
  type WifiSignInApprovalStep,
  type WifiSignInRequestList,
} from '@dorkos/shared/signed-in-devices';
import { createTransportApiClient } from './api-client';
import { fetchJSON, fetchNoContent } from './http-client';

/** The fields of an error `http-client` throws that these methods read. */
type HttpError = Error & { code?: string; status?: number; body?: { options?: unknown } };

/**
 * The step a refusal from a passkey-checked action stands for, or `null`
 * when it is a real failure to throw.
 */
function passkeyStepOf(error: unknown): Exclude<PasskeyCheckedStep, { kind: 'done' }> | null {
  const { status, code, body } = error as HttpError;
  if (status === 428 && code === PASSKEY_CHECK_CODE && body?.options) {
    return { kind: 'passkey-check', options: body.options };
  }
  if (status === 409 && code === PASSKEY_NEEDED_CODE) return { kind: 'needs-passkey' };
  return null;
}

/**
 * Create the signed-in devices methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createDeviceMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async listSignedInDevices(): Promise<SignedInDeviceList> {
      return (await api.call('devices.listSessions', {})) as SignedInDeviceList;
    },
    async signOutDevice(id: string): Promise<void> {
      await api.call('devices.deleteSessions', { path: { id } });
    },
    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    signOutEverywhereElse(): Promise<SignOutEverywhereElseResult> {
      return fetchJSON(baseUrl, '/devices/sign-out-all', { method: 'POST' });
    },
    async setDeviceRunsAgents(
      id: string,
      on: boolean,
      passkey?: unknown
    ): Promise<PasskeyCheckedStep> {
      try {
        await api.call('devices.updateSessionsRunsAgents', {
          path: { id },
          body: passkey === undefined ? { on } : { on, passkey },
        });
        return { kind: 'done' };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
    },
    async listWifiSignInRequests(): Promise<WifiSignInRequestList> {
      return (await api.call('devices.getSignInRequests', {})) as WifiSignInRequestList;
    },
    async approveWifiSignIn(id: string, passkey?: unknown): Promise<WifiSignInApprovalStep> {
      try {
        const approved = (await api.call('devices.approveSignInRequests', {
          path: { id },
          body: passkey === undefined ? {} : { passkey },
        })) as { code: string; expiresAt: string };
        return { kind: 'approved', ...approved };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
    },
    async declineWifiSignIn(id: string): Promise<void> {
      // Sends no body: the document gives it none and the route reads none.
      await api.call('devices.declineSignInRequests', { path: { id } });
    },
    async listOwnerFactors(): Promise<OwnerFactorList> {
      return (await api.call('ownerFactors.list', {})) as OwnerFactorList;
    },
    // Stays hand-written: the API document leaves out its `passkey` field (DOR-5473).
    async startAddingPasskey(label: string, passkey?: unknown): Promise<PasskeyStartStep> {
      try {
        const { options } = await fetchJSON<{ options: unknown }>(
          baseUrl,
          '/owner-factors/passkeys/options',
          {
            method: 'POST',
            body: JSON.stringify(passkey === undefined ? { label } : { label, passkey }),
          }
        );
        return { kind: 'options', options };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
    },
    async finishAddingPasskey(response: unknown): Promise<{ id: string; host: string }> {
      return (await api.call('ownerFactors.finishPasskeys', { body: { response } })) as {
        id: string;
        host: string;
      };
    },
    // Stays hand-written: the API document leaves out its `passkey` field (DOR-5473).
    async startAddingAuthenticator(
      label: string,
      passkey?: unknown
    ): Promise<AuthenticatorStartStep> {
      try {
        const pending = await fetchJSON<PendingAuthenticator>(
          baseUrl,
          '/owner-factors/authenticator/start',
          {
            method: 'POST',
            body: JSON.stringify(passkey === undefined ? { label } : { label, passkey }),
          }
        );
        return { kind: 'started', pending };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
    },
    async confirmAuthenticator(id: string, code: string): Promise<{ id: string }> {
      return (await api.call('ownerFactors.confirmAuthenticator', { body: { id, code } })) as {
        id: string;
      };
    },
    // Stays hand-written: the API document gives this delete no body, and it sends one (DOR-5473).
    async removeOwnerFactor(id: string, passkey?: unknown): Promise<PasskeyCheckedStep> {
      try {
        await fetchNoContent(baseUrl, `/owner-factors/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          body: JSON.stringify(passkey === undefined ? {} : { passkey }),
        });
        return { kind: 'done' };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
    },
  };
}
