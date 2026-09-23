/**
 * Keep and reopen: the two ways out of a hold the owner can take from the app.
 *
 * The service decides which is allowed (`actions.keep.allowed`,
 * `actions.restore`) and what keeping would hold (`actions.keep.wouldHold`);
 * the app only shows those and sends back exactly the preview the person
 * confirmed.
 *
 * @module features/community-hosting/model/use-hosted-community-actions
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HostedCommunity } from '@dork-labs/cloud-api';
import { useTransport } from '@/layers/shared/model';
import { hostedCommunityKeys } from './hosted-communities';
import { noticeOf, UNREACHABLE_NOTICE, type HostingNotice } from './use-claim-and-connect';

/** What the person is being asked to confirm, and what came of the last action. */
export interface HostedCommunityActions {
  /** The community whose keep is waiting for a confirmation. */
  confirmingKeep: string | null;
  /** The community an action is running for. */
  busyId: string | null;
  /** What the last action said, by community. */
  notices: Record<string, HostingNotice>;
  askKeep: (communityId: string) => void;
  cancelKeep: () => void;
  keep: (community: HostedCommunity) => Promise<void>;
  restore: (community: HostedCommunity) => Promise<void>;
}

/** The preview changed under the person: say so and show the fresh list. */
const PREVIEW_CHANGED: HostingNotice = {
  message: 'Your communities changed since this list loaded. Check the list again, then choose.',
};

/** Drive keep and reopen for the hosted-community list. */
export function useHostedCommunityActions(): HostedCommunityActions {
  const transport = useTransport();
  const client = useQueryClient();
  const [confirmingKeep, setConfirmingKeep] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, HostingNotice>>({});

  function note(communityId: string, notice: HostingNotice | null) {
    setNotices((all) => {
      const next = { ...all };
      if (notice) next[communityId] = notice;
      else delete next[communityId];
      return next;
    });
  }

  async function run(communityId: string, action: () => Promise<HostingNotice | null>) {
    setBusyId(communityId);
    note(communityId, null);
    try {
      note(communityId, await action());
    } catch {
      note(communityId, UNREACHABLE_NOTICE);
    } finally {
      setBusyId(null);
      await client.invalidateQueries({ queryKey: hostedCommunityKeys.list() });
    }
  }

  return {
    confirmingKeep,
    busyId,
    notices,
    askKeep: setConfirmingKeep,
    cancelKeep: () => setConfirmingKeep(null),
    keep: (community) =>
      run(community.communityId, async () => {
        setConfirmingKeep(null);
        const answer = await transport.keepHostedCommunity(
          community.communityId,
          community.actions.keep.wouldHold
        );
        if (answer.ok) return null;
        if ('problem' in answer && answer.problem.code === 'conflict') return PREVIEW_CHANGED;
        return noticeOf(answer);
      }),
    restore: (community) =>
      run(community.communityId, async () => {
        const answer = await transport.restoreHostedCommunity(community.communityId);
        return answer.ok ? null : noticeOf(answer);
      }),
  };
}
