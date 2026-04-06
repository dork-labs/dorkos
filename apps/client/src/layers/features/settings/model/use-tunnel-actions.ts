/**
 * Action handlers for the Remote Access tunnel dialog.
 *
 * Wraps each handler in a stable `useCallback`. Pure functions over the
 * machine state — no local state of its own.
 *
 * Pure refactor of the action callbacks previously inlined in `TunnelDialog`.
 * Behavior is byte-identical to the source — same try/catch boundaries,
 * same error messages, same `broadcastTunnelChange()` and
 * `queryClient.invalidateQueries({ queryKey: ['config'] })` calls.
 *
 * @module features/settings/model/use-tunnel-actions
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { broadcastTunnelChange } from '@/layers/entities/tunnel';
import { START_TIMEOUT_MS } from './tunnel-view-state';
import type { TunnelMachine } from './use-tunnel-machine';

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
  handlePasscodeToggle: (checked: boolean) => Promise<void>;
  handleSavePasscode: () => Promise<void>;
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
  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (checked) {
        machine.setState('starting');
        machine.setError(null);
        const timeout = setTimeout(() => {
          machine.setState('error');
          machine.setError('Connection timed out after 15 seconds');
        }, START_TIMEOUT_MS);
        try {
          const result = await transport.startTunnel();
          clearTimeout(timeout);
          machine.setState('connected');
          machine.setUrl(result.url);
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch (err) {
          clearTimeout(timeout);
          machine.setState('error');
          machine.setError(err instanceof Error ? err.message : 'Failed to start tunnel');
        }
      } else {
        machine.setState('stopping');
        machine.setError(null);
        try {
          await transport.stopTunnel();
          machine.setState('off');
          machine.setUrl(null);
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch (err) {
          machine.setState('connected');
          machine.setError(err instanceof Error ? err.message : 'Failed to stop tunnel');
        }
      }
    },
    [machine, transport, queryClient]
  );

  const handleSaveToken = useCallback(async () => {
    machine.setTokenError(null);
    try {
      await transport.updateConfig({ tunnel: { authtoken: machine.authToken } });
      machine.setAuthToken('');
      machine.setShowTokenInput(false);
      machine.setShowSetup(false);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
      machine.setTokenError('Could not save token. Try again.');
    }
  }, [machine, queryClient, transport]);

  const handleSaveDomain = useCallback(async () => {
    try {
      await transport.updateConfig({ tunnel: { domain: machine.domain.trim() || null } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
      // Silently fail — domain will be re-synced from config
    }
  }, [machine, queryClient, transport]);

  const handlePasscodeToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        try {
          await transport.setTunnelPasscode({ enabled: false });
          machine.setPasscodeEnabled(false);
          machine.setPasscodeInput('');
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch {
          toast.error('Failed to disable passcode');
        }
      } else {
        machine.setPasscodeEnabled(true);
      }
    },
    [machine, transport, queryClient]
  );

  const handleSavePasscode = useCallback(async () => {
    try {
      await transport.setTunnelPasscode({ passcode: machine.passcodeInput, enabled: true });
      machine.setPasscodeInput('');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      broadcastTunnelChange();
    } catch {
      toast.error('Failed to save passcode');
    }
  }, [machine, queryClient, transport]);

  return {
    handleToggle,
    handleSaveToken,
    handleSaveDomain,
    handlePasscodeToggle,
    handleSavePasscode,
  };
}
