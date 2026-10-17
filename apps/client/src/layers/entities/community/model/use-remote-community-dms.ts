import { useQuery } from '@tanstack/react-query';
import type { RemoteCommunityDm } from '@dorkos/shared/community-dm-views';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  useCommunityContentAuthority,
  withinCommunityContentAuthority,
} from './use-community-connections';

/** How often the list of direct messages is read again, so a new one shows without a reload. */
const DMS_REFRESH_MS = 30_000;
/** How often the owner's read-only copy of a direct message with their agent is read again. */
const AGENT_DM_REFRESH_MS = 10_000;

/**
 * Whether a space holds direct messages with agents, and the ones this install can open: its
 * person's own, and someone's with one of the owner's agents, read-only (DOR-2955). A space
 * without them answers `available: false`, which hides every control.
 *
 * @param ref - The space's connection ref.
 * @param enabled - Read only while the space may be read.
 * @param accessFingerprint - The connection's current access, so a change reads afresh.
 */
export function useRemoteCommunityDms(ref: string, enabled = true, accessFingerprint = 'legacy') {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.dms(authority, ref)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'dms'],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () => transport.listRemoteCommunityDms(ref)),
    enabled: enabled && authority !== null,
    refetchInterval: DMS_REFRESH_MS,
  });
}

/**
 * The owner's read-only copy of someone's direct message with one of their agents, read through
 * that agent (DOR-2955). It has no live stream of its own, so it is read again on an interval.
 *
 * @param ref - The space's connection ref.
 * @param roomId - The direct message's channel id.
 * @param localAgentId - The owner's enrolled agent in it.
 * @param accessFingerprint - The connection's current access, so a change reads afresh.
 */
export function useRemoteCommunityAgentDmEntries(
  ref: string,
  roomId: string,
  localAgentId: string,
  accessFingerprint = 'legacy'
) {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(true, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.agentDmEntries(authority, ref, roomId, localAgentId)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'room', roomId, 'as-agent'],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () =>
        transport.listRemoteCommunityAgentDmEntries(ref, roomId, localAgentId)
      ),
    enabled: authority !== null,
    refetchInterval: AGENT_DM_REFRESH_MS,
  });
}

/**
 * What a direct message is called where its name is shown: the agent, for the person's own; who
 * is talking with which agent, for an owner's read-only copy.
 *
 * @param dm - The direct message.
 */
export function remoteDmTitle(dm: RemoteCommunityDm): string {
  return dm.readOnly
    ? `${dm.member.displayName} with ${dm.agent.displayName}`
    : dm.agent.displayName;
}

/**
 * The direct message a space room id names, if it names one. `pending` while the list is still
 * on its way, so a caller can wait rather than open a direct message as an ordinary channel.
 *
 * @param ref - The space's connection ref.
 * @param roomId - The room id the address names.
 * @param enabled - Read only while the space may be read.
 * @param accessFingerprint - The connection's current access.
 */
export function useRemoteCommunityDm(
  ref: string,
  roomId: string,
  enabled = true,
  accessFingerprint = 'legacy'
): { dm: RemoteCommunityDm | undefined; pending: boolean } {
  const dms = useRemoteCommunityDms(ref, enabled, accessFingerprint);
  return {
    dm: dms.data?.dms.find((item) => item.roomId === roomId),
    pending: enabled && dms.isPending && dms.fetchStatus === 'fetching',
  };
}
