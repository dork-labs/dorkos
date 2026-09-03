/**
 * The two writes only the Remote Access dialog makes: the ngrok auth token and
 * the custom domain.
 *
 * Turning remote access on and off is NOT here. Three surfaces do that now, so
 * it lives once in `@/layers/entities/tunnel` and this hook forwards to it
 * (DOR-1743) — a second copy of the 409 handling and the exposure guard is how
 * two surfaces end up disagreeing about what a refusal meant.
 *
 * Every failure path says what actually went wrong: the server writes a
 * specific sentence for a refused or invalid write, and this is the layer that
 * decides what a person reads instead of it (`lib/tunnel-errors.ts`, DOR-1739).
 *
 * @module features/settings/model/use-tunnel-actions
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { useRemoteAccessActions } from '@/layers/entities/tunnel';
import { configKeys } from '@/layers/entities/config';
import { describeTunnelWriteFailure } from '../lib/tunnel-errors';
import type { TunnelMachine } from './use-tunnel-machine';

interface UseTunnelActionsArgs {
  machine: TunnelMachine;
}

/** Stable action handlers returned by {@link useTunnelActions}. */
export interface TunnelActions {
  handleToggle: (checked: boolean) => Promise<void>;
  handleSaveToken: () => Promise<void>;
  handleSaveDomain: () => Promise<void>;
}

/**
 * Action handlers for the Remote Access dialog.
 *
 * @param args - The dialog's machine, for the two fields these writes read.
 */
export function useTunnelActions({ machine }: UseTunnelActionsArgs): TunnelActions {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const remote = useRemoteAccessActions();

  const handleSaveToken = useCallback(async () => {
    machine.setTokenError(null);
    try {
      await transport.updateConfig({ tunnel: { authtoken: machine.authToken } });
      machine.setAuthToken('');
      machine.setShowTokenInput(false);
      machine.setShowSetup(false);
      // A saved token answers the most common reason a start failed, so the old
      // failure is no longer news — and nothing else would ever clear it, since
      // a failure now outlives the dialog it was raised in. Leaving it up would
      // drop the person back onto "Tunnel failed" the moment the setup view
      // stepped aside.
      remote.clearError();
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    } catch (err) {
      machine.setTokenError(describeTunnelWriteFailure(err, 'Could not save token. Try again.'));
    }
  }, [machine, queryClient, remote, transport]);

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
    handleToggle: remote.toggle,
    handleSaveToken,
    handleSaveDomain,
  };
}
