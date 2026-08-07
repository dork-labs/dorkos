import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type { McpSigninPollResult, StartMcpSigninResult } from '@dorkos/shared/transport';
import { useTransport } from '@/layers/shared/model';
import { agentKeys } from '../api/queries';

/** How often a waiting flow polls the server, in milliseconds. */
const FLOW_POLL_INTERVAL_MS = 2_000;

/**
 * How many times **in a row** the poll REQUEST may fail before the flow gives up.
 *
 * A dropped request is not a failed sign-in: the person may be mid-redirect on a
 * flaky network while DorkOS has already stored the token. So transport errors
 * are retried (with a widening gap) and only exhaustion is terminal.
 *
 * Consecutive, not cumulative: any successful check zeroes the count. A lifetime
 * total would kill a perfectly healthy sign-in that happened to hiccup this many
 * times across its life — alternating failure and success would end it — and
 * would leave the retry notice on screen forever after one recovered blip.
 */
const MAX_POLL_REQUEST_FAILURES = 5;

/** What a person reads while poll requests are failing but the flow is still alive. */
const POLL_RETRY_NOTICE = 'Couldn’t check the sign-in — retrying.';

/** What a person reads once the poll requests have failed too many times running. */
const POLL_UNREACHABLE_MESSAGE =
  'We couldn’t check whether the sign-in finished. Try again in a moment.';

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
type McpSigninStep = 'idle' | 'starting' | 'disclosure' | 'waiting' | 'connected' | 'failed';

