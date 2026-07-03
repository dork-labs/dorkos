/**
 * DorkOS account-link model — owns the device-link flow lifecycle for the
 * Settings panel (accounts-and-auth P2). Reads the settled summary
 * (`GET /api/cloud/status`) for the initial render, drives `start`/`unlink`
 * through the transport, and polls the live flow state
 * (`GET /api/cloud/link/status`) from `pending` to a terminal state, stopping on
 * every terminal state and on unmount.
 *
 * This is INDEPENDENT of local login: nothing here reads the auth session or the
 * AuthGuard. The instance token never reaches the client and is never logged.
 *
 * @module features/cloud-link/model/use-cloud-link
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type {
  CloudLinkState,
  CloudLinkStatus,
  CloudLinkSummary,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';

/** How often the panel polls the flow state while a link is `pending`. */
const POLL_INTERVAL_MS = 2500;

/** Flow states that end the poll — no further transitions are expected. */
const TERMINAL_STATES = new Set<CloudLinkState>(['linked', 'denied', 'expired', 'unlinked']);

/** TanStack Query key for the settled cloud-link summary. */
export const cloudStatusKey = ['cloud', 'status'] as const;

/**
 * The rendered view of the account-link panel — a single discriminated union so
 * the UI never has to reconcile the summary and the live flow state itself.
 */
export type CloudLinkView =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'pending'; userCode: string; verificationUri: string; expiresAt: string }
  | { kind: 'linked'; accountLabel: string | null; lastHeartbeatAt: string | null }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'revoked' };

/** Everything the {@link CloudLinkPanel} needs to render and drive the flow. */
export interface UseCloudLink {
  view: CloudLinkView;
  /** Begin the device flow (or restart it after expiry/denial). */
  start: () => Promise<void>;
  /** Unlink this instance from its DorkOS account. */
  unlink: () => Promise<void>;
  starting: boolean;
  unlinking: boolean;
  /** Friendly message when `start` fails (e.g. the cloud was unreachable). */
  startError: string | null;
}

/** Extract a friendly message from a transport error. */
function cloudErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Could not reach the DorkOS cloud. Try again shortly.';
}

/**
 * Own the account-link flow: settled summary, device-flow codes, live polling,
 * and the link/unlink actions. See the module doc for the independence contract.
 */
export function useCloudLink(): UseCloudLink {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const summary = useQuery<CloudLinkSummary>({
    queryKey: cloudStatusKey,
    queryFn: () => transport.getCloudStatus(),
    staleTime: 30_000,
  });

  const [flow, setFlow] = useState<StartLinkResult | null>(null);
  const [linkStatus, setLinkStatus] = useState<CloudLinkStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const next = await transport.getCloudLinkStatus();
      setLinkStatus(next);
      if (TERMINAL_STATES.has(next.state)) {
        stopPolling();
        if (next.state === 'linked') {
          await queryClient.invalidateQueries({ queryKey: cloudStatusKey });
        }
      }
    } catch {
      // Transient (network / 5xx): keep the interval and retry next tick.
    }
  }, [transport, queryClient, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
  }, [poll, stopPolling]);

  // Read the live flow state once on mount so a runtime `unlinked` (revoked),
  // `expired`, or `denied` state surfaces immediately; clean up the poll on
  // unmount.
  useEffect(() => {
    let cancelled = false;
    transport
      .getCloudLinkStatus()
      .then((s) => {
        if (!cancelled) setLinkStatus(s);
      })
      .catch(() => {
        /* best-effort — the summary still drives the baseline view */
      });
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [transport, stopPolling]);

  const start = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const codes = await transport.startCloudLink();
      setFlow(codes);
      setLinkStatus({ state: 'pending' });
      startPolling();
    } catch (err) {
      setStartError(cloudErrorMessage(err));
    } finally {
      setStarting(false);
    }
  }, [transport, startPolling]);

  const unlink = useCallback(async () => {
    setUnlinking(true);
    try {
      await transport.unlinkCloud();
      stopPolling();
      setFlow(null);
      setLinkStatus({ state: 'idle' });
      // Optimistically settle the summary so the panel returns to idle at once;
      // the invalidation then reconciles with the server.
      queryClient.setQueryData<CloudLinkSummary>(cloudStatusKey, {
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      await queryClient.invalidateQueries({ queryKey: cloudStatusKey });
    } finally {
      setUnlinking(false);
    }
  }, [transport, queryClient, stopPolling]);

  const view = useMemo<CloudLinkView>(() => {
    const flowState = linkStatus?.state;

    // An active device flow (codes in hand) shows the pending view.
    if (flow && flowState === 'pending') {
      return {
        kind: 'pending',
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAt: flow.expiresAt,
      };
    }
    // Terminal flow states surface whether or not we still hold the codes.
    if (flowState === 'denied') return { kind: 'denied' };
    if (flowState === 'expired') return { kind: 'expired' };
    if (flowState === 'unlinked') return { kind: 'revoked' };
    if (flowState === 'linked') {
      return {
        kind: 'linked',
        accountLabel: linkStatus?.accountLabel ?? summary.data?.accountLabel ?? null,
        lastHeartbeatAt: linkStatus?.lastHeartbeatAt ?? summary.data?.lastHeartbeatAt ?? null,
      };
    }

    // No decisive flow state — fall back to the settled summary.
    if (summary.isLoading && !summary.data) return { kind: 'loading' };
    if (summary.data?.linked) {
      return {
        kind: 'linked',
        accountLabel: summary.data.accountLabel,
        lastHeartbeatAt: summary.data.lastHeartbeatAt,
      };
    }
    return { kind: 'idle' };
  }, [flow, linkStatus, summary.data, summary.isLoading]);

  return { view, start, unlink, starting, unlinking, startError };
}
