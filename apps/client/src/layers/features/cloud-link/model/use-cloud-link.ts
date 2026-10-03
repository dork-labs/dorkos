/**
 * DorkOS account-link model — owns the device-link flow lifecycle for every
 * surface that links this computer (accounts-and-auth P2, spec
 * `dorkos-account-by-default` §3). Reads the settled summary
 * (`GET /api/cloud/status`) for the initial render, drives `start`/`unlink`
 * through the transport, and polls the live flow state
 * (`GET /api/cloud/link/status`) from `pending` to a terminal state, stopping on
 * every terminal state and once nothing on screen reads it.
 *
 * **One flow, however many surfaces show it.** The codes, the flow state and
 * who started it live in the query cache rather than in one component, so the
 * code a person was shown in a runtime's connect card is the same code
 * Settings › DorkOS account shows, and either can finish or cancel it. The
 * surface that started a link names itself (`origin`) and may hand over what to
 * do once it lands (`afterLink`), so it picks up where it was after approval
 * even when the person approved it from another surface.
 *
 * This is INDEPENDENT of local login: nothing here reads the auth session or the
 * AuthGuard. The instance token never reaches the client and is never logged.
 *
 * @module features/cloud-link/model/use-cloud-link
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { cloudCreditsKeys, configKeys, useTransport } from '@/layers/shared/model';
import { connectorKeys } from '@/layers/entities/connectors';
import { accountSignInKeys } from '@/layers/entities/community';
import type {
  CloudLinkStatus,
  CloudLinkSummary,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';

/** How often the panel polls the flow state while a link is `pending`. */
const POLL_INTERVAL_MS = 2500;

/** TanStack Query key for the settled cloud-link summary. */
export const cloudStatusKey = ['cloud', 'status'] as const;

/** TanStack Query key for the live flow state every surface polls together. */
export const cloudLinkStatusKey = ['cloud', 'link', 'status'] as const;

/** TanStack Query key for the codes in hand and who asked for them. Never fetched. */
const cloudLinkFlowKey = ['cloud', 'link', 'flow'] as const;

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

/** What a surface says about itself when it starts a link. */
export interface StartCloudLinkOptions {
  /**
   * Which surface asked, so it can tell its own link from one another surface
   * started (`'settings'`, `'runtime-connect:claude-code'`). Only one link is
   * ever in flight, and every surface shows its code.
   */
  origin?: string;
  /**
   * What to do once THIS link lands, wherever it was approved from — how the
   * surface that started it carries on from where it was. Runs once, only for
   * a first link that was approved, and never for a relink that did not
   * replace the link.
   */
  afterLink?: () => unknown;
}

/** Everything the {@link CloudLinkPanel} needs to render and drive the flow. */
export interface UseCloudLink {
  view: CloudLinkView;
  /** Begin the device flow (or restart it after expiry/denial). */
  start: (options?: StartCloudLinkOptions) => Promise<void>;
  /**
   * Get a new code for the link that just expired or was turned down, for the
   * same surface and the same next step it was started with.
   */
  restart: () => Promise<void>;
  /** Unlink this computer from its DorkOS account. */
  unlink: () => Promise<void>;
  /** Stop a link in progress, or dismiss the note a relink that didn't finish left. */
  cancel: () => Promise<void>;
  starting: boolean;
  unlinking: boolean;
  /** Friendly message when `start` fails (e.g. the cloud was unreachable). */
  startError: string | null;
  /** Which surface started the link in flight, or `null` when none named itself. */
  origin: string | null;
}

/** The codes in hand, and who asked for them — shared by every surface. */
interface LinkFlowEntry {
  codes: StartLinkResult | null;
  origin: string | null;
  afterLink: (() => unknown) | null;
  starting: boolean;
  startError: string | null;
}

const PENDING: CloudLinkStatus = { state: 'pending' };
const IDLE: CloudLinkStatus = { state: 'idle' };

const NO_FLOW: LinkFlowEntry = {
  codes: null,
  origin: null,
  afterLink: null,
  starting: false,
  startError: null,
};

/**
 * Everything a link that just landed refreshes, then what the surface that
 * started it asked to happen next.
 *
 * @param queryClient - The app's query client.
 * @param afterLink - The starting surface's next step, or `null`.
 */
async function land(queryClient: QueryClient, afterLink: (() => unknown) | null): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: cloudStatusKey }),
    queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
    // Which space sites sign in with the account belongs to the account.
    queryClient.invalidateQueries({ queryKey: accountSignInKeys.all }),
    // Whether credits can be chosen, and the Runs on entry, move with the link.
    queryClient.invalidateQueries({ queryKey: cloudCreditsKeys.status() }),
    queryClient.invalidateQueries({ queryKey: configKeys.all }),
  ]);
  if (!afterLink) return;
  try {
    await afterLink();
  } catch {
    // The surface that asked shows its own failure; the link stands.
  }
}

/** Extract a friendly message from a transport error. */
function cloudErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Couldn’t reach the DorkOS cloud. Try again shortly.';
}

/**
 * Own the account-link flow: settled summary, device-flow codes, live polling,
 * and the link/unlink actions. See the module doc for the independence contract
 * and for why every caller shares one flow.
 */
