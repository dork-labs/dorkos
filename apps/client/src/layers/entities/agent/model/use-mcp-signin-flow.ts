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

/**
 * Sign-in flows THIS PAGE sent the person to the provider for.
 *
 * Module-level, and that is the whole point (DOR-1004). "Did the person click
 * the link here?" is a fact about this browser tab, not about a React component
 * — and the component does not survive everything a person does. Switching
 * sessions and coming back re-mounts the transcript mid-sign-in, and ownership
 * held on the instance would die with it: the tab that sent the person to the
 * provider would come back, watch the sign-in land, and never bring the agent
 * back, which is the one thing this feature exists to do.
 *
 * Other tabs are still not owners — they never clicked anything — so the set
 * keeps exactly the guarantee it is there for while surviving a re-mount.
 */
const flowsOpenedHere = new Set<string>();

/** @internal Exported for testing only — flow ids repeat across test cases. */
export function resetMcpSigninOwnership(): void {
  flowsOpenedHere.clear();
}

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
  /**
   * How many tools the signed-in server exposes, when the server said so.
   *
   * Read DEFENSIVELY from the poll body rather than taken from its type: the
   * field is being added on the server side separately, so this hook is written
   * to be correct whether the running server sends it or not. Absent means "we
   * don't know", never "zero" — the UI drops the count rather than claiming one.
   */
  toolCount: number | null;
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
  /**
   * Adopt a flow SOMEBODY ELSE started — the server pushed its link and
   * disclosure into the conversation (DOR-1004) — and render it from
   * `disclosure` on, with no start request of its own.
   *
   * Adopting deliberately does NOT confer {@link isOwner}: every tab watching
   * the session renders the same pushed card, and only the tab the person
   * actually clicked through may act on the result.
   *
   * @param flow - The pushed flow's id, sign-in link, and custody disclosure.
   */
  adopt: (flow: { flowId: string; authorizeUrl: string; disclosure: string }) => void;
  /** Abandon this flow and return to `idle`. */
  reset: () => void;
  /**
   * Whether THIS PAGE drove the flow — it started the sign-in, or it is where the
   * person clicked the link.
   *
   * The one thing that may key an action on a sign-in finishing (DOR-1004's
   * auto-resume). A card hydrated in a second tab renders every state this one
   * does and must never fire, or one sign-in would resume the agent once per open
   * tab. Per PAGE rather than per component, so re-mounting the transcript
   * mid-sign-in does not silently forfeit the resume — see {@link flowsOpenedHere}.
   */
  isOwner: boolean;
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
  /**
   * Watch a flow this instance did not start, from `disclosure` on (DOR-1004).
   *
   * An ADOPTED flow — the card the server pushed into a conversation — is polled
   * without waiting for a click, because the click may happen in another tab
   * entirely. Without it, every tab but one would sit on a `disclosure` card
   * whose link went dead the moment the sign-in landed somewhere else.
   *
   * A flow this instance STARTED is never watched: nobody else can be signing it
   * in, so polling before the person has opened the link would only ask a
   * question whose answer cannot have changed.
   */
  watching: boolean;
}

const IDLE_STATE: SigninLocalState = {
  phase: 'idle',
  disclosure: null,
  authorizeUrl: null,
  startError: null,
  flowId: null,
  watching: false,
};

/**
 * How many tools the poll body reported, or `null` when it reported none.
 *
 * Written against the WIRE, not the type: `toolCount` is optional and may be
 * absent entirely depending on the server this client is talking to, so the read
 * narrows an unknown rather than trusting a declaration. A negative or
 * non-finite number is treated as absent — "we don't know" is honest, and
 * "-1 tools" is not.
 */