/** The sign-in flow's observable state. */
interface McpSigninFlowState {
  /** Where the flow is; see {@link McpSigninStep}. */
  step: McpSigninStep;
  /** The server-composed custody sentence, from `disclosure` on. */
  disclosure: string | null;
  /** The sign-in URL, from `disclosure` on. Never opened by the flow itself. */
  authorizeUrl: string | null;
  /** Why the flow failed, once `failed`. */
  error: string | null;
  /**
   * Set while the flow is still `waiting` but its status checks are failing —
   * the UI says so plainly instead of showing nothing (or a raw network error).
   */
  retryNotice: string | null;
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

/**
 * The terminal error a waiting poll surfaced, or null while it is pending/healthy.
 *
 * A transport error never contributes its own message: `Failed to fetch` is not
 * something a person can act on, and it is not even a failed sign-in. Only the
 * server's own `failed` verdict, or exhausted retries, produce copy here.
 */
function pollErrorMessage(
  data: McpSigninPollResult | undefined,
  requestFailures: number
): string | null {
  if (data?.status === 'failed') return data.error ?? 'The sign-in did not complete.';
  if (requestFailures >= MAX_POLL_REQUEST_FAILURES) return POLL_UNREACHABLE_MESSAGE;
  return null;
}

/**
 * The effective step: the owned phase, except while `waiting` it reflects the poll.
 *
 * @param phase - The hook's owned phase.
 * @param data - The latest poll body, if one has landed.
 * @param requestFailures - How many poll REQUESTS have failed in a row.
 */
function deriveStep(
  phase: SigninPhase,
  data: McpSigninPollResult | undefined,
  requestFailures: number
): McpSigninStep {
  if (phase !== 'waiting') return phase;
  if (data?.status === 'connected') return 'connected';
  if (data?.status === 'failed') return 'failed';
  return requestFailures >= MAX_POLL_REQUEST_FAILURES ? 'failed' : 'waiting';
}

/**
 * The managed-MCP OAuth sign-in state machine for one `(agent, server)`: start →
 * disclosure-before-URL → poll to a terminal state. On `connected` the managed
 * roster and live MCP status are invalidated so the row stops saying
 * `needs-auth` without a reload.
 *
 * State is held per hook instance (one row owns one flow), not in an app-wide
 * store: an operator signs one server in at a time, and — unlike the connector
 * dialog that can be dismissed mid-grant — this surface is inline in the row.
 * If the person navigates away while `waiting`, the browser callback still
 * stores the token server-side (DorkOS owns the exchange), so nothing is lost;
 * the row picks the result up on its next read of the managed list, whose
 * `authStatus` reports the stored token. The poll is only how an open row learns
 * of it sooner.
 *
 * @param agentId - ULID of the agent that owns the server.
 * @param serverName - The managed server's name (unique within the agent).
 */
export function useMcpSigninFlow(agentId: string, serverName: string): McpSigninFlow {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<SigninLocalState>(IDLE_STATE);
  // Poll requests that failed IN A ROW. Counted here rather than read off the
  // query because TanStack has no such number: `fetchFailureCount` is per-fetch
  // (zeroed when each new fetch starts, so with `retry: false` it never exceeds
  // one) and `errorUpdateCount` is a lifetime total (which would kill a healthy
  // flow that hiccupped a few times over its life). Both were tried.
  //
  // Held twice, deliberately, and only ever written through {@link recordPollSettle}
  // so the two cannot diverge: `refetchInterval` runs the instant a poll settles
  // — before React has re-rendered — so it needs the ref, and reading a ref does
  // not re-render, so the copy the UI reads has to be state.
  const failuresRef = useRef(0);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  /** Record how a poll settled, updating both copies of the run counter. */
  const recordPollSettle = useCallback((outcome: 'ok' | 'failed') => {
    failuresRef.current = outcome === 'ok' ? 0 : failuresRef.current + 1;
    setConsecutiveFailures(failuresRef.current);
  }, []);

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
    recordPollSettle('ok');
    setLocal({ ...IDLE_STATE, phase: 'starting' });
    startMutation.mutate(undefined, {
      onSuccess: (result: StartMcpSigninResult) => {
        // A start that is neither already-connected nor carrying a link has
        // nothing for the person to do; fail it here rather than rendering a
        // dead link.
        if (!result.alreadyConnected && !result.authorizeUrl) {
          setLocal({
            ...IDLE_STATE,
            phase: 'failed',
            startError: 'DorkOS could not build a sign-in link for this server.',
          });
          return;
        }
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
  }, [startMutation, recordPollSettle]);

  const authOpened = useCallback(() => {
    setLocal((prev) => (prev.phase === 'disclosure' ? { ...prev, phase: 'waiting' } : prev));
  }, []);

  const reset = useCallback(() => {
    recordPollSettle('ok');
    setLocal(IDLE_STATE);
  }, [recordPollSettle]);

  // Poll only while waiting. `refetchInterval` is the whole stop condition: an
  // in-band terminal status ends it outright, and a failing REQUEST only backs
  // off — a dropped poll is a network hiccup, not a failed sign-in, so giving up
  // on the first one would report failure for a sign-in that actually worked.
  const poll = useQuery<McpSigninPollResult>({
    queryKey: ['mcp-signin', agentId, serverName, local.flowId ?? ''],
    // The run counter is kept here, at the settle: incremented when a request
    // fails, zeroed the moment one succeeds.
    queryFn: async () => {
      try {
        const result = await transport.pollMcpSignin(local.flowId ?? '');
        recordPollSettle('ok');
        return result;
      } catch (err) {
        recordPollSettle('failed');
        throw err;
      }
    },
    enabled: local.phase === 'waiting' && local.flowId !== null,
    refetchInterval: (query: Query<McpSigninPollResult>) => {
      const status = query.state.data?.status;
      if (status === 'connected' || status === 'failed') return false;
      const failures = failuresRef.current;
      if (failures === 0) return FLOW_POLL_INTERVAL_MS;
      if (failures >= MAX_POLL_REQUEST_FAILURES) return false;
      // Widening gap, so a server that is down for a few seconds is not hammered.
      return FLOW_POLL_INTERVAL_MS * (failures + 1);
    },
    // Retries are counted and paced by `refetchInterval` above, not by the
    // per-fetch retry loop — one place decides how long the flow keeps trying.
    retry: false,
    // The observer stays enabled once the flow reaches a derived terminal step, so
    // suppress the refetch triggers that would fire one more poll after
    // connected/failed: a window refocus, and a network reconnect that would
    // otherwise resurrect a settled flow. Both idempotent, both needless.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Poll results are moments, not cache-worthy data.
    gcTime: 0,
    staleTime: 0,
    meta: { suppressErrorToast: true },
  });

  const requestFailures = consecutiveFailures;
  const step = deriveStep(local.phase, poll.data, requestFailures);

  // The one side effect: when the flow reaches `connected`, re-read live status
  // so the row flips. This invalidates queries (a side effect) — it does not
  // mirror async results into React state, so the machine has no effect-driven
  // setState. Fires once per terminal transition (deps hold `step` steady after).
  useEffect(() => {
    if (step === 'connected') invalidateStatus();
  }, [step, invalidateStatus]);

  const error =
    local.phase === 'waiting' ? pollErrorMessage(poll.data, requestFailures) : local.startError;
  const retryNotice = step === 'waiting' && requestFailures > 0 ? POLL_RETRY_NOTICE : null;

  return {
    state: {
      step,
      disclosure: local.disclosure,
      authorizeUrl: local.authorizeUrl,
      error,
      retryNotice,
    },
    start,
    authOpened,
    reset,
  };
}
