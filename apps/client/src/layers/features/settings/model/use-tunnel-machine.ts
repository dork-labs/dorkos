/**
 * The Remote Access dialog's own state — what nothing outside the dialog needs.
 *
 * ## What moved out, and why (DOR-1743)
 *
 * This hook used to own remote access outright: the lifecycle, the URL, the
 * failure, the server sync and the status toasts. That was fine while the
 * dialog was the only way to see or change any of it. It is not any more —
 * the Control Center has a Remote-access row and the top bar has a beacon —
 * and three copies of a `useState` machine would each start a tunnel the other
 * two did not know about. All of that now lives in `@/layers/entities/tunnel`
 * and is read here through {@link useRemoteAccess}.
 *
 * What is left is genuinely the dialog's: which view it has navigated to, the
 * token and domain fields, the errors those two writes can produce, and the
 * latency probe that only runs while the dialog is on screen.
 *
 * @module features/settings/model/use-tunnel-machine
 */

import { useState, useEffect } from 'react';
import { useRemoteAccess, type TunnelReport, type TunnelState } from '@/layers/entities/tunnel';
import {
  type ViewState,
  LATENCY_INTERVAL_MS,
  LATENCY_PROBE_TIMEOUT_MS,
  deriveViewState,
} from './tunnel-view-state';

/** Aggregated state + setters returned by {@link useTunnelMachine}. */
export interface TunnelMachine {
  // --- Shared with every other remote-access surface (read-only here) ---
  /** Where remote access is, as the app understands it. */
  state: TunnelState;
  /** The public URL, or `null`. */
  url: string | null;
  /** Why the last start or stop failed, or `null`. */
  error: string | null;
  /**
   * The server's tunnel block — the DTO as `GET /api/config` reports it, or
   * `undefined` while that read is in flight.
   */
  tunnel: TunnelReport | undefined;
  tokenConfigured: boolean;
  isTransitioning: boolean;
  isChecked: boolean;

  // --- The dialog's own ---
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
  latencyMs: number | null;
  viewState: ViewState;
}

/**
 * The Remote Access dialog's own state — navigation, its two fields, and the
 * latency probe.
 *
 * @param open - Whether the parent dialog is open (gates the latency interval)
 */
export function useTunnelMachine({ open }: { open: boolean }): TunnelMachine {
  const remote = useRemoteAccess();
  const tunnel = remote.tunnel;

  const [showSetup, setShowSetup] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [domain, setDomain] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local domain input from server config
    if (tunnel?.domain) setDomain(tunnel.domain);
  }, [tunnel?.domain]);

  // Reset showSetup when token gets configured
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset setup nav when token saves
    if (tunnel?.tokenConfigured) setShowSetup(false);
  }, [tunnel?.tokenConfigured]);

  // The two FIELD errors are cleared when the dialog is next opened.
  //
  // Not housekeeping — the dialog is mounted for the life of the app.
  // `DialogHost` renders every contribution unconditionally and `open` only
  // ever gates what is PAINTED, so this hook's state is never torn down:
  // without this, a refused token save would sit there for every later visit in
  // that browser session.
  //
  // **The tunnel's own failure is deliberately NOT cleared here** — see the
  // `error` field's own doc in `entities/tunnel`'s store. It is a state of
  // remote access rather than of this dialog now, the Control Center row
  // reports it continuously, and the
  // "Fix…" link on that row exists precisely to open this dialog and read the
  // full sentence. Clearing it on the opening edge would empty the dialog that
  // link exists to fill.
  /* eslint-disable react-hooks/set-state-in-effect -- reset transient field errors on the dialog's opening edge */
  useEffect(() => {
    if (!open) return;
    setTokenError(null);
    setDomainError(null);
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    if (remote.state !== 'connected' || !remote.url || !open) {
      setLatencyMs(null);
      return;
    }
    const url = remote.url;
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
  }, [remote.state, remote.url, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    state: remote.state,
    url: remote.url,
    error: remote.error,
    tunnel,
    tokenConfigured: remote.tokenConfigured,
    isTransitioning: remote.isTransitioning,
    isChecked: remote.isChecked,
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
    latencyMs,
    viewState: deriveViewState(remote.tokenConfigured, showSetup, remote.state, !!remote.url),
  };
}
