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
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '@/layers/entities/connectors';
import { accountSignInKeys } from '@/layers/entities/community';
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
 * The settled linked/unlinked summary (`GET /api/cloud/status`) on its own,
 * without the device flow behind it.
 *
 * For a surface that only needs to SAY whether this computer is signed in —
 * the header menu's account row — and must not start polling or a mount-time
 * flow read the way {@link useCloudLink} does. Both read one cache entry, so a
 * link or unlink in Settings is seen everywhere at once.
 */
export function useCloudStatus() {
  const transport = useTransport();
  return useQuery<CloudLinkSummary>({
    queryKey: cloudStatusKey,
    queryFn: () => transport.getCloudStatus(),
    staleTime: 30_000,
  });
}

/**
 * Refresh everything read through the DorkOS account once the link changes
 * hands: the connections that came through it, and which space sites sign in
 * with it.
 *
 * @param queryClient - The app's query client.
 */
function invalidateAccountReads(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
    queryClient.invalidateQueries({ queryKey: accountSignInKeys.all }),
  ]);
}

/** What {@link useCheckCloudLink}'s check does with a link it finds ended. */
export interface CheckCloudLinkOptions {
  /**
   * Clear the server's "DorkOS revoked this computer's access" note before
   * anything shows it, because the person ended the link themselves (an
   * account deletion they confirmed). The panel then reads signed out. A new
   * link flow in progress is left alone.
   */
  expected?: boolean;
}

/**
 * Ask the DorkOS account, now, whether it still accepts this computer.
 *
 * For a surface waiting on something that ends the link somewhere else, such
 * as an account deletion confirmed from an email: the next scheduled check may
 * be minutes away. The answer is written straight into the shared summary, so
 * every surface that says whether this computer is signed in moves at once,
 * and an ended link refreshes what was read through the account.
 *
 * @returns A check that resolves with the settled summary, or `null` when this
 *   DorkOS could not be asked.
 */
export function useCheckCloudLink(): (
  options?: CheckCloudLinkOptions
) => Promise<CloudLinkSummary | null> {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useCallback(
    async (options: CheckCloudLinkOptions = {}) => {
      let summary: CloudLinkSummary;
      try {
        summary = await transport.checkCloudLink();
      } catch {
        return null;
      }
      if (!summary.linked && options.expected) {
        // Before the summary moves, so the panel re-reads a flow state that
        // no longer carries the note. Never while a new link is being made:
        // cancelling would throw away the code the person is about to approve.
        const flow = await transport.getCloudLinkStatus().catch(() => null);
        if (flow !== null && flow.state !== 'pending') {
          await transport.cancelCloudLink().catch(() => {});
        }
      }
      queryClient.setQueryData<CloudLinkSummary>(cloudStatusKey, summary);
      if (!summary.linked) await invalidateAccountReads(queryClient);
      return summary;
    },
    [transport, queryClient]
  );
}

/**
 * The rendered view of the account-link panel — a single discriminated union so
 * the UI never has to reconcile the summary and the live flow state itself.
 */
export type CloudLinkView =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'pending'; userCode: string; verificationUri: string; expiresAt: string }
  | {
      kind: 'linked';
      accountLabel: string | null;
      lastHeartbeatAt: string | null;
      /** How a relink ended when it did not replace the link; this computer stayed linked. */
      relinkOutcome?: CloudLinkStatus['relinkOutcome'];
    }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'revoked' };

/** Everything the {@link CloudLinkPanel} needs to render and drive the flow. */
export interface UseCloudLink {
  view: CloudLinkView;
  /** Begin the device flow (or restart it after expiry/denial). */
  start: () => Promise<void>;
  /** Unlink this computer from its DorkOS account. */
  unlink: () => Promise<void>;
  /** Stop a link in progress, or dismiss the note a relink that didn't finish left. */
  cancel: () => Promise<void>;
  starting: boolean;
  unlinking: boolean;
  /** Friendly message when `start` fails (e.g. the cloud was unreachable). */
  startError: string | null;
  /** Why the last `unlink` changed nothing (e.g. only the install's owner may unlink). */
  unlinkError: string | null;
}

/** Extract a friendly message from a transport error. */
function cloudErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Couldn’t reach the DorkOS cloud. Try again shortly.';
}

/**
 * Own the account-link flow: settled summary, device-flow codes, live polling,
 * and the link/unlink actions. See the module doc for the independence contract.
 */
