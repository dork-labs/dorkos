/**
 * Owns the Remote Access dialog state machine — local state declarations,
 * server-config sync, latency measurement, and disconnect/reconnect toasts.
 *
 * ## The one rule this hook exists to keep (DOR-1739)
 *
 * There are two things that can move the tunnel state, and they are not peers:
 * an ACTION the person took (`use-tunnel-actions.ts`), and a REPORT from the
 * server about what the tunnel is actually doing. An action's outcome is the
 * newest fact in the room, so nothing here may overwrite it — a sync effect
 * gets to speak only when the server's report has genuinely CHANGED.
 *
 * This used to be the other way round, with catastrophic results. The sync
 * effect listed `state` in its own dependencies and wrote `state`, so every
 * local transition re-ran it and it pushed the state straight back to `off`:
 * a failed start rendered the error view for a single paint before erasing it,
 * so the "Try again" button was unreachable and every ngrok failure read as
 * "the switch did nothing" — the exact symptom reported in #1458. A SUCCESSFUL
 * start flickered connected → ready → connected for the same reason, while it
 * waited for the config refetch to catch up.
 *
 * @module features/settings/model/use-tunnel-machine
 */

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { ServerConfig } from '@dorkos/shared/types';
import { useConfig } from '@/layers/entities/config';
import {
  type TunnelState,
  type ViewState,
  LATENCY_INTERVAL_MS,
  LATENCY_PROBE_TIMEOUT_MS,
  deriveViewState,
} from './tunnel-view-state';

/**
 * What the server says about the tunnel, plus the field DOR-1738 is adding.
 *
 * `isRunning` answers "is the listener still open", which is a different
 * question from `connected` ("is it reachable right now"). While ngrok
 * re-establishes a dropped session the first is true and the second is false,
 * and a client that only knows `connected` has to call that OFF.
 *
 * It is declared here rather than on the shared DTO because `schemas.ts` belongs
 * to DOR-1738; this widening disappears when that lands. Optional on purpose —
 * a server that has not shipped it yet sends nothing, and
 * {@link readTunnelReport} falls back to the old meaning.
 */
type TunnelReport = NonNullable<ServerConfig['tunnel']> & { isRunning?: boolean };

/** The three states the server's report can put the tunnel in. */
type ReportedStatus = 'on' | 'reconnecting' | 'off';

/**
 * Read the server's tunnel block into the three states the dialog distinguishes.
 *
 * The `?? connected` fallback is what makes this safe to ship before DOR-1738:
 * against a server with no `isRunning`, `reconnecting` can never be produced and
 * every reading is exactly what it was.
 */
function readTunnelReport(tunnel: TunnelReport | undefined): {
  status: ReportedStatus;
  url: string | null;
} {
  const connected = tunnel?.connected ?? false;
  const running = tunnel?.isRunning ?? connected;
  return {
    status: connected ? 'on' : running ? 'reconnecting' : 'off',
    url: tunnel?.url ?? null,
  };
}

/** Aggregated state + setters returned by {@link useTunnelMachine}. */
export interface TunnelMachine {
  // State
  state: TunnelState;
  setState: (s: TunnelState) => void;
  url: string | null;
  setUrl: (u: string | null) => void;
  error: string | null;
  setError: (e: string | null) => void;
  showSetup: boolean;
  setShowSetup: (v: boolean) => void;
  authToken: string;
  setAuthToken: (t: string) => void;
  tokenError: string | null;
  setTokenError: (e: string | null) => void;
  showTokenInput: boolean;
  setShowTokenInput: (v: boolean) => void;
  domain: string;
  setDomain: (d: string) => void;
  domainError: string | null;
  setDomainError: (e: string | null) => void;
  /**
   * Arm or disarm the toast suppression around a change the person asked for.
   *
   * Armed before the toggle acts, so a status change it causes is not announced
   * back to them as news; disarmed again if the toggle FAILED, because then no
   * transition is coming and a flag left armed would silently eat the next
   * genuine one.
   */
  setUserInitiated: (v: boolean) => void;
  latencyMs: number | null;
  // Derived
  tunnel: ServerConfig['tunnel'] | undefined;
  tokenConfigured: boolean;
  viewState: ViewState;
  isTransitioning: boolean;
  isChecked: boolean;
}

/**
 * Owns the Remote Access dialog state machine — local state, server-config sync,
 * stuck-state recovery, latency measurement, and disconnect/reconnect toasts.
 *
 * @param open - Whether the parent dialog is open (gates the latency interval)
 */
