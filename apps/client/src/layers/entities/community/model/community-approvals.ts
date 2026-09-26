/**
 * Waiting for a Community to approve this installation.
 *
 * One app-level watcher ({@link useCommunityApprovalWatcher}) checks every
 * pending connection and reports how each wait ended. Connect dialogs only
 * read: the check's state ({@link useCommunityApprovalCheck}) and the small
 * shared store ({@link useCommunityApprovalStore}) that says which wait is on
 * screen, holds the approval links a start handed out, and hands an on-screen
 * ending to its dialog instead of a toast.
 *
 * @module entities/community/model/community-approvals
 */
import { useEffect, useRef } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { create } from 'zustand';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionPollResponse,
} from '@dorkos/shared/community-connections';
import type { Transport } from '@dorkos/shared/transport';
import type { ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  useCommunityConnections,
  withinCommunityAuthority,
} from './use-community-connections';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/** How a wait for approval ended. */
export type CommunityApprovalOutcome = Exclude<
  CommunityConnectionPollResponse['status'],
  'pending'
>;

/** One ending of an on-screen wait, numbered so a dialog handles it once. */
export interface CommunityApprovalEnding {
  id: number;
  ref: string;
  label: string;
  outcome: CommunityApprovalOutcome;
}

/** Approval links handed out by starts, for the one owner they belong to. */
interface OwnedApprovalLinks {
  address: string;
  urls: Readonly<Record<string, string>>;
}

interface CommunityApprovalState {
  /** The pending ref a connect dialog is showing now, if any. */
  onScreen: string | null;
  /** The latest ending of the wait that was on screen when it ended. */
  ending: CommunityApprovalEnding | null;
  links: OwnedApprovalLinks | null;
  show: (ref: string) => void;
  hide: (ref: string) => void;
  end: (ending: Omit<CommunityApprovalEnding, 'id'>) => void;
  rememberLink: (address: string, ref: string, url: string) => void;
  /** Drop everything held for any owner but this one (`''`: for every owner). */
  forget: (address: string) => void;
}

/** Ending ids only ever grow, so a dialog never mistakes a new ending for one it handled. */
let lastEndingId = 0;

/** The shared approval store; see the module comment. */
export const useCommunityApprovalStore = create<CommunityApprovalState>()((set) => ({
  onScreen: null,
  ending: null,
  links: null,
  show: (ref) => set({ onScreen: ref }),
  hide: (ref) => set((state) => (state.onScreen === ref ? { onScreen: null } : state)),
  end: (ending) => set({ ending: { ...ending, id: ++lastEndingId } }),
  rememberLink: (address, ref, url) =>
    set((state) => ({
      links: {
        address,
        urls: { ...(state.links?.address === address ? state.links.urls : {}), [ref]: url },
      },
    })),
  forget: (address) =>
    set((state) =>
      state.links === null || state.links.address === address
        ? { ending: null }
        : { links: null, ending: null }
    ),
}));

/**
 * The key a value is scoped to: one owner in one authority epoch. Anything
 * stored under another address belongs to an owner who is no longer here.
 *
 * @param authority - The confirmed owner, or `null` while none is.
 */
export function communityOwnerAddress(authority: ConfirmedCommunityAuthority | null): string {
  return authority ? JSON.stringify([authority.ownerKey, authority.epoch]) : '';
}

/**
 * Whether a check failed only because another check of the same connection
 * was in flight. Every open window checks, so this is routine, not a failure.
 */
function isPairingBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 409 &&
    (error as { code?: unknown }).code === 'PAIRING_BUSY'
  );
}

function approvalQuery(
  transport: Transport,
  authority: ConfirmedCommunityAuthority,
  connection: CommunityConnectionDescriptor
) {
  return {
    queryKey: communityKeys.approval(authority, connection.ref),
    queryFn: () =>
      withinCommunityAuthority(authority, async (): Promise<CommunityConnectionPollResponse> => {
        try {
          return await transport.pollCommunityConnection(connection.ref);
        } catch (error) {
          if (isPairingBusy(error)) return { status: 'pending', connection };
          throw error;
        }
      }),
    retry: false,
  } as const;
}