export function useCloudLink(): UseCloudLink {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const summary = useCloudStatus();

  const { data: flow } = useQuery<LinkFlowEntry>({
    queryKey: cloudLinkFlowKey,
    // Never fetched: the entry is written by `start`/`cancel`/`unlink` alone.
    queryFn: () => queryClient.getQueryData<LinkFlowEntry>(cloudLinkFlowKey) ?? NO_FLOW,
    initialData: NO_FLOW,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const setFlow = useCallback(
    (patch: Partial<LinkFlowEntry> | null) =>
      queryClient.setQueryData<LinkFlowEntry>(cloudLinkFlowKey, (prev) =>
        patch === null ? NO_FLOW : { ...(prev ?? NO_FLOW), ...patch }
      ),
    [queryClient]
  );

  const [unlinking, setUnlinking] = useState(false);

  // The landing, read off the poll itself rather than an effect, so it runs
  // once per answer however many surfaces subscribe. It is not awaited by the
  // poll: the refreshes it starts are reads of their own, and the flow state
  // must reach every reader without waiting on them.
  const readStatus = useCallback(async (): Promise<CloudLinkStatus | null> => {
    const before = queryClient.getQueryData<CloudLinkStatus | null>(cloudLinkStatusKey);
    const next = await transport.getCloudLinkStatus();
    if (before?.state === 'pending' && next.state === 'linked') {
      const current = queryClient.getQueryData<LinkFlowEntry>(cloudLinkFlowKey) ?? NO_FLOW;
      queryClient.setQueryData<LinkFlowEntry>(cloudLinkFlowKey, { ...current, afterLink: null });
      void land(queryClient, next.relinkOutcome ? null : current.afterLink);
    }
    return next;
  }, [transport, queryClient]);

  const status = useQuery<CloudLinkStatus | null>({
    queryKey: cloudLinkStatusKey,
    queryFn: readStatus,
    retry: false,
    // Poll only while a code is showing; every terminal state stops it.
    // Read from the cache, not this render's closure: the codes and the
    // `pending` land in two writes, and the timer is set from whichever is last.
    refetchInterval: (query) =>
      query.state.data?.state === 'pending' &&
      queryClient.getQueryData<LinkFlowEntry>(cloudLinkFlowKey)?.codes
        ? POLL_INTERVAL_MS
        : false,
    refetchIntervalInBackground: true,
  });
  const linkStatus = status.data ?? null;

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
    if (before !== true || linkedNow !== false) return;
    const inFlight = queryClient.getQueryData<LinkFlowEntry>(cloudLinkFlowKey) ?? NO_FLOW;
    if (inFlight.codes || inFlight.starting) return;
    transport
      .getCloudLinkStatus()
      .then((s) => queryClient.setQueryData(cloudLinkStatusKey, s))
      // The summary still drives the view once the flow state is cleared.
      .catch(() => queryClient.setQueryData(cloudLinkStatusKey, null));
  }, [linkedNow, transport, queryClient]);

  const start = useCallback(
    async (options: StartCloudLinkOptions = {}) => {
      setFlow({ starting: true, startError: null });
      // A mount-time read still in flight must not land over the `pending`
      // this start is about to write.
      await queryClient.cancelQueries({ queryKey: cloudLinkStatusKey });
      try {
        const codes = await transport.startCloudLink();
        setFlow({
          codes,
          origin: options.origin ?? null,
          afterLink: options.afterLink ?? null,
          starting: false,
        });
        queryClient.setQueryData(cloudLinkStatusKey, PENDING);
      } catch (err) {
        setFlow({ starting: false, startError: cloudErrorMessage(err) });
      }
    },
    [transport, queryClient, setFlow]
  );

  const restart = useCallback(() => {
    const previous = queryClient.getQueryData<LinkFlowEntry>(cloudLinkFlowKey) ?? NO_FLOW;
    return start({
      ...(previous.origin !== null ? { origin: previous.origin } : {}),
      ...(previous.afterLink !== null ? { afterLink: previous.afterLink } : {}),
    });
  }, [queryClient, start]);

  const cancel = useCallback(async () => {
    setFlow(null);
    await queryClient.cancelQueries({ queryKey: cloudLinkStatusKey });
    try {
      queryClient.setQueryData(cloudLinkStatusKey, await transport.cancelCloudLink());
    } catch {
      // The server keeps its own state; the next status read reconciles it.
      queryClient.setQueryData(cloudLinkStatusKey, null);
    }
    await queryClient.invalidateQueries({ queryKey: cloudStatusKey });
  }, [transport, queryClient, setFlow]);

  const unlink = useCallback(async () => {
    setUnlinking(true);
    try {
      await transport.unlinkCloud();
      setFlow(null);
      await queryClient.cancelQueries({ queryKey: cloudLinkStatusKey });
      queryClient.setQueryData(cloudLinkStatusKey, IDLE);
      // Optimistically settle the summary so the panel returns to idle at once;
      // the invalidation then reconciles with the server.
      queryClient.setQueryData<CloudLinkSummary>(cloudStatusKey, {
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cloudStatusKey }),
        queryClient.invalidateQueries({ queryKey: cloudCreditsKeys.status() }),
        invalidateAccountReads(queryClient),
      ]);
    } catch {
      // Unlink failed (e.g. the local server call errored): the instance was not
      // unlinked, so leave the panel in the linked view and let the user retry.
      // Caught so a rejected transport call never becomes an unhandled rejection.
    } finally {
      setUnlinking(false);
    }
  }, [transport, queryClient, setFlow]);

  const view = useMemo<CloudLinkView>(() => {
    const flowState = linkStatus?.state;

    // An active device flow (codes in hand) shows the pending view.
    if (flow.codes && flowState === 'pending') {
      return {
        kind: 'pending',
        userCode: flow.codes.userCode,
        verificationUri: flow.codes.verificationUri,
        expiresAt: flow.codes.expiresAt,
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
  }, [flow.codes, linkStatus, summary.data, summary.isLoading]);

  return {
    view,
    start,
    restart,
    unlink,
    cancel,
    starting: flow.starting,
    unlinking,
    startError: flow.startError,
    origin: flow.origin,
  };
}
