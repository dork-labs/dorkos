import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type { McpSigninPollResult, StartMcpSigninResult } from '@dorkos/shared/transport';
import { useTransport } from '@/layers/shared/model';
import { agentKeys } from '../api/queries';

/** How often a waiting flow polls the server, in milliseconds. */
const FLOW_POLL_INTERVAL_MS = 2_000;

/**
 * The sign-in flow's steps, in order. The one invariant is consent ordering: the
 * `authorizeUrl` exists only from `disclosure` on, and nothing in the flow ever
 * opens it — the UI renders it as a link the person clicks AFTER reading the
 * custody disclosure, then reports the click via {@link McpSigninFlow.authOpened}
 * to begin polling.
 *
 * - `idle` — nothing in flight.
 * - `starting` — the sign-in start request is on the wire.
 * - `disclosure` — the server answered with the sign-in link and the custody
 *   sentence; the UI shows the sentence and the link.
 * - `waiting` — the person opened the sign-in page; the flow is being polled.
 * - `connected` — terminal; the token is stored and injects on the next turn.
 * - `failed` — terminal; `error` says why.
 */
export type McpSigninStep = 'idle' | 'starting' | 'disclosure' | 'waiting' | 'connected' | 'failed';

/** The sign-in flow's observable state. */
export interface McpSigninFlowState {
  /** Where the flow is; see {@link McpSigninStep}. */
  step: McpSigninStep;
  /** The server-composed custody sentence, from `disclosure` on. */
  disclosure: string | null;
  /** The sign-in URL, from `disclosure` on. Never opened by the flow itself. */
  authorizeUrl: string | null;
  /** Why the flow failed, once `failed`. */
  error: string | null;
}

/** What {@link useMcpSigninFlow} hands the UI. */
export interface McpSigninFlow {
  /** The flow's observable state. */
  state: McpSigninFlowState;
  /**
   * Begin signing in to this server. Moves `idle → starting → disclosure` (or
   * straight to `connected` when a live token already existed, or `failed` when
   * the server rejects the start).
   */
  start: () => void;
  /**
   * Report that the person opened the sign-in page (clicked the link the UI
   * rendered under the disclosure). Moves `disclosure → waiting` and begins
   * polling. A no-op in any other step.
   */
  authOpened: () => void;
  /** Abandon this flow and return to `idle`. */
  reset: () => void;
}

/**
 * The local phase this hook owns directly. The two terminal outcomes of a
 * `waiting` poll (`connected` / `failed`) are NOT stored here — they are derived
 * from the poll query at render time, so no effect mirrors async results into
 * React state. `connected` / `failed` appear here only for the non-polling
 * paths: an already-connected server, or a rejected start.
 */
type SigninPhase = McpSigninStep;

/** The hook's owned state: the phase plus the disclosure material a start resolves. */
interface SigninLocalState {
  phase: SigninPhase;
  disclosure: string | null;
  authorizeUrl: string | null;
  /** The start-path error (a rejected `mcp.signin`); poll-path errors are derived. */
  startError: string | null;
  flowId: string | null;
}

const IDLE_STATE: SigninLocalState = {
  phase: 'idle',
  disclosure: null,
  authorizeUrl: null,
  startError: null,
  flowId: null,
};

/** The terminal error a waiting poll surfaced, or null while it is pending/healthy. */
function pollErrorMessage(
  data: McpSigninPollResult | undefined,
  error: Error | null
): string | null {
  if (data?.status === 'failed') return data.error ?? 'The sign-in did not complete.';
  if (error) return error.message;
  return null;
}

/** The effective step: the owned phase, except while `waiting` it reflects the poll. */
function deriveStep(
  phase: SigninPhase,
  data: McpSigninPollResult | undefined,
  hasError: boolean
): McpSigninStep {
  if (phase !== 'waiting') return phase;
  if (data?.status === 'connected') return 'connected';
  if (data?.status === 'failed' || hasError) return 'failed';
  return 'waiting';
}

