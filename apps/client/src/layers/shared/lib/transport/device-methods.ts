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
    async setDeviceRunsAgents(
      id: string,
      on: boolean,
      passkey?: unknown
    ): Promise<PasskeyCheckedStep> {
      try {
        await fetchNoContent(baseUrl, `/devices/sessions/${encodeURIComponent(id)}/runs-agents`, {
          method: 'PUT',
          body: JSON.stringify(passkey === undefined ? { on } : { on, passkey }),
        });
        return { kind: 'done' };
      } catch (error) {
        const step = passkeyStepOf(error);
        if (step) return step;
        throw error;
      }
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
        const step = passkeyStepOf(error);
        if (step) return step;
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
    listOwnerFactors(): Promise<OwnerFactorList> {
      return fetchJSON(baseUrl, '/owner-factors');
    },
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
    finishAddingPasskey(response: unknown): Promise<{ id: string; host: string }> {
      return fetchJSON(baseUrl, '/owner-factors/passkeys/finish', {
        method: 'POST',
        body: JSON.stringify({ response }),
      });
    },
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
    confirmAuthenticator(id: string, code: string): Promise<{ id: string }> {
      return fetchJSON(baseUrl, '/owner-factors/authenticator/confirm', {
        method: 'POST',
        body: JSON.stringify({ id, code }),
      });
    },
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
