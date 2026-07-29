import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorConnectPollResponse,
  PublicConnectedAccount,
} from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** How often a waiting flow polls the server, in milliseconds. */
const FLOW_POLL_INTERVAL_MS = 2_000;

/**
 * The connect flow's steps, in order. The machine's one invariant is consent
 * ordering: the auth URL exists only from `disclosure` on, and nothing in this
 * hook ever opens it — the UI renders it as a link the person clicks AFTER
 * reading the custody disclosure, then reports the click via
 * {@link ConnectFlow.authOpened} to begin polling.
 *
 * - `idle` — nothing in flight.
 * - `starting` — the start request is on the wire.
 * - `disclosure` — the server answered with the auth URL and the custody
 *   sentence; the UI shows the sentence and the sign-in link.
 * - `waiting` — the person opened the sign-in page; the flow is being polled.
 * - `connected` — terminal; `account` holds the new account.
 * - `failed` — terminal; `error` says why.
 */
export type ConnectFlowStep =
  | 'idle'
  | 'starting'
  | 'disclosure'
  | 'waiting'
  | 'connected'
  | 'failed';

/** The connect flow's observable state. */
export interface ConnectFlowState {
  /** Where the flow is; see {@link ConnectFlowStep}. */
  step: ConnectFlowStep;
  /** The service slug being connected, from `disclosure` on. */
  toolkit: string | null;
  /** The server-composed custody sentence, from `disclosure` on. */
  disclosure: string | null;
  /** The vendor sign-in URL, from `disclosure` on. Never opened by this hook. */
  authorizeUrl: string | null;
  /** The new account, once `connected`. */
  account: PublicConnectedAccount | null;
  /** Why the flow failed, once `failed`. */
  error: string | null;
}

/** What {@link useConnectFlow} hands the UI. */
export interface ConnectFlow {
  /** The flow's observable state. */
  state: ConnectFlowState;
  /**
   * Begin a flow on one provider. Moves `idle → starting → disclosure`
   * (or `failed` when the server rejects the start).
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
  /** Abandon the flow and return to `idle`. */
  reset: () => void;
}

const IDLE_STATE: ConnectFlowState = {
  step: 'idle',
  toolkit: null,
  disclosure: null,
  authorizeUrl: null,
  account: null,
  error: null,
};

/**
 * The connect-flow state machine: start → disclosure-before-URL → poll to a
 * terminal state. On `connected` the account aggregates are invalidated so the
 * new account appears without a reload.
 */
export function useConnectFlow(): ConnectFlow {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectFlowState>(IDLE_STATE);
  const flowIdRef = useRef<string | null>(null);

  const startMutation = useMutation({
    mutationFn: (opts: { provider: string; toolkit: string; label?: string }) =>
      transport.startConnectorFlow(opts.provider, {
        toolkit: opts.toolkit,
        ...(opts.label !== undefined && { label: opts.label }),
      }),
  });

  const start = useCallback(
    (opts: { provider: string; toolkit: string; label?: string }) => {
      flowIdRef.current = null;
      setState({ ...IDLE_STATE, step: 'starting', toolkit: opts.toolkit });
      startMutation.mutate(opts, {
        onSuccess: (result) => {
          flowIdRef.current = result.flowId;
          setState({
            step: 'disclosure',
            toolkit: opts.toolkit,
            disclosure: result.disclosure,
            authorizeUrl: result.authorizeUrl,
            account: null,
            error: null,
          });
        },
        onError: (err) => {
          setState({ ...IDLE_STATE, step: 'failed', toolkit: opts.toolkit, error: err.message });
        },
      });
    },
    [startMutation]
  );

  const authOpened = useCallback(() => {
    setState((prev) => (prev.step === 'disclosure' ? { ...prev, step: 'waiting' } : prev));
  }, []);

  const reset = useCallback(() => {
    flowIdRef.current = null;
    setState(IDLE_STATE);
  }, []);

  // Poll only while waiting; the terminal transition below flips `enabled` off.
  const flowId = flowIdRef.current;
  const poll = useQuery<ConnectorConnectPollResponse>({
    queryKey: connectorKeys.flow(flowId ?? ''),
    queryFn: () => transport.pollConnectorFlow(flowId ?? ''),
    enabled: state.step === 'waiting' && flowId !== null,
    refetchInterval: FLOW_POLL_INTERVAL_MS,
    // Poll results are moments, not cache-worthy data.
    gcTime: 0,
    staleTime: 0,
  });

  const pollData = poll.data;
  const pollError = poll.error;
  useEffect(() => {
    if (state.step !== 'waiting') return;
    if (pollData?.status === 'connected') {
      setState((prev) => ({ ...prev, step: 'connected', account: pollData.account ?? null }));
      void queryClient.invalidateQueries({ queryKey: connectorKeys.accounts() });
      return;
    }
    if (pollData?.status === 'failed') {
      setState((prev) => ({
        ...prev,
        step: 'failed',
        error: pollData.error ?? 'The connection did not complete.',
      }));
      return;
    }
    // A poll request that itself errored (network, unknown flow) is terminal —
    // spinning forever on a dead flow would be the dishonest option.
    if (pollError) {
      setState((prev) => ({ ...prev, step: 'failed', error: pollError.message }));
    }
  }, [state.step, pollData, pollError, queryClient]);

  return { state, start, authOpened, reset };
}
