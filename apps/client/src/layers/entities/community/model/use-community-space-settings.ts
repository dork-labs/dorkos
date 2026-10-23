/**
 * A connected space's settings, the person's own membership, who is in it and its rules, for the
 * space's Settings tab (DOR-3005). Read-only, through the local server, which reads the space with
 * the connection's own grant and keeps its last answers for when the space is unreachable.
 *
 * @module entities/community/model/use-community-space-settings
 */
import { useQuery } from '@tanstack/react-query';
import type {
  CommunitySpaceRead,
  CommunitySpaceReadResult,
} from '@dorkos/shared/community-space-settings';
import { useTransport } from '@/layers/shared/model';
import { communityKeys, withinCommunityAuthority } from './use-community-connections';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/** How long a read counts as fresh: the tab is read often, and a space changes slowly. */
const SPACE_READ_STALE_MS = 30_000;

/**
 * One of a space's four settings reads, under the owner's confirmed authority.
 *
 * @param ref - The space's connection ref.
 * @param read - Which read.
 * @param enabled - Read only while the Settings tab is open.
 */
export function useCommunitySpaceRead<Read extends CommunitySpaceRead>(
  ref: string,
  read: Read,
  enabled = true
) {
  const transport = useTransport();
  const authority = useConfirmedCommunityAuthority(enabled);
  return useQuery<CommunitySpaceReadResult<Read>, Error & { code?: string; status?: number }>({
    queryKey: authority
      ? [...communityKeys.remote(authority, ref), 'space', read]
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'space', read],
    queryFn: () =>
      withinCommunityAuthority(authority!, () => transport.readCommunitySpace(ref, read)),
    enabled: enabled && authority !== null,
    staleTime: SPACE_READ_STALE_MS,
    // A refusal is an answer, not a blip, and an unreachable space already returned its last
    // answer: retrying either only delays what the tab has to say.
    retry: false,
  });
}

/**
 * All four reads a space's Settings tab shows, and one way to ask them all again.
 *
 * @param ref - The space's connection ref.
 * @param enabled - Read only while the Settings tab is open.
 */
export function useCommunitySpaceSettings(ref: string, enabled = true) {
  const settings = useCommunitySpaceRead(ref, 'settings', enabled);
  const me = useCommunitySpaceRead(ref, 'me', enabled);
  const members = useCommunitySpaceRead(ref, 'members', enabled);
  const rules = useCommunitySpaceRead(ref, 'rules', enabled);
  return {
    settings,
    me,
    members,
    rules,
    /** Whether any read is being asked again right now. */
    refetching: [settings, me, members, rules].some((query) => query.isFetching),
    /** Ask the space for all four again. */
    refetch: () => {
      void settings.refetch();
      void me.refetch();
      void members.refetch();
      void rules.refetch();
    },
  };
}