export function useCloudLink(): UseCloudLink {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const summary = useCloudStatus();

  const [flow, setFlow] = useState<StartLinkResult | null>(null);
  const [linkStatus, setLinkStatus] = useState<CloudLinkStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True while this hook is mounted — guards state updates from awaited transport
  // calls that resolve after unmount (belt-and-suspenders alongside `stopPolling`).
  const mountedRef = useRef(true);
  // True once the user has started a device flow — makes the one-shot mount status
  // fetch defer to `start()`'s `pending` state if it loses the resolve race.
  const flowActiveRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const next = await transport.getCloudLinkStatus();
      if (!mountedRef.current) return;
      setLinkStatus(next);
      if (TERMINAL_STATES.has(next.state)) {
        stopPolling();
        if (next.state === 'linked') {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: cloudStatusKey }),
            queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
            // Which space sites sign in with the account belongs to the account.
            queryClient.invalidateQueries({ queryKey: accountSignInKeys.all }),
          ]);
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
    mountedRef.current = true;
    transport
      .getCloudLinkStatus()
      .then((s) => {
        // Skip if unmounted, or if a device flow has already started — the mount
        // fetch must not clobber `start()`'s `pending` state if it resolves later.
        if (mountedRef.current && !flowActiveRef.current) setLinkStatus(s);
      })
      .catch(() => {
        /* best-effort — the summary still drives the baseline view */
      });
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [transport, stopPolling]);

  // A link that ended somewhere else (the account was deleted, or this
  // computer was unlinked on the web) reaches this panel as the shared summary
  // turning unlinked. The flow state read on mount still says "linked", so read
  // it again rather than keep showing an account that has gone. A device flow
  // in progress owns the flow state and is left alone.
  const wasLinked = useRef<boolean | undefined>(undefined);
  const linkedNow = summary.data?.linked;
  useEffect(() => {
    const before = wasLinked.current;
    wasLinked.current = linkedNow;
    if (before !== true || linkedNow !== false || flowActiveRef.current) return;
    transport
      .getCloudLinkStatus()
      .then((s) => {
        if (mountedRef.current && !flowActiveRef.current) setLinkStatus(s);
      })
      .catch(() => {
        // The summary still drives the view once the flow state is cleared.
        if (mountedRef.current && !flowActiveRef.current) setLinkStatus(null);
      });
  }, [linkedNow, transport]);

  const start = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    flowActiveRef.current = true;
    try {
      const codes = await transport.startCloudLink();
      setFlow(codes);
      setLinkStatus({ state: 'pending' });
      startPolling();
    } catch (err) {
      flowActiveRef.current = false;
      setStartError(cloudErrorMessage(err));
    } finally {
      setStarting(false);
    }
  }, [transport, startPolling]);

  const cancel = useCallback(async () => {
    stopPolling();
    setFlow(null);
    flowActiveRef.current = false;
    setStartError(null);
    try {
      setLinkStatus(await transport.cancelCloudLink());
    } catch (err) {
      // The server keeps its own state; the next status read reconciles it.
      setLinkStatus(null);
      // A refusal (only the owner of this DorkOS may stop a link) is said, so
      // the person is not left wondering why the code came back.
      if ((err as { status?: unknown }).status === 403) setStartError(cloudErrorMessage(err));
    }
    await queryClient.invalidateQueries({ queryKey: cloudStatusKey });
  }, [transport, queryClient, stopPolling]);

  const unlink = useCallback(async () => {
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await transport.unlinkCloud();
      stopPolling();
      setFlow(null);
      flowActiveRef.current = false;
      setLinkStatus({ state: 'idle' });
      // Optimistically settle the summary so the panel returns to idle at once;
      // the invalidation then reconciles with the server.
      queryClient.setQueryData<CloudLinkSummary>(cloudStatusKey, {
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cloudStatusKey }),
        invalidateAccountReads(queryClient),
      ]);
    } catch (err) {
      // Unlink failed (refused, or the local server call errored): the instance
      // was not unlinked, so leave the panel in the linked view, say why, and
      // let the user retry. Caught so a rejected transport call never becomes
      // an unhandled rejection.
      setUnlinkError(cloudErrorMessage(err));
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
        ...(linkStatus?.relinkOutcome ? { relinkOutcome: linkStatus.relinkOutcome } : {}),
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

  return { view, start, unlink, cancel, starting, unlinking, startError, unlinkError };
}
