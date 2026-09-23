/**
 * The last two steps of starting or moving a community: become its owner in
 * the browser, then connect this DorkOS to it with the ordinary pairing flow.
 *
 * **The claim link is never kept.** It is a one-time credential. It is fetched
 * only when the person presses the button that opens it, and goes straight
 * into a window opened in that press ({@link openExternalWindowLater}; on the
 * desktop app, the shell's own http(s)-only `openExternal`), then is dropped.
 * It never enters React state, the query cache, or a log.
 *
 * @module features/community-hosting/model/use-claim-and-connect
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Problem } from '@dork-labs/cloud-api';
import type { CloudCommunityRefusal } from '@dorkos/shared/cloud-schemas';
import {
  isCommunityAuthorityCurrent,
  openExternalLink,
  openExternalWindowLater,
} from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  useConfirmedCommunityAuthority,
  withinCommunityAuthority,
} from '@/layers/entities/community';
import { hostedCommunityKeys } from './hosted-communities';

/** Something to tell the person: the service's own problem, or one sentence of ours. */
export type HostingNotice = { problem: Problem } | { message: string };

/**
 * The notice a refusal carries.
 *
 * @param refusal - A route's refusal.
 */
export function noticeOf(refusal: CloudCommunityRefusal): HostingNotice {
  return 'problem' in refusal ? { problem: refusal.problem } : { message: refusal.message };
}

/** What the app says when it could not reach this DorkOS or the account. */
export const UNREACHABLE_NOTICE: HostingNotice = {
  message: 'Couldn’t reach your DorkOS account. Try again.',
};

/** The community being claimed and connected. */
export interface ClaimTarget {
  communityId: string;
  name: string;
  communityUrl: string;
}

/** Where the claim-and-connect steps are. */
export type ClaimConnectState =
  | { kind: 'preparing' }
  | { kind: 'claim'; opened: boolean; busy: boolean; notice: HostingNotice | null }
  | {
      kind: 'connecting';
      approvalUrl: string | null;
      busy: boolean;
      notice: HostingNotice | null;
    }
  | { kind: 'done'; ref: string };

/** Everything the claim-and-connect view needs. */
export interface ClaimAndConnect {
  state: ClaimConnectState;
  /** Fetch the claim link and open it in the browser. */
  openClaim: () => void;
  /** The person says they finished in the browser; check, then connect. */
  confirmClaimed: () => void;
  /** Open the pairing approval page again. */
  openApproval: () => void;
  /** Start connecting again after an approval expired or was cancelled. */
  retryConnect: () => void;
}

const NOT_CLAIMED_YET: HostingNotice = {
  message: 'Your sign-in isn’t finished yet. Finish it in your browser, then try again.',
};
const POPUP_BLOCKED: HostingNotice = {
  message: 'Your browser blocked the new window. Allow pop-ups for DorkOS, then try again.',
};
const CONNECT_FAILED: HostingNotice = {
  message: 'Couldn’t connect this DorkOS to the community. Try again.',
};
const APPROVAL_ENDED: HostingNotice = {
  message: 'The approval ended before it finished. Connect again to continue.',
};

/**
 * Drive claim, then connect, for one community.
 *
 * @param target - The community, or `null` while there is none yet.
 * @param installName - What the community will call this DorkOS.
 * @param onConnected - Runs once the connection is approved, with its local ref.
 */