function readToolCount(data: McpSigninPollResult | undefined): number | null {
  const value = (data as { toolCount?: unknown } | undefined)?.toolCount;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

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
 * Whether the flow is being polled: the person has opened the link here, or this
 * instance is watching a flow somebody else may be completing.
 */
function isPolling(local: SigninLocalState): boolean {
  if (local.flowId === null) return false;
  return local.phase === 'waiting' || (local.phase === 'disclosure' && local.watching);
}

/**
 * The effective step: the owned phase, except while polling it reflects the poll.
 *
 * A WATCHING instance keeps showing its `disclosure` — the link is still the
 * right thing on screen for someone who has not opened it — right up until the
 * poll says the sign-in is done. Exhausted retries only kill a flow this
 * instance is actually waiting on; a background watcher that cannot reach the
 * server keeps showing the link rather than declaring somebody else's sign-in
 * failed.
 *
 * @param local - The hook's owned state.
 * @param data - The latest poll body, if one has landed.
 * @param requestFailures - How many poll REQUESTS have failed in a row.
 */
function deriveStep(
  local: SigninLocalState,
  data: McpSigninPollResult | undefined,
  requestFailures: number
): McpSigninStep {
  if (!isPolling(local)) return local.phase;
  if (data?.status === 'connected') return 'connected';
  if (data?.status === 'failed') return 'failed';
  if (local.phase !== 'waiting') return local.phase;
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
  // Which flow the counter above belongs to, mirrored synchronously so a settle
  // can be matched against it before React re-renders. A poll request outlives
  // the flow that issued it: press Sign in, abandon it, start again, and the
  // first flow's in-flight request settles into the second flow's counter —
  // showing "couldn't check the sign-in" on a sign-in that has not been checked
  // once. The id, not a generation number, because the query is keyed by it too.
  const flowIdRef = useRef<string | null>(null);
  /** Zero the run counter — a fresh flow starts with a clean slate. */
  const resetPollCounter = useCallback((flowId: string | null) => {
    flowIdRef.current = flowId;
    failuresRef.current = 0;
    setConsecutiveFailures(0);
  }, []);

  /**
   * Record how a poll settled, updating both copies of the run counter — but
   * only when the settle belongs to the flow the counter is for.
   */
  const recordPollSettle = useCallback((outcome: 'ok' | 'failed', forFlowId: string) => {
    if (forFlowId !== flowIdRef.current) return;
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
    resetPollCounter(null);
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
        resetPollCounter(result.flowId);
        // Starting a sign-in here is as much an act of ownership as clicking the
        // link would be — nobody else can be completing a flow this page minted.
        flowsOpenedHere.add(result.flowId);
        setLocal({
          phase: result.alreadyConnected ? 'connected' : 'disclosure',
          disclosure: result.disclosure,
          authorizeUrl: result.authorizeUrl ?? null,
          startError: null,
          flowId: result.flowId,
          watching: false,
        });
      },
      onError: (err) => setLocal({ ...IDLE_STATE, phase: 'failed', startError: err.message }),
    });
  }, [startMutation, resetPollCounter]);

  const adopt = useCallback(
    (flow: { flowId: string; authorizeUrl: string; disclosure: string }) => {
      // Adopting the flow already on screen is a no-op, so a re-render (or a
      // re-pushed card) cannot knock a `waiting` flow back to `disclosure` and
      // strand the person mid-sign-in. Guarded on the ref, which mirrors the
      // state synchronously — the card adopts from an effect, and two of those
      // can run before React re-renders.
      if (flowIdRef.current === flow.flowId) return;
      resetPollCounter(flow.flowId);
      setLocal({
        phase: 'disclosure',
        disclosure: flow.disclosure,
        authorizeUrl: flow.authorizeUrl,
        startError: null,
        flowId: flow.flowId,
        watching: true,
      });
    },
    [resetPollCounter]
  );

  const authOpened = useCallback(() => {
    if (local.phase !== 'disclosure') return;
    // Clicking the link is what makes this page the flow's owner: whichever tab
    // sent the person to the provider is the one that may act on the result.
    if (local.flowId !== null) flowsOpenedHere.add(local.flowId);
    setLocal((prev) => (prev.phase === 'disclosure' ? { ...prev, phase: 'waiting' } : prev));
  }, [local.phase, local.flowId]);

  const reset = useCallback(() => {
    if (local.flowId !== null) flowsOpenedHere.delete(local.flowId);
    resetPollCounter(null);
    setLocal(IDLE_STATE);
  }, [resetPollCounter, local.flowId]);

  // Poll only while waiting. `refetchInterval` is the whole stop condition: an
  // in-band terminal status ends it outright, and a failing REQUEST only backs
  // off — a dropped poll is a network hiccup, not a failed sign-in, so giving up
  // on the first one would report failure for a sign-in that actually worked.
  const poll = useQuery<McpSigninPollResult>({
    queryKey: ['mcp-signin', agentId, serverName, local.flowId ?? ''],
    // The run counter is kept here, at the settle: incremented when a request
    // fails, zeroed the moment one succeeds.
    queryFn: async () => {
      const forFlowId = local.flowId ?? '';
      try {
        const result = await transport.pollMcpSignin(forFlowId);
        recordPollSettle('ok', forFlowId);
        return result;
      } catch (err) {
        recordPollSettle('failed', forFlowId);
        throw err;
      }
    },
    enabled: isPolling(local),
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
  const step = deriveStep(local, poll.data, requestFailures);

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
      toolCount: step === 'connected' ? readToolCount(poll.data) : null,
    },
    start,
    adopt,
    authOpened,
    reset,
    isOwner: local.flowId !== null && flowsOpenedHere.has(local.flowId),
  };
}
