import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import type { ConnectorConnectPollResponse } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';
import { useConnectFlowStore, type ConnectFlowState } from './connect-flow-store';

/** How often a waiting flow polls the server, in milliseconds. */
const FLOW_POLL_INTERVAL_MS = 2_000;

export type { ConnectFlowStep, ConnectFlowState } from './connect-flow-store';

/** What {@link useConnectFlow} hands the UI. */
export interface ConnectFlow {
  /** The flow's observable state (app-wide — see {@link useConnectFlowStore}). */
  state: ConnectFlowState;
  /**
   * Begin a flow on one provider. Moves `idle → starting → disclosure`
   * (or `failed` when the server rejects the start). Replaces any previous
   * flow's tracking — one consent screen at a time.
   *
   * @param opts - The provider to connect through, the toolkit, and an
   *   optional multi-account label.
   */
  start: (opts: { provider: string; toolkit: string; label?: string }) => void;
  /**
   * Report that the person opened the sign-in page (clicked the link the UI
   * rendered under the disclosure). Moves `disclosure → waiting` and begins
   * polling. A no-op in any other step.
   */
  authOpened: () => void;
  /** Abandon tracking and return to `idle`. */
  reset: () => void;
}

/**
 * The connect-flow state machine: start → disclosure-before-URL → poll to a
 * terminal state. On `connected` the account aggregates are invalidated so the
 * new account appears without a reload.
 *
 * The state lives in {@link useConnectFlowStore}, not in the caller — a flow
 * in `waiting` keeps polling as long as ANY mounted surface uses this hook
 * (the connect dialog stays mounted, open or closed, for the life of the
 * /connections page), so a person who closes the dialog and then finishes
 * signing in at the vendor still gets the account recorded rather than an
 * orphaned grant. Leaving the page pauses polling; returning resumes it.
 */
export function useConnectFlow(): ConnectFlow {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const state = useConnectFlowStore(
    useShallow((s): ConnectFlowState => ({
      step: s.step,
      toolkit: s.toolkit,
      disclosure: s.disclosure,
      authorizeUrl: s.authorizeUrl,
      account: s.account,
      error: s.error,
    }))
  );
  const flowId = useConnectFlowStore((s) => s.flowId);

  const startMutation = useMutation({
    mutationFn: (opts: { provider: string; toolkit: string; label?: string }) =>
      transport.startConnectorFlow(opts.provider, {
        toolkit: opts.toolkit,
        ...(opts.label !== undefined && { label: opts.label }),
      }),
    // The dialog's failed step is this mutation's surface — no global toast.
    meta: { suppressErrorToast: true },
  });

  const start = useCallback(
    (opts: { provider: string; toolkit: string; label?: string }) => {
      useConnectFlowStore.getState().begin(opts.toolkit);
      startMutation.mutate(opts, {
        onSuccess: (result) => useConnectFlowStore.getState().startResolved(result),
        onError: (err) => useConnectFlowStore.getState().startFailed(err.message),
      });
    },
    [startMutation]
  );

  const authOpened = useCallback(() => useConnectFlowStore.getState().authOpened(), []);
  const reset = useCallback(() => useConnectFlowStore.getState().reset(), []);

  // Poll only while waiting; the terminal transition below flips `enabled` off.
  const poll = useQuery<ConnectorConnectPollResponse>({
    queryKey: connectorKeys.flow(flowId ?? ''),
    queryFn: () => transport.pollConnectorFlow(flowId ?? ''),
    enabled: state.step === 'waiting' && flowId !== null,
    refetchInterval: FLOW_POLL_INTERVAL_MS,
    // Poll results are moments, not cache-worthy data.
    gcTime: 0,
    staleTime: 0,
    // The failed step renders a dead poll inline — no global toast.
    meta: { suppressErrorToast: true },
  });

  const pollData = poll.data;
  const pollError = poll.error;
  useEffect(() => {
    if (state.step !== 'waiting') return;
    if (pollData?.status === 'connected') {
      useConnectFlowStore.getState().settleConnected(pollData.account ?? null);
      void queryClient.invalidateQueries({ queryKey: connectorKeys.accounts() });
      return;
    }
    if (pollData?.status === 'failed') {
      useConnectFlowStore
        .getState()
        .settleFailed(pollData.error ?? 'The connection did not complete.');
      return;
    }
    // A poll request that itself errored (network, unknown flow) is terminal —
    // spinning forever on a dead flow would be the dishonest option.
    if (pollError) {
      useConnectFlowStore.getState().settleFailed(pollError.message);
    }
  }, [state.step, pollData, pollError, queryClient]);

  return { state, start, authOpened, reset };
}