/**
 * The managed-MCP OAuth sign-in state machine for one `(agent, server)`: start →
 * disclosure-before-URL → poll to a terminal state. On `connected` the managed
 * roster and live MCP status are invalidated so the row flips from `needs-auth`
 * to `connected` without a reload.
 *
 * State is held per hook instance (one row owns one flow), not in an app-wide
 * store: an operator signs one server in at a time, and — unlike the connector
 * dialog that can be dismissed mid-grant — this surface is inline in the row.
 * If the person navigates away while `waiting`, the browser callback still
 * stores the token server-side (DorkOS owns the exchange), so the next status
 * refresh shows `connected` regardless; the poll is only how the open row learns
 * of it sooner.
 *
 * @param agentId - ULID of the agent that owns the server.
 * @param serverName - The managed server's name (unique within the agent).
 */
export function useMcpSigninFlow(agentId: string, serverName: string): McpSigninFlow {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<SigninLocalState>(IDLE_STATE);

  // Refresh the managed roster and every `mcp-config` query (keyed by project
  // path + runtime, which this hook does not know) so the live status re-reads.
  const invalidateStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: agentKeys.mcpServers(agentId) });
    void queryClient.invalidateQueries({ queryKey: ['mcp-config'] });
  }, [queryClient, agentId]);

  const startMutation = useMutation({
    mutationFn: () => transport.startMcpSignin(agentId, serverName),
    // The row's failed step is this mutation's surface — no global toast.
    meta: { suppressErrorToast: true },
  });

  const start = useCallback(() => {
    setLocal({ ...IDLE_STATE, phase: 'starting' });
    startMutation.mutate(undefined, {
      onSuccess: (result: StartMcpSigninResult) => {
        setLocal({
          phase: result.alreadyConnected ? 'connected' : 'disclosure',
          disclosure: result.disclosure,
          authorizeUrl: result.authorizeUrl ?? null,
          startError: null,
          flowId: result.flowId,
        });
      },
      onError: (err) => setLocal({ ...IDLE_STATE, phase: 'failed', startError: err.message }),
    });
  }, [startMutation]);

  const authOpened = useCallback(() => {
    setLocal((prev) => (prev.phase === 'disclosure' ? { ...prev, phase: 'waiting' } : prev));
  }, []);

  const reset = useCallback(() => setLocal(IDLE_STATE), []);

  // Poll only while waiting; `refetchInterval` stops itself once the poll lands a
  // terminal status (or errors), so a connected/dead flow is never re-polled.
  const poll = useQuery<McpSigninPollResult>({
    queryKey: ['mcp-signin', agentId, serverName, local.flowId ?? ''],
    queryFn: () => transport.pollMcpSignin(local.flowId ?? ''),
    enabled: local.phase === 'waiting' && local.flowId !== null,
    refetchInterval: (query: Query<McpSigninPollResult>) => {
      const status = query.state.data?.status;
      if (status === 'connected' || status === 'failed') return false;
      if (query.state.status === 'error') return false;
      return FLOW_POLL_INTERVAL_MS;
    },
    retry: false,
    // Poll results are moments, not cache-worthy data.
    gcTime: 0,
    staleTime: 0,
    meta: { suppressErrorToast: true },
  });

  const step = deriveStep(local.phase, poll.data, poll.error !== null);

  // The one side effect: when the flow reaches `connected`, re-read live status
  // so the row flips. This invalidates queries (a side effect) — it does not
  // mirror async results into React state, so the machine has no effect-driven
  // setState. Fires once per terminal transition (deps hold `step` steady after).
  useEffect(() => {
    if (step === 'connected') invalidateStatus();
  }, [step, invalidateStatus]);

  const error =
    local.phase === 'waiting' ? pollErrorMessage(poll.data, poll.error) : local.startError;

  return {
    state: { step, disclosure: local.disclosure, authorizeUrl: local.authorizeUrl, error },
    start,
    authOpened,
    reset,
  };
}