/**
 * Check every pending connection every two seconds, from one place in the app.
 *
 * **The checking is what finishes a pairing.** The local server claims the
 * Community's grant only when a check reaches it, so a wait nobody checks stays
 * pending however long ago the person approved it. Mounted once in the app
 * shell, it keeps running whether or not a connect dialog is open or a sidebar
 * is drawn. A check that fails stops until the person asks again; a check that
 * lost a race with another window's is treated as still waiting.
 *
 * Each ending is reported once: to the connect dialog showing that wait, or
 * otherwise as a toast. The connection list is then refreshed.
 */
export function useCommunityApprovalWatcher(): void {
  const transport = useTransport();
  const client = useQueryClient();
  const authority = useConfirmedCommunityAuthority();
  const list = useCommunityConnections();
  // A new owner, a new authority epoch, or signing out: the old owner's
  // approval links and last ending are dropped, not just hidden.
  const address = communityOwnerAddress(authority);
  useEffect(() => {
    useCommunityApprovalStore.getState().forget(address);
  }, [address]);
  const pending = authority
    ? (list.data ?? []).filter((connection) => connection.status === 'pending')
    : [];
  const checks = useQueries({
    queries: pending.map((connection) => ({
      ...approvalQuery(transport, authority!, connection),
      refetchInterval: (query: {
        state: { error: unknown; data: CommunityConnectionPollResponse | undefined };
      }) =>
        !query.state.error && (!query.state.data || query.state.data.status === 'pending')
          ? 2_000
          : false,
    })),
  });

  // Keyed by the answer that carried each ending: the effect below re-runs
  // whenever ANY wait ends, while earlier endings are still in the list.
  const reported = useRef(new Set<string>());
  const endings = pending.flatMap((connection, index) => {
    const check = checks[index];
    const status = check?.data?.status;
    return status && status !== 'pending'
      ? [{ connection, outcome: status, key: `${connection.ref}:${check.dataUpdatedAt}` }]
      : [];
  });
  const endingKey = endings.map((ending) => ending.key).join('|');
  useEffect(() => {
    if (!authority) return;
    for (const { connection, outcome, key } of endings) {
      if (reported.current.has(key)) continue;
      reported.current.add(key);
      report(connection, outcome);
      void client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
    }
    // `endingKey` stands for `endings`, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endingKey, authority, client]);
}

function report(connection: CommunityConnectionDescriptor, outcome: CommunityApprovalOutcome) {
  const store = useCommunityApprovalStore.getState();
  if (store.onScreen === connection.ref) {
    store.end({ ref: connection.ref, label: connection.label, outcome });
    return;
  }
  const id = `community-approval-${connection.ref}`;
  if (outcome === 'connected') toast.success(`${connection.label} is connected.`, { id });
  else
    toast.warning(
      outcome === 'expired'
        ? `Approval for ${connection.label} expired. Connect again to continue.`
        : `Approval for ${connection.label} was cancelled.`,
      { id }
    );
}

/** What a connect dialog can see of one wait's check. */
export interface CommunityApprovalCheck {
  error: unknown;
  isFetching: boolean;
  /** Check again now, after a failed check. */
  retry: () => void;
}

/**
 * Read one pending connection's check, which {@link useCommunityApprovalWatcher}
 * runs. Reading never starts a check of its own; `retry` asks for one.
 *
 * @param connection - The pending connection on screen, or `null`.
 */
export function useCommunityApprovalCheck(
  connection: CommunityConnectionDescriptor | null
): CommunityApprovalCheck {
  const transport = useTransport();
  const authority = useConfirmedCommunityAuthority();
  const query = useQuery<CommunityConnectionPollResponse>({
    queryKey:
      authority && connection
        ? communityKeys.approval(authority, connection.ref)
        : [...communityKeys.all, 'approval', 'none'],
    queryFn:
      authority && connection
        ? approvalQuery(transport, authority, connection).queryFn
        : () => Promise.reject(new Error('Nothing is waiting for approval.')),
    retry: false,
    enabled: false,
  });
  return {
    error: query.error,
    isFetching: query.isFetching,
    retry: () => void query.refetch(),
  };
}

/**
 * Tell the watcher which wait this dialog is showing, while it shows it, so
 * that wait's ending comes here instead of as a toast.
 *
 * @param ref - The pending ref on screen, or `null`.
 */
export function useShowCommunityApproval(ref: string | null): void {
  useEffect(() => {
    if (ref === null) return;
    const { show, hide } = useCommunityApprovalStore.getState();
    show(ref);
    return () => hide(ref);
  }, [ref]);
}