export function useTunnelMachine({ open }: { open: boolean }): TunnelMachine {
  // The shared config read, not a second one of its own. An observer that spells
  // this query by hand also picks its own `staleTime`, and observers on one key
  // do not average theirs — the tightest wins and the rest describe a behaviour
  // nobody gets. This hook asked for 5 minutes and was silently on the 30s every
  // other reader sets (`CONFIG_STALE_TIME_MS`).
  const { data: serverConfig } = useConfig();

  const tunnel = serverConfig?.tunnel;
  // Read once, at render, into two primitives. The effects below depend on
  // THESE rather than on `tunnel` — an object identity that changes on every
  // refetch — so each one re-runs exactly when the answer changed and not when
  // the query merely spoke again.
  const { status: reportedStatus, url: reportedUrl } = readTunnelReport(tunnel);

  const [state, setState] = useState<TunnelState>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [domain, setDomain] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const prevStatusRef = useRef<ReportedStatus | undefined>(undefined);
  // The last thing the SERVER said, so this hook can tell a fresh report from a
  // re-render. Without it there is no way to distinguish "the tunnel dropped"
  // from "the config query handed back the same answer again".
  const lastReportRef = useRef<{ status: ReportedStatus; url: string | null } | null>(null);
  // Set by the toggle before it acts, so the connect/disconnect toasts stay
  // quiet for the transition the person just asked for.
  const userInitiatedRef = useRef(false);

  // Sync state from server config — only when that config actually changed.
  //
  // The change check IS the fix. `state` is deliberately absent from the deps
  // and from the body: a local transition must not be able to re-run this, and
  // an effect that cannot re-run on local state has nothing to guard against.
  // The old `state !== 'starting' && state !== 'stopping'` condition was trying
  // to do this job by naming the two states it had noticed being clobbered; it
  // could not name `error` or a freshly-set `connected`, and those were the two
  // that mattered.
  /* eslint-disable react-hooks/set-state-in-effect -- sync local UI state from a changed server tunnel report */
  useEffect(() => {
    const previous = lastReportRef.current;
    if (previous && previous.status === reportedStatus && previous.url === reportedUrl) return;
    lastReportRef.current = { status: reportedStatus, url: reportedUrl };

    if (reportedStatus === 'on' && reportedUrl) {
      setState('connected');
      setUrl(reportedUrl);
    } else if (reportedStatus === 'reconnecting') {
      // The listener is still open, so the URL the person copied is still the
      // right one and is kept. Clearing it would empty the dialog over a tunnel
      // that is about to answer again.
      setState('reconnecting');
      if (reportedUrl) setUrl(reportedUrl);
    } else {
      setState('off');
      setUrl(null);
    }
  }, [reportedStatus, reportedUrl]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local domain input from server config
    if (tunnel?.domain) setDomain(tunnel.domain);
  }, [tunnel?.domain]);

  // Reset showSetup when token gets configured
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset setup nav when token saves
    if (tunnel?.tokenConfigured) setShowSetup(false);
  }, [tunnel?.tokenConfigured]);

  // Toasts for a change the person did NOT make.
  //
  // A toast is an interruption, and the only thing worth interrupting somebody
  // for here is news. Flipping the switch yourself is not news — it produced the
  // very view you are looking at — so a toggle marks the transition it is about
  // to cause and this effect stays quiet for it. Until DOR-1738 the server never
  // reported a drop at all, so the one transition anybody actually saw was their
  // own stop, announced in red as if something had gone wrong.
  //
  // The old description also promised "Attempting to reconnect...", which
  // nothing in DorkOS does. Remote access stays off until it is turned back on.
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = reportedStatus;
    if (previous === undefined || previous === reportedStatus) return;

    // Consumed on the first real transition either way, so a stop that the
    // server never reports cannot leave the next genuine drop silent.
    if (userInitiatedRef.current) {
      userInitiatedRef.current = false;
      return;
    }

    if (reportedStatus === 'reconnecting') {
      // "Reconnecting" is a promise, and this is the one state in which DorkOS
      // can keep it: ngrok's own agent retries a dropped session and emits
      // `connected` again on recovery. The old code said it on every drop,
      // including a permanent one, where nothing was retrying anything.
      toast.warning('Remote access is reconnecting', {
        id: 'tunnel-status',
        description: 'Your other devices may not reach DorkOS until it is back.',
      });
    } else if (reportedStatus === 'off') {
      toast.error('Remote access turned off', {
        id: 'tunnel-status',
        description: 'Your other devices can no longer reach DorkOS. Turn it back on to restore.',
      });
    } else if (reportedUrl) {
      toast.success('Remote access is on', { id: 'tunnel-status', description: reportedUrl });
    }
  }, [reportedStatus, reportedUrl]);

  // Latency measurement when connected and dialog is open.
  //
  // Every probe is abandoned on teardown and capped at
  // `LATENCY_PROBE_TIMEOUT_MS`. Neither is optional: this fires at a tunnel that
  // is by definition somewhere else on the internet, so an unreachable one used
  // to leave a `fetch` hanging with nothing to end it and start another 30s
  // later, and each one that eventually resolved wrote `latencyMs` back into a
  // dialog the person may have closed several states ago.
  /* eslint-disable react-hooks/set-state-in-effect -- periodic latency measurement via interval */
  useEffect(() => {
    if (state !== 'connected' || !url || !open) {
      setLatencyMs(null);
      return;
    }
    const controller = new AbortController();
    const measure = async () => {
      try {
        const start = performance.now();
        await fetch(`${url}/api/health`, {
          mode: 'cors',
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(LATENCY_PROBE_TIMEOUT_MS),
          ]),
        });
        if (controller.signal.aborted) return;
        setLatencyMs(Math.round(performance.now() - start));
      } catch {
        if (controller.signal.aborted) return;
        setLatencyMs(null);
      }
    };
    void measure();
    const interval = setInterval(() => void measure(), LATENCY_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [state, url, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const tokenConfigured = !!tunnel?.tokenConfigured;
  const viewState = deriveViewState(tokenConfigured, showSetup, state, !!url);
  const isTransitioning = state === 'starting' || state === 'stopping';
  // Reconnecting counts as ON — the listener is open and the person did not turn
  // anything off — but NOT as transitioning, because that would disable the very
  // switch they need in order to turn it off while ngrok keeps retrying.
  const isChecked =
    state === 'connected' ||
    state === 'starting' ||
    state === 'stopping' ||
    state === 'reconnecting';

  return {
    state,
    setState,
    url,
    setUrl,
    error,
    setError,
    showSetup,
    setShowSetup,
    authToken,
    setAuthToken,
    tokenError,
    setTokenError,
    showTokenInput,
    setShowTokenInput,
    domain,
    setDomain,
    domainError,
    setDomainError,
    setUserInitiated: (v: boolean) => {
      userInitiatedRef.current = v;
    },
    latencyMs,
    tunnel,
    tokenConfigured,
    viewState,
    isTransitioning,
    isChecked,
  };
}