export function useClaimAndConnect(
  target: ClaimTarget | null,
  installName: string,
  onConnected: (ref: string) => void
): ClaimAndConnect {
  const transport = useTransport();
  const client = useQueryClient();
  const authority = useConfirmedCommunityAuthority(target !== null);
  const [claim, setClaim] = useState<{
    opened: boolean;
    busy: boolean;
    notice: HostingNotice | null;
  }>({
    opened: false,
    busy: false,
    notice: null,
  });
  const [connect, setConnect] = useState<{
    ref: string | null;
    approvalUrl: string | null;
    busy: boolean;
    notice: HostingNotice | null;
  } | null>(null);
  const announced = useRef<string | null>(null);

  // A community the service is still setting up has no claim link yet. Watch
  // the list until it is waiting for its owner.
  const list = useQuery({
    queryKey: hostedCommunityKeys.list(),
    queryFn: () => transport.listHostedCommunities(),
    enabled: target !== null && connect === null,
    refetchInterval: (query) => {
      const data = query.state.data;
      const community =
        data?.available === true
          ? data.communities.find((c) => c.communityId === target?.communityId)
          : undefined;
      return community?.state === 'provisioning' ? 2_000 : false;
    },
  });
  const listed =
    list.data?.available === true
      ? list.data.communities.find((c) => c.communityId === target?.communityId)
      : undefined;
  const preparing = listed?.state === 'provisioning';

  const openClaim = useCallback(() => {
    if (!target || claim.busy) return;
    // The window opens now, inside the press: after the round trip below a
    // browser (Safari above all) would count it as a pop-up and block it.
    const pending = openExternalWindowLater();
    if (pending === null) {
      setClaim((c) => ({ ...c, notice: POPUP_BLOCKED }));
      return;
    }
    setClaim((c) => ({ ...c, busy: true, notice: null }));
    transport
      .getHostedCommunityClaimLink(target.communityId)
      .then((answer) => {
        if (!answer.ok) {
          pending.close();
          setClaim((c) => ({ ...c, busy: false, notice: noticeOf(answer) }));
          return;
        }
        // Straight into the waiting window and dropped: never stored anywhere.
        const opened = pending.go(answer.claimUrl);
        setClaim((c) => ({ opened: c.opened || opened, busy: false, notice: null }));
      })
      .catch(() => {
        pending.close();
        setClaim((c) => ({ ...c, busy: false, notice: UNREACHABLE_NOTICE }));
      });
  }, [target, claim.busy, transport]);

  const startConnect = useCallback(async () => {
    if (!target) return;
    if (!authority || !isCommunityAuthorityCurrent(authority)) {
      setConnect({ ref: null, approvalUrl: null, busy: false, notice: CONNECT_FAILED });
      return;
    }
    setConnect({ ref: null, approvalUrl: null, busy: true, notice: null });
    try {
      const started = await transport.startCommunityConnection({
        url: target.communityUrl,
        installName,
      });
      setConnect({
        ref: started.connection.ref,
        approvalUrl: started.approvalUrl,
        busy: false,
        notice: null,
      });
      await client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
    } catch {
      setConnect({ ref: null, approvalUrl: null, busy: false, notice: CONNECT_FAILED });
    }
  }, [target, authority, transport, installName, client]);

  const confirmClaimed = useCallback(() => {
    if (!target || claim.busy) return;
    setClaim((c) => ({ ...c, busy: true, notice: null }));
    transport
      .listHostedCommunities()
      .then((answer) => {
        client.setQueryData(hostedCommunityKeys.list(), answer);
        const community =
          answer.available === true
            ? answer.communities.find((c) => c.communityId === target.communityId)
            : undefined;
        if (
          !community ||
          community.state === 'pending_owner' ||
          community.state === 'provisioning'
        ) {
          setClaim((c) => ({ ...c, busy: false, notice: NOT_CLAIMED_YET }));
          return;
        }
        setClaim((c) => ({ ...c, busy: false }));
        void startConnect();
      })
      .catch(() => setClaim((c) => ({ ...c, busy: false, notice: UNREACHABLE_NOTICE })));
  }, [target, claim.busy, transport, client, startConnect]);

  const ref = connect?.ref ?? null;
  const poll = useQuery({
    queryKey: authority && ref ? communityKeys.approval(authority, ref) : ['cloud', 'no-approval'],
    queryFn: () =>
      withinCommunityAuthority(authority!, () => transport.pollCommunityConnection(ref!)),
    enabled: authority !== null && ref !== null,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error && (!query.state.data || query.state.data.status === 'pending')
        ? 2_000
        : false,
  });
  const outcome = ref !== null ? (poll.data?.status ?? 'pending') : 'pending';
  const doneRef = outcome === 'connected' ? ref : null;
  useEffect(() => {
    if (doneRef === null || announced.current === doneRef) return;
    announced.current = doneRef;
    if (authority)
      void client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
    void client.invalidateQueries({ queryKey: hostedCommunityKeys.all });
    onConnected(doneRef);
  }, [doneRef, authority, client, onConnected]);
  const approvalEnded = outcome === 'expired' || outcome === 'cancelled';

  const state: ClaimConnectState =
    doneRef !== null
      ? { kind: 'done', ref: doneRef }
      : connect !== null
        ? {
            kind: 'connecting',
            approvalUrl: connect.approvalUrl,
            busy: connect.busy,
            notice:
              connect.notice ??
              (approvalEnded ? APPROVAL_ENDED : poll.error ? CONNECT_FAILED : null),
          }
        : preparing
          ? { kind: 'preparing' }
          : { kind: 'claim', ...claim };

  return {
    state,
    openClaim,
    confirmClaimed,
    openApproval: () => {
      if (connect?.approvalUrl) openExternalLink(connect.approvalUrl);
    },
    retryConnect: () => void startConnect(),
  };
}
