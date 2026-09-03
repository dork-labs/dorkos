/**
 * Action handlers for the Remote Access tunnel dialog.
 *
 * Wraps each handler in a stable `useCallback`. Pure functions over the
 * machine state — no local state of its own.
 *
 * Lifted here from `TunnelDialog`, which owned these callbacks inline. Every
 * failure path says what actually went wrong: the server writes a specific
 * sentence for a refused or invalid write, and this is the layer that decides
 * what a person reads instead of it (`lib/tunnel-errors.ts`, DOR-1739).
 *
 * @module features/settings/model/use-tunnel-actions
 */

import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { requestOwnerSetup } from '@/layers/shared/lib';
import { broadcastTunnelChange } from '@/layers/entities/tunnel';
import { describeTunnelWriteFailure } from '../lib/tunnel-errors';
import type { TunnelMachine } from './use-tunnel-machine';
import { configKeys } from '@/layers/entities/config';

interface UseTunnelActionsArgs {
  machine: TunnelMachine;
  transport: Transport;
  queryClient: QueryClient;
}

/** Stable action handlers returned by {@link useTunnelActions}. */
export interface TunnelActions {
  handleToggle: (checked: boolean) => Promise<void>;
  handleSaveToken: () => Promise<void>;
  handleSaveDomain: () => Promise<void>;
}

/**
 * Action handlers for the Remote Access tunnel dialog.
 *
 * Wraps each handler in a stable `useCallback`. Pure functions over the
 * machine state — no local state of its own.
 *
 * @param args - Tunnel machine, transport, and query client
 */
export function useTunnelActions({
  machine,
  transport,
  queryClient,
}: UseTunnelActionsArgs): TunnelActions {
  // Ref so the exposure-guard retry (`onComplete`) can re-invoke the latest
  // start closure without making the callback depend on itself.
  const startTunnelRef = useRef<() => Promise<void>>(undefined);

  // One clock, and it belongs to the request. This used to arm a 15s timer of
  // its own over a call the transport already times out at 30s, so a start that
  // took longer than 15s showed "Tunnel timed out after 15 seconds" while the
  // request was still in flight — and then flipped the very same dialog to
  // connected when it succeeded at, say, 20s (DOR-1739). The transport's timeout
  // is the honest answer, so it is the only one the dialog hears.
  const startTunnel = useCallback(async () => {
    machine.setUserInitiated(true);
    machine.setState('starting');
    machine.setError(null);
    try {
      const result = await transport.startTunnel();
      machine.setState('connected');
      machine.setUrl(result.url);
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    } catch (err) {
      const refusal = err as { code?: string; status?: number; body?: { url?: string | null } };

      // Exposing an unprotected instance is blocked (task 1.3, 409). Route the
      // user into owner-account creation, then retry the start once login is on.
      if (refusal.code === 'AUTH_REQUIRED_FOR_EXPOSURE') {
        machine.setUserInitiated(false);
        machine.setState('off');
        requestOwnerSetup({
          reason: 'exposure',
          message: 'Exposing DorkOS requires a login.',
          onComplete: () => void startTunnelRef.current?.(),
        });
        return;
      }

      // The route's OTHER 409 is "Tunnel is already running", and it is not a
      // failure — it is the answer converging on a tunnel that is up. Painting
      // an error over a live tunnel is how a person ends up turning off working
      // remote access to fix it. Reachable for real now that ngrok reconnects
      // are reported (DOR-1738): a start pressed during one is a no-op.
      //
      // The 409 body carries the live URL, so the usual case settles straight
      // into connected; without one the tunnel is up but unreachable, which is
      // exactly `reconnecting`. The refetch corrects either reading.
      if (refusal.status === 409) {
        const liveUrl = refusal.body?.url ?? machine.url;
        machine.setState(liveUrl ? 'connected' : 'reconnecting');
        if (liveUrl) machine.setUrl(liveUrl);
        queryClient.invalidateQueries({ queryKey: configKeys.all });
        broadcastTunnelChange();
        return;
      }

      // No status change is coming, so the suppression must not stay armed over
      // whatever happens next.
      machine.setUserInitiated(false);
      machine.setState('error');
      machine.setError(err instanceof Error ? err.message : 'Failed to start tunnel');
    }
  }, [machine, transport, queryClient]);
  // Keep the retry ref pointing at the latest closure (the exposure retry fires
  // long after render, once owner setup completes).
  useEffect(() => {
    startTunnelRef.current = startTunnel;
  }, [startTunnel]);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (checked) {
        await startTunnel();
      } else {
        machine.setUserInitiated(true);
        machine.setState('stopping');
        machine.setError(null);
        try {
          await transport.stopTunnel();
          machine.setState('off');
          machine.setUrl(null);
          queryClient.invalidateQueries({ queryKey: configKeys.all });
          broadcastTunnelChange();
        } catch (err) {
          machine.setUserInitiated(false);
          machine.setState('connected');
          machine.setError(err instanceof Error ? err.message : 'Failed to stop tunnel');
        }
      }
    },
    [startTunnel, machine, transport, queryClient]
  );

  const handleSaveToken = useCallback(async () => {
    machine.setTokenError(null);
    try {
      await transport.updateConfig({ tunnel: { authtoken: machine.authToken } });
      machine.setAuthToken('');
      machine.setShowTokenInput(false);
      machine.setShowSetup(false);
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    } catch (err) {
      machine.setTokenError(describeTunnelWriteFailure(err, 'Could not save token. Try again.'));
    }
  }, [machine, queryClient, transport]);

  // A refused domain write is shown, not swallowed. The comment this replaces
  // said "domain will be re-synced from config", which was false comfort in the
  // case that matters: the field keeps whatever was typed until the next config
  // read, so a person who was refused saw their own value sitting there and had
  // every reason to believe it had been saved (DOR-1739).
  const handleSaveDomain = useCallback(async () => {
    // Nothing typed, nothing written. This fires on every blur of the domain
    // input, so an untouched field used to PATCH its own value straight back —
    // harmless only while that value was right. It was not: the config DTO
    // reported the LIVE tunnel domain, which is null whenever no tunnel is
    // running, so after a restart the input rendered empty over a domain that
    // was still saved, and one blur past it wrote `null` and wiped it. Comparing
    // against what was loaded means an untouched field cannot write at all,
    // whatever it happens to be showing.
    const saved = machine.tunnel?.domain ?? '';
    if (machine.domain.trim() === saved.trim()) return;

    machine.setDomainError(null);
    try {
      await transport.updateConfig({ tunnel: { domain: machine.domain.trim() || null } });
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    } catch (err) {
      machine.setDomainError(describeTunnelWriteFailure(err, 'Could not save domain. Try again.'));
    }
  }, [machine, queryClient, transport]);

  return {
    handleToggle,
    handleSaveToken,
    handleSaveDomain,
  };
}
