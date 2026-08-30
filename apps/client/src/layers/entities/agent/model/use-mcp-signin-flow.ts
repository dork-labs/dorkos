import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type {
  McpClientCredentials,
  McpSigninPollResult,
  StartMcpSigninResult,
} from '@dorkos/shared/transport';
import { useTransport } from '@/layers/shared/model';
import { agentKeys } from '../api/queries';
import {
  describeSigninError,
  readSigninFailurePayload,
  type McpSigninErrorView,
} from '../lib/mcp-signin-errors';

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
  /** Why the flow failed, once `failed` — the plain sentence, never the raw error. */
  error: string | null;
  /**
   * The raw error behind {@link error}, for a Details disclosure. Null when the
   * plain sentence IS everything that is known.
   */
  errorDetail: string | null;
  /**
   * Whether this failure is one the person can fix by supplying app credentials
   * from the provider (DOR-982) — true only when the provider refused to let
   * DorkOS register itself.
   */
  canUseOwnCredentials: boolean;
  /** True while operator-supplied app credentials are being saved. */
  savingCredentials: boolean;
  /**
   * Why the last attempt to SAVE app credentials failed, or null.
   *
   * Held apart from {@link error} rather than folded into it, and the
   * distinction is load-bearing: a save failure says nothing about why the
   * SIGN-IN failed, so overwriting the sign-in failure with it would drop
   * {@link canUseOwnCredentials} to false and take the credentials form off
   * screen — with the person's typed client id inside it — leaving them no way
   * back except failing the whole sign-in again (DOR-982 review).
   */
  credentialsError: string | null;
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
   * Adopting only WATCHES. It starts no sign-in and it acts on no result: every
   * tab watching the session renders the same pushed card, and the turn a
   * finished sign-in triggers is started server-side, once, by the token exchange
   * itself. Nothing here fires it.
   *
   * @param flow - The pushed flow's id, sign-in link, and custody disclosure.
   */
  adopt: (flow: { flowId: string; authorizeUrl: string; disclosure: string }) => void;
  /**
   * Save app credentials the person got from a provider that will not let DorkOS
   * register itself (DOR-982), then start the sign-in again with them.
   *
   * Retrying is part of the action rather than a second button, because saving
   * credentials is never the thing the person came to do — signing in is. A
   * failed save leaves the flow `failed` with the save's own reason.
   *
   * @param credentials - The client id, and the client secret when there is one.
   */
  useOwnCredentials: (credentials: McpClientCredentials) => void;
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
  /** The start-path failure (a rejected `mcp.signin`); poll-path errors are derived. */
  startFailure: McpSigninErrorView | null;
  /** Why saving app credentials failed, kept beside (never on top of) the sign-in failure. */
  credentialsError: string | null;
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
  startFailure: null,
  credentialsError: null,
  flowId: null,
  watching: false,
};

/**
 * How many tools the poll body reported, or `null` when it reported none.
 *
 * `toolCount` is optional on the wire and absent means "we don't know", never
 * zero: the server reports a connection whether or not its follow-up probe could
 * take a count, so a missing value must not become "Connected · 0 tools."
 *
 * The finite/non-negative check stays even though the field is typed `number`,
 * because the type describes what DorkOS sends and this reads what ARRIVED — an
 * older or partly-upgraded server on the other end of a long-lived page is
 * exactly the case where a shape drifts, and "-1 tools" on a card is worse than
 * no count at all.
 */
