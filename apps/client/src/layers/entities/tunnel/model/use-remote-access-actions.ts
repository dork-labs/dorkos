/**
 * Turning remote access on and off — the ONE implementation.
 *
 * Three surfaces flip this switch (the Remote Access dialog, the Control Center
 * row, the ⌘K palette) and all three call these functions. Anything else would
 * be a second copy of the 409 handling, the exposure guard and the toast
 * suppression, and two copies of a rule are two rules.
 *
 * @module entities/tunnel/model/use-remote-access-actions
 */

import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { requestOwnerSetup } from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';
import { broadcastTunnelChange } from './use-tunnel-sync';
import { useRemoteAccessStore } from './remote-access-store';

/** Stable handlers returned by {@link useRemoteAccessActions}. */
export interface RemoteAccessActionHandlers {
  /** Open the tunnel. Resolves once the attempt has settled, however it settled. */
  start: () => Promise<void>;
  /** Close the tunnel. */
  stop: () => Promise<void>;
  /** Flip it, the shape a `<Switch>` hands you. */
  toggle: (on: boolean) => Promise<void>;
  /** Forget a failure that something else has answered. */
  clearError: () => void;
}

/**
 * The start/stop handlers for remote access.
 *
 * @returns Stable {@link RemoteAccessActionHandlers}.
 */
export function useRemoteAccessActions(): RemoteAccessActionHandlers {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // Ref so the exposure-guard retry (`onComplete`) can re-invoke the latest
  // start closure without making the callback depend on itself.
  const startRef = useRef<() => Promise<void>>(undefined);

  // One clock, and it belongs to the request. An earlier version armed a 15s
  // timer of its own over a call the transport already times out at 30s, so a
  // start that took longer than 15s showed "Tunnel timed out after 15 seconds"
  // while the request was still in flight — and then flipped the very same
  // dialog to connected when it succeeded at, say, 20s (DOR-1739). The
  // transport's timeout is the honest answer, so it is the only one anything
  // here hears.
  const start = useCallback(async () => {
    useRemoteAccessStore.getState().beginStart();
    try {
      const result = await transport.startTunnel();
      useRemoteAccessStore.getState().settleStart(result.url);
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    } catch (err) {
      const refusal = err as { code?: string; status?: number; body?: { url?: string | null } };

      // Exposing an unprotected instance is blocked (409). Route the person
      // into owner-account creation, then retry the start once login is on.
      if (refusal.code === 'AUTH_REQUIRED_FOR_EXPOSURE') {
        useRemoteAccessStore.getState().abandonStart();
        requestOwnerSetup({
          reason: 'exposure',
          message: 'Exposing DorkOS requires a login.',
          onComplete: () => void startRef.current?.(),
        });
        return;
      }

      // The route's OTHER 409 is "Tunnel is already running", and it is not a
      // failure — it is the answer converging on a tunnel that is up. Painting
      // an error over a live tunnel is how a person ends up turning off working
      // remote access to fix it. Reachable for real now that ngrok reconnects
      // are reported (DOR-1738): a start pressed during one is a no-op.
      if (refusal.status === 409) {
        useRemoteAccessStore.getState().convergeStart(refusal.body?.url ?? null);
        queryClient.invalidateQueries({ queryKey: configKeys.all });
        broadcastTunnelChange();
        return;
      }

      useRemoteAccessStore
        .getState()
        .failStart(err instanceof Error ? err.message : 'Failed to start tunnel');
    }
  }, [transport, queryClient]);

  // Keep the retry ref pointing at the latest closure (the exposure retry fires
  // long after render, once owner setup completes).
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  const stop = useCallback(async () => {
    useRemoteAccessStore.getState().beginStop();
    try {
      await transport.stopTunnel();
      useRemoteAccessStore.getState().settleStop();
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    } catch (err) {
      useRemoteAccessStore
        .getState()
        .failStop(err instanceof Error ? err.message : 'Failed to stop tunnel');
    }
  }, [transport, queryClient]);

  const toggle = useCallback(
    async (on: boolean) => {
      if (on) await start();
      else await stop();
    },
    [start, stop]
  );

  const clearError = useCallback(() => {
    useRemoteAccessStore.getState().clearError();
  }, []);

  return { start, stop, toggle, clearError };
}
