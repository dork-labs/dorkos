/**
 * Owns the Remote Access dialog state machine — local state declarations,
 * server-config sync effects, stuck-state recovery, latency measurement, and
 * disconnect/reconnect toast notifications.
 *
 * Pure refactor of the state hooks previously inlined in `TunnelDialog`.
 * Effect ordering and dependency arrays are load-bearing — see spec
 * `settings-dialog-01-file-splits` §6.5.
 *
 * @module features/settings/model/use-tunnel-machine
 */

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ServerConfig } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import {
  type TunnelState,
  type ViewState,
  STUCK_STATE_TIMEOUT_MS,
  LATENCY_INTERVAL_MS,
  deriveViewState,
} from './tunnel-view-state';

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
  latencyMs: number | null;
  passcodeEnabled: boolean;
  setPasscodeEnabled: (v: boolean) => void;
  passcodeInput: string;
  setPasscodeInput: (v: string) => void;
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
  const transport = useTransport();
  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const tunnel = serverConfig?.tunnel;

  const [state, setState] = useState<TunnelState>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [domain, setDomain] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [passcodeEnabled, setPasscodeEnabled] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState('');

  const prevConnectedRef = useRef<boolean | undefined>(undefined);

  // Sync state from server config
  /* eslint-disable react-hooks/set-state-in-effect -- sync local UI state from server tunnel config push */
  useEffect(() => {
    if (tunnel?.connected && tunnel?.url) {
      setState('connected');
      setUrl(tunnel.url);
    } else if (state !== 'starting' && state !== 'stopping') {
      setState('off');
      setUrl(null);
    }
  }, [tunnel?.connected, tunnel?.url, state]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local domain input from server config
    if (tunnel?.domain) setDomain(tunnel.domain);
  }, [tunnel?.domain]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local passcode toggle from server config
    if (tunnel?.passcodeEnabled !== undefined) setPasscodeEnabled(tunnel.passcodeEnabled);
  }, [tunnel?.passcodeEnabled]);

  // Reset showSetup when token gets configured
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset setup nav when token saves
    if (tunnel?.tokenConfigured) setShowSetup(false);
  }, [tunnel?.tokenConfigured]);

  // Disconnect/reconnect toast notifications
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    const isConnected = tunnel?.connected ?? false;
    prevConnectedRef.current = isConnected;
    if (wasConnected === undefined) return;
    if (wasConnected && !isConnected) {
      toast.error('Remote access disconnected', {
        id: 'tunnel-status',
        description: 'Attempting to reconnect...',
      });
    } else if (!wasConnected && isConnected && tunnel?.url) {
      toast.success('Remote access reconnected', {
        id: 'tunnel-status',
        description: tunnel.url,
      });
    }
  }, [tunnel?.connected, tunnel?.url]);

  // Recovery from stuck transitional states
  useEffect(() => {
    if (state !== 'starting' && state !== 'stopping') return;
    const timer = setTimeout(() => {
      if (state === 'starting') {
        setState('error');
        setError('Connection timed out. Please try again.');
      } else if (state === 'stopping') {
        setState('off');
        setUrl(null);
      }
    }, STUCK_STATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // Latency measurement when connected and dialog is open
  /* eslint-disable react-hooks/set-state-in-effect -- periodic latency measurement via interval */
  useEffect(() => {
    if (state !== 'connected' || !url || !open) {
      setLatencyMs(null);
      return;
    }
    const measure = async () => {
      try {
        const start = performance.now();
        await fetch(`${url}/api/health`, { mode: 'cors', cache: 'no-store' });
        setLatencyMs(Math.round(performance.now() - start));
      } catch {
        setLatencyMs(null);
      }
    };
    measure();
    const interval = setInterval(measure, LATENCY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state, url, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const tokenConfigured = !!tunnel?.tokenConfigured;
  const viewState = deriveViewState(tokenConfigured, showSetup, state);
  const isTransitioning = state === 'starting' || state === 'stopping';
  const isChecked = state === 'connected' || state === 'starting' || state === 'stopping';

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
    latencyMs,
    passcodeEnabled,
    setPasscodeEnabled,
    passcodeInput,
    setPasscodeInput,
    tunnel,
    tokenConfigured,
    viewState,
    isTransitioning,
    isChecked,
  };
}