function readToolCount(data: McpSigninPollResult | undefined): number | null {
  const value: unknown = data?.toolCount;
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
 * The local state a rejected request lands the flow in: `failed`, carrying the
 * plain family the server named and the raw text behind it.
 *
 * Shared by the two requests that can end a sign-in before it begins — starting
 * it, and saving the app credentials that would let it start — because a person
 * reads the same paragraph either way and the two must not drift apart.
 *
 * @param err - The rejection.
 */
function failedFrom(err: Error): SigninLocalState {
  return {
    ...IDLE_STATE,
    phase: 'failed',
    startFailure: describeSigninError({ message: err.message, ...readSigninFailurePayload(err) }),
  };
}

/**
 * A poll-path failure as the UI reads it.
 *
 * The poll's `error` is already a plain, server-authored sentence — "This
 * sign-in link expired. Please start again." — so it is passed through rather
 * than re-classified: there is no family code on this path to classify by, and
 * inventing one from the wording is exactly what the code exists to avoid.
 *
 * @param message - The poll's terminal error, or null while it is healthy.
 */
function toPollFailure(message: string | null): McpSigninErrorView | null {
  return message === null ? null : describeSigninError({ message });
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
            startFailure: describeSigninError({
              message: 'DorkOS could not build a sign-in link for this server.',
            }),
          });
          return;
        }
        resetPollCounter(result.flowId);
        setLocal({
          phase: result.alreadyConnected ? 'connected' : 'disclosure',
          disclosure: result.disclosure,
          authorizeUrl: result.authorizeUrl ?? null,
          startFailure: null,
          credentialsError: null,
          flowId: result.flowId,
          watching: false,
        });
      },
      onError: (err) => setLocal(failedFrom(err)),
    });
  }, [startMutation, resetPollCounter]);

  const credentialsMutation = useMutation({
    mutationFn: (credentials: McpClientCredentials) =>
      transport.setMcpClientCredentials(agentId, serverName, credentials),
    // The failed step is this mutation's surface too — no global toast.
    meta: { suppressErrorToast: true },
  });

  const useOwnCredentials = useCallback(
    (credentials: McpClientCredentials) => {
      // Clear the previous attempt's complaint so a second save is not read
      // through the first one's error.
      setLocal((prev) =>
        prev.credentialsError === null ? prev : { ...prev, credentialsError: null }
      );
      credentialsMutation.mutate(credentials, {
        onSuccess: () => {
          // The save evicted this server's stored sign-in and replaced its client
          // identity, so anything holding `authStatus`/`authClientOrigin` from
          // before is now wrong — including a roster nobody is about to refetch
          // (the `dorkos call mcp.set_client` path has no card watching it).
          invalidateStatus();
          // Saving replaced the client identity server-side, which forgets the old
          // sign-in — so the retry is the point, not a courtesy.
          start();
        },
        // A failed SAVE leaves the sign-in failure exactly as it was. It has to:
        // that failure is what says the credentials form belongs on screen, and
        // clobbering it takes the form away mid-typing (DOR-982 review).
        onError: (err) => setLocal((prev) => ({ ...prev, credentialsError: err.message })),
      });
    },
    [credentialsMutation, invalidateStatus, start]
  );

  const adopt = useCallback(
    (flow: { flowId: string; authorizeUrl: string; disclosure: string }) => {
      // Adopting the flow already on screen is a no-op, so a re-render (or a
      // re-pushed card) cannot knock a `waiting` flow back to `disclosure` and
      // strand the person mid-sign-in. Guarded on the ref, which mirrors the
      // state synchronously — the card adopts from an effect, and two of those
      // can run before React re-renders.
      if (flowIdRef.current === flow.flowId) return;
      // A card the server pushed means the server's sign-in state just changed —
      // most sharply when a working sign-in was revoked mid-session (DOR-981),
      // where the managed roster is still holding "Connected" from before. Refresh
      // it now rather than letting an open settings panel keep saying so for the
      // rest of its stale window.
      invalidateStatus();
      resetPollCounter(flow.flowId);
      setLocal({
        phase: 'disclosure',
        disclosure: flow.disclosure,
        authorizeUrl: flow.authorizeUrl,
        startFailure: null,
        credentialsError: null,
        flowId: flow.flowId,
        watching: true,
      });
    },
    [resetPollCounter]
  );

  const authOpened = useCallback(() => {
    setLocal((prev) => (prev.phase === 'disclosure' ? { ...prev, phase: 'waiting' } : prev));
  }, []);

  const reset = useCallback(() => {
    resetPollCounter(null);
    setLocal(IDLE_STATE);
  }, [resetPollCounter]);

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

  // Whenever this instance is POLLING — including a watching card that never
  // clicked anything — the poll's own verdict is the better error. Gating this on
  // `waiting` meant a watching card that saw the provider refuse the sign-in
  // rendered the generic "did not complete" fallback while the server's actual
  // reason sat unread in the poll body.
  const failure = isPolling(local)
    ? toPollFailure(pollErrorMessage(poll.data, requestFailures))
    : local.startFailure;

  const retryNotice = step === 'waiting' && requestFailures > 0 ? POLL_RETRY_NOTICE : null;

  return {
    state: {
      step,
      disclosure: local.disclosure,
      authorizeUrl: local.authorizeUrl,
      error: failure?.message ?? null,
      errorDetail: failure?.detail ?? null,
      canUseOwnCredentials: failure?.canUseOwnCredentials ?? false,
      savingCredentials: credentialsMutation.isPending,
      credentialsError: local.credentialsError,
      retryNotice,
      toolCount: step === 'connected' ? readToolCount(poll.data) : null,
    },
    start,
    adopt,
    authOpened,
    useOwnCredentials,
    reset,
  };
}
