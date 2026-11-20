/**
 * What the owner does at the computer DorkOS runs on about Wi-Fi devices
 * (DOR-4744): approve or decline a device asking to sign in, and let one
 * Wi-Fi device run agents, or stop it.
 *
 * Approving and turning "run agents" on each take a fresh passkey check the
 * person does in this browser, never a password: the server answers the first
 * call with the check, this runs it, and the second call carries its answer.
 *
 * @module features/auth/model/use-device-trust
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WifiSignInRequest } from '@dorkos/shared/signed-in-devices';
import { signedInDevicesKey } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { withPasskeyCheck } from '../lib/passkey-ceremony';

/** TanStack Query key for the waiting Wi-Fi sign-ins. */
export const wifiSignInRequestsKey = ['devices', 'wifi-sign-in-requests'] as const;

/** How often the waiting list is read again while it is on screen. */
const POLL_MS = 3000;

/** A code shown after approving one request. */
export interface ShownCode {
  readonly code: string;
  readonly expiresAt: string;
}

/** What the devices section reads and does about Wi-Fi devices. */
export interface DeviceTrust {
  /** Devices waiting to sign in, newest first. */
  readonly requests: readonly WifiSignInRequest[];
  /** Codes shown, by request id. */
  readonly codes: Readonly<Record<string, ShownCode>>;
  /** The id of the request or device being changed, or `null`. */
  readonly pendingId: string | null;
  /** Set when an action needs a passkey on this computer and there is none. */
  readonly needsPasskey: boolean;
  /** The last failure, in a sentence; `null` when none. */
  readonly error: string | null;
  /**
   * The request or device the last action was for, so its passkey note or
   * failure shows beside it; `null` before any.
   */
  readonly lastId: string | null;
  /** Approve one request after a fresh passkey check. */
  approve(id: string): Promise<void>;
  /** Decline one request. */
  decline(id: string): Promise<void>;
  /** Let one Wi-Fi device run agents, or stop it. */
  setRunsAgents(deviceId: string, on: boolean): Promise<void>;
}

/** A sentence for a failure. */
function sentenceOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'The passkey check was cancelled. Nothing changed.';
  }
  if ((error as { status?: number } | null)?.status === 404) {
    return 'That request has ended. Ask the device to try again.';
  }
  return 'That didn’t work. Nothing changed. Try again.';
}

/**
 * Approve Wi-Fi devices and choose which may run agents.
 *
 * @param enabled - Whether to read the waiting list: only at this computer.
 */
export function useDeviceTrust(enabled: boolean): DeviceTrust {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<Record<string, ShownCode>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: wifiSignInRequestsKey,
    queryFn: () => transport.listWifiSignInRequests(),
    enabled,
    retry: false,
    refetchInterval: enabled ? POLL_MS : false,
  });

  const act = async (id: string, run: () => Promise<void>) => {
    setPendingId(id);
    setLastId(id);
    setError(null);
    setNeedsPasskey(false);
    try {
      await run();
    } catch (failure) {
      setError(sentenceOf(failure));
    } finally {
      setPendingId(null);
      void queryClient.invalidateQueries({ queryKey: wifiSignInRequestsKey });
      void queryClient.invalidateQueries({ queryKey: signedInDevicesKey });
    }
  };

  return {
    requests: list.data?.requests ?? [],
    codes,
    pendingId,
    needsPasskey,
    error,
    lastId,
    approve: (id) =>
      act(id, async () => {
        const result = await withPasskeyCheck((passkey) =>
          transport.approveWifiSignIn(id, passkey)
        );
        if (result.kind === 'needs-passkey') setNeedsPasskey(true);
        else if (result.kind === 'approved') {
          setCodes((shown) => ({
            ...shown,
            [id]: { code: result.code, expiresAt: result.expiresAt },
          }));
        }
      }),
    decline: (id) => act(id, () => transport.declineWifiSignIn(id)),
    setRunsAgents: (deviceId, on) =>
      act(deviceId, async () => {
        const result = await withPasskeyCheck((passkey) =>
          transport.setDeviceRunsAgents(deviceId, on, passkey)
        );
        if (result.kind === 'needs-passkey') setNeedsPasskey(true);
      }),
  };
}
